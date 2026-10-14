#!/usr/bin/env node
// Connector: makes an agent reachable on the network. Run it in the repo it should answer about:
//   cd ~/code/payments && backchannel connect          (@<you>-claude, Claude Code, read-only, asks you first)
//   backchannel connect --id steve --backend codex --cwd ~/code/payments --write --no-approve
//   cd ~/code/payments && backchannel connect --service (the same, always on in the background; --stop, --status)
// Coding agents keep one conversation across requests (session.js), so they remember what they already learned.
import { parseArgs } from 'node:util';
import readline from 'node:readline/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { hubFromEnv, loadConfig, describeWorkspace, machineInfo, noteConnector, connectorFile } from './client.js';
import { backends } from './backends.js';
import { answer, systemPrompt, filesDir, view, fromOwnerInPerson } from './responder.js';
import { createSession, sessionFile, resumeHint } from './session.js';
import * as service from './service.js';

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
    persistent: { type: 'boolean', default: true }, // coding agents keep one conversation across requests
    fresh: { type: 'boolean', default: false },     // forget that conversation and start a new one
    service: { type: 'boolean', default: false },   // install as a background service instead of running here
    stop: { type: 'boolean', default: false },      // stop and remove a background service
    status: { type: 'boolean', default: false },    // list background services
    hub: { type: 'string' },
    team: { type: 'string', default: process.env.HUB_TEAM },
    help: { type: 'boolean', short: 'h' },
  },
});
const USAGE = `usage: backchannel connect [--backend claude-code|codex|openai|grok|echo] [--cwd dir] [--id handle] [--write] [--no-approve]
                          [--service | --stop | --status] [--no-persistent] [--fresh]
  Defaults: Claude Code (or Codex if that's what's installed), the current folder, @<you>-claude, read-only,
  and it asks you in this terminal before handling each request.
  --write with --no-approve also needs --i-trust-this-team: anyone in the team could then run commands on this computer.
  Coding agents keep one conversation across requests and pick it up again after a restart. --fresh starts a new
  one; --no-persistent runs each request on its own, as before.
  --service runs the connector in the background instead (launchd on macOS, systemd on Linux): it starts at login,
  restarts if it crashes and handles requests without asking. --status lists background connectors; --stop removes one.`;
const die = (msg) => { console.error(msg); process.exit(1); };
if (opt.help) { console.log(USAGE); process.exit(0); }
const SERVICE = process.env.BACKCHANNEL_SERVICE === '1'; // running as the background service
// A service's output goes to a log file, so each line gets a time.
if (SERVICE) for (const k of ['log', 'error']) { const f = console[k].bind(console); console[k] = (...a) => f(new Date().toISOString(), ...a); }
const tilde = (p) => (p && (p === os.homedir() || p.startsWith(os.homedir() + path.sep)) ? '~' + p.slice(os.homedir().length) : p);
const cwd = path.resolve(opt.cwd.replace(/^~(?=$|\/)/, os.homedir()));
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const lastLines = (file, n) => { try { return fs.readFileSync(file, 'utf8').trimEnd().split('\n').slice(-n); } catch { return []; } };

if (opt.status) {
  const list = service.installed();
  if (!list.length) console.log('No background connectors on this computer. Start one in a repo with: backchannel connect --service');
  for (const s of list) {
    const state = s.running === null ? 'installed' : s.running ? `running${s.pid ? ` (pid ${s.pid})` : ''}` : 'stopped';
    console.log(`@${s.id}  ${state}  ${tilde(s.cwd) || ''}`);
    const saved = readJson(sessionFile(s.id));
    const hint = saved && resumeHint(saved.backend, saved.cwd, saved.conversation);
    if (hint) console.log(`  conversation: ${hint}`);
    const handled = readJson(connectorFile(s.id))?.handled || [];
    if (handled.length) console.log(`  last request: from @${handled.at(-1).from}, ${new Date(handled.at(-1).at).toLocaleString()}${handled.at(-1).error ? ' (failed)' : ''}`);
    console.log(`  logs: ${tilde(s.log)}`);
    if (s.running === false) for (const l of lastLines(s.log, 3)) console.log(`    ${l}`);
  }
  process.exit(0);
}

if (opt.stop) {
  const list = service.installed();
  const want = opt.id?.toLowerCase().replace(/^@/, '');
  const here = list.filter((s) => s.cwd === cwd);
  const target = want ? list.find((s) => s.id === want) : here.length === 1 ? here[0] : list.length === 1 ? list[0] : null;
  if (!list.length) die('No background connectors on this computer.');
  if (!target) die(`${want ? `No background connector @${want}. ` : ''}Background connectors here: ${list.map((s) => `@${s.id} (${tilde(s.cwd)})`).join(', ')}. Pick one with --id.`);
  service.uninstall(target.id);
  console.log(`Stopped @${target.id} and removed its background service. Its conversation is kept for next time (--fresh forgets it).`);
  process.exit(0);
}

