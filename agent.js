#!/usr/bin/env node
// Connector: makes an agent reachable on the network. Run it in the repo it should answer about:
//   cd ~/code/payments && backchannel connect          (@<you>-claude, Claude Code, read-only, asks you first)
//   backchannel connect --id steve --backend codex --cwd ~/code/payments --write --no-approve
import { parseArgs } from 'node:util';
import readline from 'node:readline/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { hubFromEnv, loadConfig } from './client.js';
import { backends } from './backends.js';

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
    hub: { type: 'string' },
    team: { type: 'string', default: process.env.HUB_TEAM },
    help: { type: 'boolean', short: 'h' },
  },
});
const USAGE = `usage: backchannel connect [--backend claude-code|codex|openai|grok|echo] [--cwd dir] [--id handle] [--write] [--no-approve]
  Defaults: Claude Code (or Codex if that's what's installed), the current folder, @<you>-claude, read-only,
  and it asks you in this terminal before handling each request.`;
const die = (msg) => { console.error(msg); process.exit(1); };
if (opt.help) { console.log(USAGE); process.exit(0); }

const onPath = (cmd) => spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd]).status === 0;
const backend = opt.backend || (onPath('claude') ? 'claude-code' : onPath('codex') ? 'codex' : null);
if (!backend) die(`Neither claude nor codex is on your PATH. Install one, or pick a backend with --backend.\n${USAGE}`);
const run = backends[backend];
if (!run) die(`unknown backend "${backend}". Options: ${Object.keys(backends).join(', ')}`);
if (opt.approve && !process.stdin.isTTY) die('--approve asks in this terminal, but there is none. Run it in a terminal, or add --no-approve to handle requests without asking.');

const cwd = path.resolve(opt.cwd.replace(/^~/, process.env.HOME));
const isCoder = backend === 'claude-code' || backend === 'codex';
// Built from the owner's name, which may only be known once we've reached the hub.
const describe = (owner) => opt.about || (isCoder
  ? `${owner ? owner + "'s" : 'A'} ${backend} agent with ${opt.write ? 'read/write' : 'read-only'} access to the ${path.basename(cwd)} repo.`
  : `${owner ? owner + "'s" : 'An'} ${backend} assistant.`);
let description = describe(opt.owner);
const hub = hubFromEnv({ url: opt.hub, team: opt.team });
// Set once we know who you are: --id, or your handle plus the backend (maya-claude, maya-codex).
let id = opt.id?.toLowerCase();
const card = { id, name: opt.name || id, backend, model: opt.model, owner: opt.owner, description,
  access: isCoder && opt.write ? 'write' : 'read', repo: isCoder ? path.basename(cwd) : null };
const rl = opt.approve ? readline.createInterface({ input: process.stdin, output: process.stdout }) : null;

function systemPrompt(agents, sender) {
  const others = agents.filter((a) => a.id !== id)
    .map((a) => `- @${a.id}: ${a.name} [${a.backend}${a.owner ? `, ${a.owner}` : ''}]${a.online ? '' : ' (offline)'}: ${a.description}`)
    .join('\n') || '- (no other agents yet)';
  return `You are @${id}${card.owner ? `, the agent of ${card.owner}` : ''}, on a shared Agent Network where people's AI agents message each other.
${description}
${isCoder ? `Your working directory is ${cwd}. Use it to answer questions about this code${opt.write ? ' and to make requested changes' : ' (read-only: you cannot edit files)'}.` : ''}

Other participants:
${others}
- @human: the people watching the room (mentioning @human wakes no agent)

How messaging works:
- Your reply goes back to whoever messaged you (right now that's @${sender}). Usually that's what you want.
- To send to someone else, START your reply with their handle, e.g. "@grok what is…". Only handles at the very start route the message.
- Be concrete and brief: answer, file paths, decisions, done/not-done. No preamble.
- If the conversation is finished and nothing useful is left to say, reply with exactly NO_REPLY.`;
}

function transcript(thread, latest) {
  const lines = thread.filter((m) => m.id !== latest.id).slice(-30)
    .map((m) => `[@${m.from}${m.to?.length ? ' → ' + m.to.map((t) => '@' + t).join(' ') : ''}] ${m.text}`);
  return `${lines.length ? `Conversation so far:\n${lines.join('\n\n')}\n\n` : ''}New message for you from @${latest.from}:\n${latest.text}`;
}

async function approve(msg) {
  if (!rl) return true;
  await hub.status(id, 'approval', msg.threadId).catch(() => {});
  console.log(`\n── request from @${msg.from} ──\n${msg.text}\n`);
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
    const [agents, thread] = await Promise.all([hub.agents(), hub.thread(msg.threadId)]);
    const reply = (await run({
      system: systemPrompt(agents, msg.from),
      prompt: transcript(thread, msg),
      latest: msg, model: opt.model, cwd, write: opt.write,
    })).trim();
    if (!reply || reply === 'NO_REPLY') { console.log('  (no reply)'); return; }
    const sent = await hub.post({ from: id, threadId: msg.threadId, inReplyTo: msg.id, text: reply });
    console.log(`→ ${sent.to.map((t) => '@' + t).join(' ') || '(nobody)'}: ${reply.slice(0, 120)}`);
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
  if (me && !card.owner) { card.owner = me.user.name || me.user.handle; card.description = description = describe(card.owner); }
  const access = isCoder ? `${opt.write ? 'can edit' : 'read-only'} in ${cwd.replace(process.env.HOME, '~')}, ` : '';
  console.log(`@${id} (${backend}, ${access}${opt.approve ? 'asks you before each request' : 'handles requests without asking'}) connecting to ${hub.url}…`);
  await hub.listen(card, handle, (s) => console.log(s));
} catch (err) {
  console.error(`@${id || 'agent'} can't connect: ${err.message}`);
  process.exit(1);
}
