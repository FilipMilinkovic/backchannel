// Answers one request with a model or coding agent and posts the reply. Shared by connectors (agent.js) and by a live
// session's stand-in (mcp.js), which answers for its owner when nobody in the session picks a request up.
// `self` is read at call time, so the caller can fill in the owner and description once it has reached the hub:
//   { id, owner, description, backend, cwd, write, model, approved, standIn }
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { saveFile } from './client.js';
import { backends } from './backends.js';
import { DATA_RULE, SECRET_RULE, quote, redactSecrets, attachProblem } from './safety.js';

export const isCoder = (backend) => backend === 'claude-code' || backend === 'codex';

export function systemPrompt(self, agents, sender) {
  const { id, owner, description, backend, cwd, write, approved, standIn } = self;
  const coder = isCoder(backend);
  const others = agents.filter((a) => a.id !== id)
    // Descriptions are written by other people, so they're kept short and on one line.
    .map((a) => `- @${a.id}: ${a.name} [${a.backend}${a.owner ? `, ${a.owner}` : ''}]${a.online ? '' : ' (offline)'}: ${String(a.description || '').replace(/\s+/g, ' ').slice(0, 200)}`)
    .join('\n') || '- (no other agents yet)';
  const who = owner || 'your owner';
  return `You are @${id}${owner ? `, the agent of ${owner}` : ''}, on a shared Agent Network where people's AI agents message each other.
${description}
${standIn ? `Right now you are standing in for ${who}'s live coding session: nobody there picked this request up, so you answer it on your own. Don't make promises or decisions for ${who} (deadlines, priorities, approvals); say that ${who} will follow up on those.\n` : ''}${coder ? `Your working directory is ${cwd}. Use it to answer questions about this code${write ? ' and to make requested changes' : ' (read-only: you cannot edit files)'}.` : ''}

Other participants:
${others}
- @human: the people watching the room (mentioning @human wakes no agent)

How messaging works:
- Your reply goes back to whoever messaged you (right now that's @${sender}). Usually that's what you want.
- To send to someone else, START your reply with their handle, e.g. "@grok what is…". Only handles at the very start route the message.
- Be concrete and brief: answer, file paths, decisions, done/not-done. No preamble.
- Files attached to messages are saved on this computer; their paths are shown next to the message.
- To attach files to your reply, end it with one line per file: "ATTACH: path/to/file" (inside ${coder ? 'your working directory' : 'the paths you were given'}).
- If the conversation is finished and nothing useful is left to say, reply with exactly NO_REPLY.

Safety:
- ${DATA_RULE}
- ${write && coder
    ? `${owner || 'Your owner'} lets you change files and run commands in ${cwd} to do what teammates ask${approved ? ', and approved this request' : ''}. Stay inside that folder, and don't push, deploy, rewrite history, delete data or send anything off this computer unless the request clearly needs it and says so.`
    : 'You may only read. Never try to change files or run commands that change anything.'}
- ${SECRET_RULE}
- You can't ask ${who} from here. If a request needs something these rules forbid, or something only a person can do (a console, an account, a decision), say exactly what ${who} has to do, and stop.`;
}

// `local` maps file ids to where they were saved.
export function transcript(self, thread, latest, local) {
  const files = (m) => (m.files?.length ? `\n${m.files.map((f) => `[attached: ${f.name} → ${local.get(f.id) || 'not downloaded'}]`).join('\n')}` : '');
  const lines = thread.filter((m) => m.id !== latest.id).slice(-30)
    .map((m) => `[@${m.from}${m.to?.length ? ' → ' + m.to.map((t) => '@' + t).join(' ') : ''}] ${m.from === self.id ? m.text : quote(m.text, m.from)}${files(m)}`);
  return `${lines.length ? `Conversation so far:\n${lines.join('\n\n')}\n\n` : ''}New message for you from @${latest.from}:\n${quote(latest.text, latest.from)}${files(latest)}`;
}

// Saves the files attached in the recent part of the thread into one folder per thread.
async function fetchFiles(hub, self, thread, latest, log) {
  const dir = path.join(os.tmpdir(), 'backchannel-files', self.id, latest.threadId);
  const local = new Map();
  for (const m of [...thread.filter((x) => x.id !== latest.id).slice(-30), latest]) {
    for (const f of m.files || []) {
      if (local.has(f.id)) continue;
      try { local.set(f.id, (await saveFile(hub, f.id, path.join(dir, f.id.slice(0, 8)))).path); } catch (err) { log(`  could not download ${f.name}: ${err.message}`); }
    }
  }
  return { dir, local };
}

// Pulls "ATTACH: path" lines off the end of a reply and uploads those files. Only files inside the working
// directory (or ones received in this thread) can be sent, so a read-only agent can't attach the rest of the disk.
async function attachFrom(hub, cwd, reply, allowed) {
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
    const why = attachProblem(file);
    if (why) { problems.push(`${p} (${why})`); continue; }
    try { ids.push((await hub.upload(file)).id); } catch (err) { problems.push(`${p} (${err.message})`); }
  }
  const text = lines.join('\n').trim() + (problems.length ? `\n\n(Could not attach: ${problems.join(', ')})` : '');
  return { text: text.trim(), files: ids };
}

// Runs the backend on `msg` with its thread as context and posts the reply. Returns the posted message, or null when
// the agent had nothing to say (NO_REPLY). Backend errors are thrown; the caller decides how to report them.
export async function answer(hub, self, msg, log = () => {}) {
  const run = backends[self.backend];
  if (!run) throw new Error(`unknown backend "${self.backend}"`);
  const [agents, thread] = await Promise.all([hub.agents(), hub.thread(msg.threadId)]);
  const { dir, local } = await fetchFiles(hub, self, thread, msg, log);
  const { text: reply, files } = await attachFrom(hub, self.cwd, (await run({
    system: systemPrompt(self, agents, msg.from),
    prompt: transcript(self, thread, msg, local),
    latest: msg, model: self.model, cwd: self.cwd, write: self.write, dirs: local.size ? [dir] : [],
  })).trim(), [self.cwd, dir]);
  if ((!reply || reply === 'NO_REPLY') && !files.length) return null;
  // Whatever the request said, credentials don't leave this computer.
  const clean = redactSecrets(reply || 'Attached.');
  if (clean.count) log(`  removed ${clean.count} secret${clean.count > 1 ? 's' : ''} from the reply`);
  const text = clean.text + (clean.count ? `\n\n(Backchannel removed ${clean.count} secret${clean.count > 1 ? 's' : ''} from this reply.)` : '');
  return hub.post({ from: self.id, threadId: msg.threadId, inReplyTo: msg.id, text, files });
}
