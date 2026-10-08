#!/usr/bin/env node
// Connector: makes an agent reachable on the network. Run it in the repo it should answer about:
//   cd ~/code/payments && backchannel connect          (@<you>-claude, Claude Code, read-only, asks you first)
//   backchannel connect --id steve --backend codex --cwd ~/code/payments --write --no-approve
import { parseArgs } from 'node:util';
import readline from 'node:readline/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { hubFromEnv, loadConfig, describeWorkspace, machineInfo } from './client.js';
import { backends } from './backends.js';
import { answer } from './responder.js';

const { values: opt } = parseArgs({
  allowNegative: true,
  options: {
    id: { type: 'string' },
    backend: { type: 'string' },
    name: { type: 'string' },
    owner: { type: 'string' },
    about: { type: 'string', default: '' },
    model: { type: 'string' },
    cwd: { type: 'string', default: process.cwd() },
    write: { type: 'boolean', default: false },  // let claude-code/codex edit files
    approve: { type: 'boolean', default: true }, // owner confirms each request in this terminal (--no-approve to skip)
    'i-trust-this-team': { type: 'boolean', default: false }, // required for --write --no-approve
    hub: { type: 'string' },
    team: { type: 'string', default: process.env.HUB_TEAM },
    help: { type: 'boolean', short: 'h' },
  },
});
const USAGE = `usage: backchannel connect [--backend claude-code|codex|openai|grok|echo] [--cwd dir] [--id handle] [--write] [--no-approve]
  Defaults: Claude Code (or Codex if that's what's installed), the current folder, @<you>-claude, read-only,
  and it asks you in this terminal before handling each request.
  --write with --no-approve also needs --i-trust-this-team: anyone in the team could then run commands on this computer.`;
const die = (msg) => { console.error(msg); process.exit(1); };
if (opt.help) { console.log(USAGE); process.exit(0); }

const onPath = (cmd) => spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd]).status === 0;
const backend = opt.backend || (onPath('claude') ? 'claude-code' : onPath('codex') ? 'codex' : null);
if (!backend) die(`Neither claude nor codex is on your PATH. Install one, or pick a backend with --backend.\n${USAGE}`);
if (!backends[backend]) die(`unknown backend "${backend}". Options: ${Object.keys(backends).join(', ')}`);
const isCoder = backend === 'claude-code' || backend === 'codex';
if (isCoder && opt.write && !opt.approve && !opt['i-trust-this-team']) {
  die(`--write --no-approve lets anyone in your team run commands and change files on this computer without asking you.
If that's really what you want, add --i-trust-this-team. Otherwise drop --no-approve, and you'll approve each request here.`);
}
if (opt.approve && !process.stdin.isTTY) die('--approve asks in this terminal, but there is none. Run it in a terminal, or add --no-approve to handle requests without asking.');

const cwd = path.resolve(opt.cwd.replace(/^~/, process.env.HOME));
// Built from the owner's name, which may only be known once we've reached the hub, and the repos found in the folder.
let workspace = null;
const where = () => (workspace?.repos.length > 1 ? `${workspace.repos.length} repos in ${path.basename(cwd)}`
  : `the ${workspace?.repos[0]?.name || path.basename(cwd)} repo`);
// Codex's read-only sandbox can read any file this computer's user can, not just the repo; say so.
const codexReadsAll = backend === 'codex' && !opt.write;
const describe = (owner) => opt.about || (isCoder
  ? `${owner ? owner + "'s" : 'A'} ${backend} agent with ${opt.write ? 'read/write' : 'read-only'} access to ${where()}.${codexReadsAll ? ' Codex can also read files elsewhere on its computer.' : ''}`
  : `${owner ? owner + "'s" : 'An'} ${backend} assistant.`);
let description = describe(opt.owner);
const hub = hubFromEnv({ url: opt.hub, team: opt.team });
// Set once we know who you are: --id, or your handle plus the backend (maya-claude, maya-codex).
let id = opt.id?.toLowerCase();
const card = { id, name: opt.name || id, backend, model: opt.model, owner: opt.owner, description,
  access: isCoder && opt.write ? 'write' : 'read', repo: isCoder ? path.basename(cwd) : null, approve: opt.approve, ...machineInfo() };
const rl = opt.approve ? readline.createInterface({ input: process.stdin, output: process.stdout }) : null;
// What the responder needs to know about this agent; the owner and description are filled in once we reach the hub.
const self = { get id() { return id; }, get owner() { return card.owner; }, get description() { return description; },
  backend, cwd, write: opt.write, model: opt.model, approved: opt.approve };

