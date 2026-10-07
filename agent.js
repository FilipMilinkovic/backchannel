#!/usr/bin/env node
// Connector: makes an agent reachable on the network.
//   node agent.js --id steve --backend claude-code --cwd ~/code/payments --owner Steve
import { parseArgs } from 'node:util';
import readline from 'node:readline/promises';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { hubFromEnv, saveFile, describeWorkspace, machineInfo } from './client.js';
import { backends } from './backends.js';

const { values: opt } = parseArgs({
  options: {
    id: { type: 'string' },
    backend: { type: 'string', default: 'echo' },
    name: { type: 'string' },
    owner: { type: 'string' },
    about: { type: 'string', default: '' },
    model: { type: 'string' },
    cwd: { type: 'string', default: process.cwd() },
    write: { type: 'boolean', default: false },   // let claude-code/codex edit files
    approve: { type: 'boolean', default: false }, // owner confirms each request in this terminal
    hub: { type: 'string' },
    team: { type: 'string', default: process.env.HUB_TEAM },
  },
});
if (!opt.id) { console.error('usage: node agent.js --id <handle> --backend <openai|grok|claude-code|codex|echo> [--cwd dir] [--owner name] [--team id] [--write] [--approve]\n  env: HUB_URL, HUB_TOKEN (your personal token), HUB_TEAM (if you are in several teams)'); process.exit(1); }
const run = backends[opt.backend];
if (!run) { console.error(`unknown backend "${opt.backend}". Options: ${Object.keys(backends).join(', ')}`); process.exit(1); }

const id = opt.id.toLowerCase();
const cwd = path.resolve(opt.cwd.replace(/^~/, process.env.HOME));
const isCoder = opt.backend === 'claude-code' || opt.backend === 'codex';
// Built from the owner's name, which may only be known once we've reached the hub, and the repos found in the folder.
let workspace = null;
const where = () => (workspace?.repos.length > 1 ? `${workspace.repos.length} repos in ${path.basename(cwd)}`
  : `the ${workspace?.repos[0]?.name || path.basename(cwd)} repo`);
const describe = (owner) => opt.about || (isCoder
  ? `${owner ? owner + "'s" : 'A'} ${opt.backend} agent with ${opt.write ? 'read/write' : 'read-only'} access to ${where()}.`
  : `${owner ? owner + "'s" : 'An'} ${opt.backend} assistant.`);
let description = describe(opt.owner);
const hub = hubFromEnv({ url: opt.hub, team: opt.team });
const card = { id, name: opt.name || id, backend: opt.backend, model: opt.model, owner: opt.owner, description,
  access: isCoder && opt.write ? 'write' : 'read', repo: isCoder ? path.basename(cwd) : null, approve: opt.approve, ...machineInfo() };
const rl = opt.approve ? readline.createInterface({ input: process.stdin, output: process.stdout }) : null;

function systemPrompt(agents, sender) {
  const others = agents.filter((a) => a.id !== id)
    .map((a) => `- @${a.id}: ${a.name} [${a.backend}${a.owner ? `, ${a.owner}` : ''}]${a.online ? '' : ' (offline)'}: ${a.description}`)
    .join('\n') || '- (no other agents yet)';
  return `You are @${id}${opt.owner ? `, the agent of ${opt.owner}` : ''}, on a shared Agent Network where people's AI agents message each other.
${description}
${isCoder ? `Your working directory is ${cwd}. Use it to answer questions about this code${opt.write ? ' and to make requested changes' : ' (read-only: you cannot edit files)'}.` : ''}

Other participants:
${others}
- @human: the people watching the room (mentioning @human wakes no agent)

How messaging works:
- Your reply goes back to whoever messaged you (right now that's @${sender}). Usually that's what you want.
- To send to someone else, START your reply with their handle, e.g. "@grok what is…". Only handles at the very start route the message.
- Be concrete and brief: answer, file paths, decisions, done/not-done. No preamble.
- Files attached to messages are saved on this computer; their paths are shown next to the message.
- To attach files to your reply, end it with one line per file: "ATTACH: path/to/file" (inside ${isCoder ? 'your working directory' : 'the paths you were given'}).
- If the conversation is finished and nothing useful is left to say, reply with exactly NO_REPLY.`;
}

// `local` maps file ids to where they were saved.
function transcript(thread, latest, local) {
  const files = (m) => (m.files?.length ? `\n${m.files.map((f) => `[attached: ${f.name} → ${local.get(f.id) || 'not downloaded'}]`).join('\n')}` : '');
  const lines = thread.filter((m) => m.id !== latest.id).slice(-30)
    .map((m) => `[@${m.from}${m.to?.length ? ' → ' + m.to.map((t) => '@' + t).join(' ') : ''}] ${m.text}${files(m)}`);
  return `${lines.length ? `Conversation so far:\n${lines.join('\n\n')}\n\n` : ''}New message for you from @${latest.from}:\n${latest.text}${files(latest)}`;
}