const onPath = (cmd) => spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd]).status === 0;
const backend = opt.backend || (onPath('claude') ? 'claude-code' : onPath('codex') ? 'codex' : null);
if (!backend) die(`Neither claude nor codex is on your PATH. Install one, or pick a backend with --backend.\n${USAGE}`);
if (!backends[backend]) die(`unknown backend "${backend}". Options: ${Object.keys(backends).join(', ')}`);
const isCoder = backend === 'claude-code' || backend === 'codex';
if (opt.service) {
  if (!service.supported()) die(`Background connectors run on macOS and Linux. Here, keep \`backchannel connect\` open in a terminal.`);
  if (!isCoder && backend !== 'echo') die(`The ${backend} backend needs an API key, and a background service doesn't store keys. Run it in a terminal instead.`);
  if (process.env.HUB_TOKEN) die(`A background connector signs in with this computer's saved sign-in, not HUB_TOKEN. Unset HUB_TOKEN, and sign in with \`backchannel login\` if you haven't.`);
  opt.approve = false; // nobody is at a terminal to ask
}
if (isCoder && opt.write && !opt.approve && !opt['i-trust-this-team']) {
  die(opt.service
    ? `A background connector can't ask you before each request, so with --write anyone in your team could run commands and change files on this computer.
If that's really what you want, add --i-trust-this-team. Otherwise drop --write (read-only), or run \`backchannel connect --write\` in a terminal to approve each request.`
    : `--write --no-approve lets anyone in your team run commands and change files on this computer without asking you.
If that's really what you want, add --i-trust-this-team. Otherwise drop --no-approve, and you'll approve each request here.`);
}
if (opt.approve && !process.stdin.isTTY) die('--approve asks in this terminal, but there is none. Run it in a terminal, or add --no-approve to handle requests without asking.');

// Built from the owner's name, which may only be known once we've reached the hub, and the repos found in the folder.
let workspace = null;
const where = () => (workspace?.repos.length > 1 ? `${workspace.repos.length} repos in ${path.basename(cwd)}`
  : `the ${workspace?.repos[0]?.name || path.basename(cwd)} repo`);
// Codex's read-only sandbox can read any file this computer's user can, not just the repo; say so.
const codexReadsAll = backend === 'codex' && !opt.write;
const describe = (owner) => opt.about || (isCoder
  ? `${owner ? owner + "'s" : 'A'} ${backend} agent with ${opt.write ? `access to ${where()}. It makes requested changes on a branch of their own, for ${owner || 'its owner'} to review` : `read-only access to ${where()}`}.${codexReadsAll ? ' Codex can also read files elsewhere on its computer.' : ''}`
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
  // The owner's account, known once the hub has answered (resolveTeam); messages are matched to it by `by`.
  get ownerUserId() { return hub.me?.user.id || null; },
  ownerHandle: null, backend, cwd, write: opt.write, model: opt.model, approved: opt.approve, session: null,
  // Threads where this agent asked its owner something (NEEDS_OWNER), kept across restarts.
  waiting: new Map(),
  // Write requests each get a conversation of their own, in their worktree (responder.js). A few stay open.
  sessionFor: null };
const writeSessions = new Map();
function sessionFor(key, { cwd: dir, system }) {
  let s = writeSessions.get(key);
  if (!s) {
    s = createSession(backend, { file: sessionFile(`${id}--${key}`), cwd: dir, model: opt.model, write: true, system, dirs: [filesDir(id)], log: (l) => console.log(l) });
    writeSessions.set(key, s);
    for (const [k, old] of [...writeSessions].slice(0, -4)) { writeSessions.delete(k); old.close().catch(() => {}); }
  } else { writeSessions.delete(key); writeSessions.set(key, s); } // most recently used last
  return s;
}
// What this connector is doing, for the owner's own sessions on this computer (and `--status`).
const note = (entry) => noteConnector(id, { pid: process.pid, cwd, backend, service: SERVICE, conversation: self.session?.conversation || null,
  waiting: [...self.waiting].map(([threadId, w]) => ({ threadId, ...w })) }, entry);
let shownConversation = null;
function showConversation() {
  const c = self.session?.conversation;
  if (!c || c === shownConversation) return;
  shownConversation = c;
  console.log(`  conversation: ${resumeHint(backend, cwd, c)}`);
}

let stopping = false;
async function stop(code) {
  if (stopping) return;
  stopping = true;
  await Promise.all([self.session, ...writeSessions.values()].map((s) => s?.close().catch(() => {})));
  if (id) noteConnector(id, { pid: null });
  process.exit(code);
}
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
rl?.on('SIGINT', () => stop(0));