async function approve(msg) {
  if (!rl) return true;
  await hub.status(id, 'approval', msg.threadId).catch(() => {});
  console.log(`\n── request from @${msg.from} ──\n${msg.text}${msg.files?.length ? `\n(attached: ${msg.files.map((f) => f.name).join(', ')})` : ''}\n`);
  const a = (await rl.question(`Let @${id} handle this? [y/N] `)).trim().toLowerCase();
  return a === 'y' || a === 'yes';
}

async function handle(msg) {
  console.log(`← @${msg.from}: ${msg.text.slice(0, 120)}`);
  if (!(await approve(msg))) {
    await hub.post({ from: id, threadId: msg.threadId, inReplyTo: msg.id, kind: 'declined', text: `${card.owner || 'My owner'} declined this request.` });
    await hub.status(id, 'idle', msg.threadId).catch(() => {});
    return;
  }
  await hub.status(id, 'working', msg.threadId);
  // Long tasks don't poll the inbox, so keep reporting "working"; that also keeps the agent marked online.
  const heartbeat = setInterval(() => hub.status(id, 'working', msg.threadId).catch(() => {}), 15_000);
  try {
    const sent = await answer(hub, self, msg, (s) => console.log(s));
    if (!sent) { console.log('  (no reply)'); return; }
    console.log(`→ ${sent.to.map((t) => '@' + t).join(' ') || '(nobody)'}: ${sent.text.slice(0, 120)}`);
  } catch (err) {
    console.error(`  backend error: ${err.message}`);
    await hub.post({ from: id, threadId: msg.threadId, inReplyTo: msg.id, to: [msg.from], kind: 'error', text: `${backend} error: ${err.message}` }).catch(() => {});
  } finally {
    clearInterval(heartbeat);
    await hub.status(id, 'idle', msg.threadId).catch(() => {});
  }
}

try {
  // Fail fast on bad tokens or teams; if the hub is just down, listen() keeps retrying.
  const me = await hub.resolveTeam().catch((err) => { if (err.status) throw err; return null; });
  if (!id) {
    const saved = loadConfig();
    const handle = me?.user.handle || (saved.hub?.replace(/\/$/, '') === hub.url ? saved.handle : null);
    if (!handle) die(`Can't tell who you are on ${hub.url} yet. Sign this computer in first (Connect page → Create setup command), or pass --id.`);
    const suffix = backend === 'claude-code' ? 'claude' : backend;
    id = `${handle.slice(0, 31 - suffix.length)}-${suffix}`;
    card.id = id; card.name ||= id;
  }
  if (isCoder) Object.assign(card, workspace = await describeWorkspace(cwd));
  if (me && !card.owner) card.owner = me.user.name || me.user.handle;
  card.description = description = describe(card.owner);
  const access = isCoder ? `${opt.write ? 'can edit' : 'read-only'} in ${cwd.replace(process.env.HOME, '~')}, ` : '';
  console.log(`@${id} (${backend}, ${access}${opt.approve ? 'asks you before each request' : 'handles requests without asking'}) connecting to ${hub.url}…`);
  if (codexReadsAll) console.log(`  Note: Codex's read-only mode can read any file you can, not just this folder. Replies are checked for secrets, but keep --approve on.`);
  if (isCoder && opt.write && me) {
    // Say plainly who can make this agent run commands here.
    const people = await hub.req('GET', hub.t('/members')).then((ms) => ms.filter((m) => m.role !== 'viewer' && m.userId !== me.user.id)
      .map((m) => m.name || m.handle)).catch(() => null);
    const who = people === null ? 'Everyone who can post in your team' : people.length ? `${people.length} ${people.length === 1 ? 'person' : 'people'} (${people.slice(0, 8).join(', ')}${people.length > 8 ? ', …' : ''})` : 'Nobody else in your team yet';
    console.log(opt.approve
      ? `  ${who} can ask @${id} to change files and run commands here. You approve each request in this terminal.`
      : `  ⚠ ${who} can make @${id} change files and run commands here WITHOUT asking you (--i-trust-this-team).`);
  }
  await hub.listen(card, handle, (s) => console.log(s));
} catch (err) {
  // 410: someone disconnected this agent from the hub's UI or CLI. That's a deliberate stop, not a failure.
  if (err.status === 410) process.exit(0); // listen() already said who disconnected it
  console.error(`@${id || 'agent'} can't connect: ${err.message}`);
  process.exit(1);
}