// Saves the files attached in the recent part of the thread into one folder per thread.
async function fetchFiles(thread, latest) {
  const dir = path.join(os.tmpdir(), 'backchannel-files', id, latest.threadId);
  const local = new Map();
  for (const m of [...thread.filter((x) => x.id !== latest.id).slice(-30), latest]) {
    for (const f of m.files || []) {
      if (local.has(f.id)) continue;
      try { local.set(f.id, (await saveFile(hub, f.id, path.join(dir, f.id.slice(0, 8)))).path); } catch (err) { console.error(`  could not download ${f.name}: ${err.message}`); }
    }
  }
  return { dir, local };
}

// Pulls "ATTACH: path" lines off the end of a reply and uploads those files. Only files inside the working
// directory (or ones received in this thread) can be sent, so a read-only agent can't attach the rest of the disk.
async function attachFrom(reply, allowed) {
  const lines = reply.split('\n');
  const paths = [];
  for (;;) {
    while (lines.length && !lines.at(-1).trim()) lines.pop();
    const m = lines.length ? /^\s*ATTACH:\s*(.+?)\s*$/.exec(lines.at(-1)) : null;
    if (!m) break;
    lines.pop();
    paths.unshift(m[1].replace(/^["'`]|["'`]$/g, ''));
  }
  const real = (p) => { try { return fs.realpathSync(p); } catch { return null; } };
  const roots = allowed.map((dir) => real(dir) || dir);
  const ids = [], problems = [];
  for (const p of paths) {
    const file = real(path.resolve(cwd, p));
    if (!file || !fs.statSync(file).isFile()) { problems.push(`${p} (not found)`); continue; }
    if (!roots.some((dir) => file.startsWith(dir + path.sep))) { problems.push(`${p} (outside ${cwd})`); continue; }
    try { ids.push((await hub.upload(file)).id); } catch (err) { problems.push(`${p} (${err.message})`); }
  }
  const text = lines.join('\n').trim() + (problems.length ? `\n\n(Could not attach: ${problems.join(', ')})` : '');
  return { text: text.trim(), files: ids };
}

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
    await hub.post({ from: id, threadId: msg.threadId, inReplyTo: msg.id, kind: 'declined', text: `${opt.owner || 'My owner'} declined this request.` });
    await hub.status(id, 'idle', msg.threadId).catch(() => {});
    return;
  }
  await hub.status(id, 'working', msg.threadId);
  // Long tasks don't poll the inbox, so keep reporting "working"; that also keeps the agent marked online.
  const heartbeat = setInterval(() => hub.status(id, 'working', msg.threadId).catch(() => {}), 15_000);
  try {
    const [agents, thread] = await Promise.all([hub.agents(), hub.thread(msg.threadId)]);
    const { dir, local } = await fetchFiles(thread, msg);
    const { text: reply, files } = await attachFrom((await run({
      system: systemPrompt(agents, msg.from),
      prompt: transcript(thread, msg, local),
      latest: msg, model: opt.model, cwd, write: opt.write, dirs: local.size ? [dir] : [],
    })).trim(), [cwd, dir]);
    if ((!reply || reply === 'NO_REPLY') && !files.length) { console.log('  (no reply)'); return; }
    const sent = await hub.post({ from: id, threadId: msg.threadId, inReplyTo: msg.id, text: reply || 'Attached.', files });
    console.log(`→ ${sent.to.map((t) => '@' + t).join(' ') || '(nobody)'}: ${reply.slice(0, 120)}`);
  } catch (err) {
    console.error(`  backend error: ${err.message}`);
    await hub.post({ from: id, threadId: msg.threadId, inReplyTo: msg.id, to: [msg.from], kind: 'error', text: `${opt.backend} error: ${err.message}` }).catch(() => {});
  } finally {
    clearInterval(heartbeat);
    await hub.status(id, 'idle', msg.threadId).catch(() => {});
  }
}

console.log(`@${id} (${opt.backend}${isCoder ? ` in ${cwd}` : ''}) connecting to ${hub.url}…`);
try {
  // Fail fast on bad tokens or teams; if the hub is just down, listen() keeps retrying.
  const me = await hub.resolveTeam().catch((err) => { if (err.status) throw err; return null; });
  if (isCoder) Object.assign(card, workspace = await describeWorkspace(cwd));
  if (me && !card.owner) card.owner = me.user.name || me.user.handle;
  card.description = description = describe(card.owner);
  await hub.listen(card, handle, (s) => console.log(s));
} catch (err) {
  // 410: someone disconnected this agent from the hub's UI or CLI. That's a deliberate stop, not a failure.
  if (err.status === 410) process.exit(0); // listen() already said who disconnected it
  console.error(`@${id} can't connect: ${err.message}`);
  process.exit(1);
}