async function approve(msg) {
  if (!rl || fromOwnerInPerson(self, msg)) return true; // the owner's own messages (answers to NEEDS_OWNER) need no approval
  await hub.status(id, 'approval', msg.threadId).catch(() => {});
  // However long the owner takes to answer, the request stays leased to this connector.
  const heartbeat = setInterval(() => hub.status(id, 'approval', msg.threadId).catch(() => {}), 15_000);
  try {
    console.log(`\n── request from @${msg.from} ──\n${msg.text}${msg.files?.length ? `\n(attached: ${msg.files.map((f) => f.name).join(', ')})` : ''}\n`);
    const a = (await rl.question(`Let @${id} handle this? [y/N] `)).trim().toLowerCase();
    return a === 'y' || a === 'yes';
  } finally { clearInterval(heartbeat); }
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
    showConversation();
    note({ from: msg.from, threadId: msg.threadId, request: msg.text.slice(0, 140), reply: sent ? sent.text.slice(0, 200) : null,
      ...(sent?.needsOwner ? { needsOwner: sent.needsOwner, messageId: sent.id } : {}),
      ...(sent?.change ? { branch: sent.change.branch, repo: sent.change.repo } : {}) });
    if (!sent) { console.log('  (no reply)'); return; }
    console.log(`→ ${sent.to.map((t) => '@' + t).join(' ') || '(nobody)'}: ${sent.text.slice(0, 120)}`);
    if (sent.change) console.log(`  changes on ${sent.change.branch} in ${sent.change.repo} (${sent.change.stat})`);
    if (sent.needsOwner) console.log(`  waiting on you: ${sent.needsOwner}\n  Answer in the thread, or: backchannel reply ${sent.id} "…"`);
  } catch (err) {
    console.error(`  backend error: ${err.message}`);
    note({ from: msg.from, threadId: msg.threadId, request: msg.text.slice(0, 140), reply: null, error: err.message.slice(0, 200) });
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
  self.ownerHandle = me?.user.handle || loadConfig().handle || null;
  for (const w of readJson(connectorFile(id))?.waiting || []) if (w.threadId && w.requestId) self.waiting.set(w.threadId, w);
  card.description = description = describe(card.owner);
  const access = isCoder ? `${opt.write ? 'changes on branches of' : 'read-only in'} ${tilde(cwd)}, ` : '';
  console.log(`@${id} (${backend}, ${access}${opt.approve ? 'asks you before each request' : 'handles requests without asking'}) ${opt.service ? 'installing as a background service' : `connecting to ${hub.url}…`}`);
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
  if (opt.service) {
    // The service runs this same command, minus --service, with everything already decided.
    const args = ['--id', id, '--backend', backend, '--cwd', cwd, '--no-approve', '--hub', hub.url];
    if (hub.team) args.push('--team', hub.team);
    if (opt.write) args.push('--write');
    if (opt['i-trust-this-team']) args.push('--i-trust-this-team');
    if (!opt.persistent) args.push('--no-persistent');
    for (const k of ['name', 'owner', 'about', 'model']) if (opt[k]) args.push(`--${k}`, opt[k]);
    if (opt.fresh) fs.rmSync(sessionFile(id), { force: true }); // once, now: not on every restart
    const { log } = service.install({ id, args, cwd });
    console.log(`  Installed. @${id} now runs in the background: it starts when you log in, restarts if it crashes, and handles
  requests without asking you${isCoder && opt.persistent ? ', in one conversation it keeps across requests and restarts' : ''}.
  Your own Claude Code and Codex sessions on this computer are told what it handled.
  Logs: ${tilde(log)}
  Check on it: backchannel connect --status    Stop it: backchannel connect --stop${service.installed().length > 1 ? ` --id ${id}` : ''}`);
    process.exit(0);
  }
  if (isCoder && opt.persistent) {
    // Read-only even with --write: changes happen in each request's worktree, in a conversation of its own.
    self.session = createSession(backend, { file: sessionFile(id), cwd, model: opt.model, write: false, fresh: opt.fresh,
      system: () => systemPrompt(view(self, { write: false, ...(opt.write ? { choices: workspace?.repos || [] } : {}) }), null),
      dirs: [filesDir(id)], log: (s) => console.log(s) });
    self.sessionFor = sessionFor;
    shownConversation = self.session.conversation;
    console.log(self.session.conversation
      ? `  Picking up its conversation from last time (--fresh starts a new one): ${resumeHint(backend, cwd, self.session.conversation)}`
      : '  Keeps one conversation across requests, so it remembers what it learned (--no-persistent runs each on its own).');
  }
  card.persistent = !!self.session;
  card.service = SERVICE;
  note();
  await hub.listen(card, handle, (s) => console.log(s));
} catch (err) {
  // 410: someone disconnected this agent from the hub's UI or CLI. That's a deliberate stop, not a failure.
  if (err.status === 410) {
    // listen() already said who disconnected it. A service also removes itself, so it doesn't come back at login.
    if (SERVICE && service.removeOwnFile(id)) console.log('Removed this background service. Bring it back with: backchannel connect --service');
    await stop(0);
  }
  console.error(`@${id || 'agent'} can't connect: ${err.message}`);
  // Retrying can't fix a rejected sign-in, so a service exits cleanly instead of restarting every 30 seconds.
  await stop(SERVICE && [401, 403, 409].includes(err.status) ? 0 : 1);
}
