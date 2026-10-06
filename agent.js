#!/usr/bin/env node
// Connector: makes an agent reachable on the network.
//   node agent.js --id steve --backend claude-code --cwd ~/code/payments --owner Steve
import { parseArgs } from 'node:util';
import readline from 'node:readline/promises';
import path from 'node:path';
import { Hub } from './client.js';
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
    hub: { type: 'string', default: process.env.HUB_URL || 'http://127.0.0.1:7777' },
  },
});
if (!opt.id) { console.error('usage: node agent.js --id <handle> --backend <openai|grok|claude-code|codex|echo> [--cwd dir] [--owner name] [--write] [--approve]'); process.exit(1); }
const run = backends[opt.backend];
if (!run) { console.error(`unknown backend "${opt.backend}". Options: ${Object.keys(backends).join(', ')}`); process.exit(1); }

const id = opt.id.toLowerCase();
const cwd = path.resolve(opt.cwd.replace(/^~/, process.env.HOME));
const isCoder = opt.backend === 'claude-code' || opt.backend === 'codex';
const description = opt.about || (isCoder
  ? `${opt.owner ? opt.owner + "'s" : 'A'} ${opt.backend} agent with ${opt.write ? 'read/write' : 'read-only'} access to the ${path.basename(cwd)} repo.`
  : `${opt.owner ? opt.owner + "'s" : 'A'} ${opt.backend} assistant.`);
const hub = new Hub(opt.hub, process.env.HUB_TOKEN);
const card = { id, name: opt.name || id, backend: opt.backend, model: opt.model, owner: opt.owner, description,
  access: isCoder && opt.write ? 'write' : 'read', repo: isCoder ? path.basename(cwd) : null };
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
    await hub.post({ from: id, threadId: msg.threadId, inReplyTo: msg.id, kind: 'declined', text: `${opt.owner || 'My owner'} declined this request.` });
    await hub.status(id, 'idle', msg.threadId).catch(() => {});
    return;
  }
  await hub.status(id, 'working', msg.threadId);
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
    await hub.post({ from: id, threadId: msg.threadId, inReplyTo: msg.id, to: [msg.from], kind: 'error', text: `${opt.backend} error: ${err.message}` }).catch(() => {});
  } finally {
    await hub.status(id, 'idle', msg.threadId).catch(() => {});
  }
}

console.log(`@${id} (${opt.backend}${isCoder ? ` in ${cwd}` : ''}) connecting to ${opt.hub}…`);
await hub.listen(card, handle, (s) => console.log(s));
