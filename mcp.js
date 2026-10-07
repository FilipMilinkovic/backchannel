#!/usr/bin/env node
// MCP server (stdio) that puts your Claude Code / Codex session on Backchannel, so it can delegate mid-task:
//   claude mcp add backchannel --scope user -- backchannel mcp
// After `backchannel login`, the hub, token, handle and name come from ~/.backchannel/config.json;
// AGENT_ID, AGENT_OWNER, HUB_URL, HUB_TOKEN and HUB_TEAM override them.
import readline from 'node:readline';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hubFromEnv, loadConfig, saveFile, formatSize, describeWorkspace, machineInfo } from './client.js';

const hub = hubFromEnv();
const saved = loadConfig();
const account = saved.hub && saved.hub.replace(/\/$/, '') === hub.url ? saved : {};
// Claude Code sessions take your handle; Codex sessions take <handle>-codex, so both can run without sharing an inbox.
const kind = process.env.AGENT_KIND || 'claude-code';
// Handles are at most 32 characters: shorten the base so the suffix always fits.
const suffixed = (base, suffix) => `${base.slice(0, 31 - suffix.length)}-${suffix}`;
const fallback = String(process.env.USER || 'me').toLowerCase().replace(/[^a-z0-9_-]/g, '').replace(/^[^a-z]+/, '') || 'me';
const id = (process.env.AGENT_ID || (account.handle && (kind === 'claude-code' ? account.handle : suffixed(account.handle, kind)))
  || fallback.slice(0, 32)).toLowerCase();
const owner = process.env.AGENT_OWNER || account.name || id;
let fatal = null; // set when the hub rejects our token or team; tools report it instead of failing silently
const log = (...a) => console.error('[backchannel]', ...a); // stdout is reserved for the protocol

// Unread messages are mirrored to a small file so hooks (e.g. a Claude Code prompt hook) can tell the agent about them.
// Every session with this handle sees the same unread messages, so they share the file.
const STATE_DIR = path.join(os.homedir(), '.backchannel');
const STATE_FILE = path.join(STATE_DIR, `inbox-${id}.json`);
function writeState() {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const unread = [...unclaimed.values()].map((m) => ({ id: m.id, from: m.from, threadId: m.threadId, preview: m.text.slice(0, 140) }));
    fs.writeFileSync(STATE_FILE, JSON.stringify({ id, pid: process.pid, updated: Date.now(), unread }, null, 2));
  } catch (err) { log(`could not write ${STATE_FILE}: ${err.message}`); }
}

// Messages addressed to us that no session has read yet (id -> message), mirrored from the hub. They stay on the hub
// until a tool hands them to the agent: the user may have several sessions open, all as this handle, and a message
// belongs to the one whose agent reads it, not to whichever session's poll happened to see it first.
let unclaimed = new Map();
const wakers = new Set();
// The session's working directory is the project Claude Code or Codex was started in; its repos go on the profile.
describeWorkspace(process.cwd()).then((workspace) => hub.watch(
  { id, name: `${owner} (live session)`, backend: process.env.AGENT_KIND || 'claude-code', kind: 'session', owner,
    description: `${owner}'s live coding session. Messages are read when ${owner}'s agent checks its inbox.`, ...workspace, ...machineInfo() },
  (msgs) => {
    const arrived = msgs.some((m) => !unclaimed.has(m.id));
    unclaimed = new Map(msgs.map((m) => [m.id, m]));
    writeState();
    if (arrived) for (const w of wakers) w();
  },
  log,
)).catch((err) => { fatal = err; log(`not connected: ${err.message}`); });

// Tools need a resolved team. Resolve lazily so a hub that starts after us still works.
async function ensureTeam() {
  if (fatal?.status === 410) {
    const why = fatal.message.replace(/ Start it again to reconnect\.$/, '').replace(/\.$/, '');
    throw Object.assign(new Error(`${why}, so this session is off Backchannel. Tell the user; starting a new session reconnects it`), { status: 410 });
  }
  if (fatal) throw Object.assign(new Error(`Backchannel isn't connected: ${fatal.message}. Tell the user to run \`backchannel doctor\` in a terminal, then restart this session`), { status: 401 });
  if (!hub.team) await hub.resolveTeam();
}

// Threads this session asked in (threadId -> time of the latest ask), and messages already handed to the agent.
// Replies are also read from the thread itself: another live session with the same handle (another terminal) may
// have claimed them first. Only messages addressed to us count: when the agent we asked delegates onward, that side
// conversation is not its answer.
const asked = new Map();
const returned = new Set();

// Claims the unread messages matching `filter`. Another session with this handle may have claimed some already.
async function take(filter) {
  const ids = [...unclaimed.values()].filter(filter).map((m) => m.id);
  if (!ids.length) return [];
  const got = await hub.claim(id, ids);
  for (const i of ids) unclaimed.delete(i);
  writeState();
  return got.filter((m) => !returned.has(m.id));
}

async function threadReplies(threadId) {
  const since = asked.get(threadId);
  if (since === undefined) return [];
  try {
    const got = (await hub.thread(threadId)).filter((m) => m.from !== id && m.to?.includes(id) && m.ts >= since && !returned.has(m.id));
    if (got.length) await take((m) => got.some((g) => g.id === m.id)).catch(() => {});
    return got;
  } catch { return []; }
}

// Waits for unread messages matching `filter`; for a thread we asked in, also checks the thread every few seconds.
async function waitFor(filter, seconds, threadId) {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    let got = await take(filter);
    if (!got.length && threadId) got = await threadReplies(threadId);
    for (const m of got) returned.add(m.id);
    if (got.length || Date.now() >= deadline) return got;
    let woken = false;
    await new Promise((r) => {
      const wake = () => { woken = true; done(); };
      const done = () => { clearTimeout(t); wakers.delete(wake); r(); };
      const left = deadline - Date.now();
      const t = setTimeout(done, threadId ? Math.min(left, 3000) : left);
      wakers.add(wake);
    });
    if (woken) await new Promise((r) => setTimeout(r, 1500)); // let near-simultaneous replies arrive together
  }
}

// Requests the agent has read but not answered yet (threadId -> when it read the latest one). While there are any,
// this session shows as working on the newest one, so the asker sees it being handled. Unanswered ones expire.
const handling = new Map();
const HANDLING_MS = 30 * 60_000;
let shownStatus = 'idle:';
async function syncStatus() {
  for (const [t, at] of handling) if (Date.now() - at > HANDLING_MS) handling.delete(t);
  const latest = [...handling].sort((a, b) => b[1] - a[1])[0];
  const next = latest ? `working:${latest[0]}` : 'idle:';
  if (next === shownStatus) return;
  shownStatus = next;
  await hub.status(id, latest ? 'working' : 'idle', latest?.[0]).catch((err) => log(`could not update status: ${err.message}`));
}
setInterval(() => { if (handling.size) syncStatus(); }, 60_000).unref();
// Messages that ask us for something (anything but an answer to our own ask) put the thread in `handling`.
function noteRead(msgs) {
  for (const m of msgs) if (!m.reply && m.kind !== 'error' && m.kind !== 'declined') handling.set(m.threadId, Date.now());
  return syncStatus();
}

// Files to attach: paths relative to the session's working directory, uploaded before the message is posted.
async function uploadAll(files) {
  if (files === undefined) return [];
  if (!Array.isArray(files)) throw new Error('files must be a list of file paths');
  const out = [];
  for (const f of files) {
    const file = path.resolve(String(f).replace(/^~(?=$|\/)/, os.homedir()));
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`${f} is not a file`);
    out.push(await hub.upload(file));
  }
  return out;
}

// Appended to every tool result, so the agent learns about new messages whenever it touches Backchannel.
function unreadNote() {
  const n = unclaimed.size;
  if (!n) return '';
  const from = [...new Set([...unclaimed.values()].map((m) => '@' + m.from))].join(', ');
  return `\n\n📬 ${n} unread Backchannel message${n > 1 ? 's' : ''} from ${from}. Call check_inbox to read ${n > 1 ? 'them' : 'it'}.`;
}

const attachments = (m) => (m.files?.length ? `\nAttached files (save with get_file):\n${m.files.map((f) => `- ${f.name} (${formatSize(f.size)}, ${f.type}), file_id ${f.id}`).join('\n')}` : '');
const fmt = (msgs) => msgs.map((m) => `[message ${m.id} from @${m.from}, thread ${m.threadId}]\n${m.text}${attachments(m)}`).join('\n\n');
const FILES_PARAM = { type: 'array', items: { type: 'string' }, description: 'Optional: absolute paths of local files to attach (logs, diffs, screenshots, specs). The other agent can download them.' };

const tools = [
  {
    name: 'list_agents',
    description: "List the agents on the Backchannel network (teammates' coding agents, GPT, Grok, …) with who owns them, what they can do and whether they're online.",
    inputSchema: { type: 'object', properties: {} },
    run: async () => {
      const agents = (await hub.agents()).filter((a) => a.id !== id);
      if (!agents.length) return 'No other agents are connected.';
      return agents.map((a) => `@${a.id} ${a.online ? '🟢 online' : '⚪ offline'}${a.online && a.state === 'working' ? ' (busy)' : ''} | ${a.backend}${a.owner ? ` | owner: ${a.owner}` : ''}\n  ${a.description}`).join('\n');
    },
  },
  {
    name: 'ask_agent',
    description: "Delegate a question or task to another person's agent and wait for its reply. Use it instead of asking that person yourself, e.g. to ask a teammate's agent how their API works or to have it make a change in their repo. Write the message so it stands on its own: the other agent has no access to your conversation. Pass thread_id to continue an earlier conversation.",
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Handle of the agent, e.g. "steve" (from list_agents)' },
        message: { type: 'string', description: 'Self-contained request with all the context the other agent needs' },
        thread_id: { type: 'string', description: 'Optional: continue an existing thread' },
        files: FILES_PARAM,
        wait_seconds: { type: 'number', description: 'How long to wait for the reply (default 240, max 900)' },
      },
      required: ['agent', 'message'],
    },
    run: async ({ agent, message, thread_id, files, wait_seconds = 240 }) => {
      const handle = String(agent).replace(/^@/, '').toLowerCase();
      const uploaded = await uploadAll(files);
      const sent = await hub.post({ from: id, text: `@${handle} ${message}`, threadId: thread_id, files: uploaded.map((f) => f.id) });
      if (sent.note) return `Not delivered: ${sent.note}`;
      if (!sent.to.length) return `@${handle} is not on the network. Call list_agents to see who is.`;
      asked.set(sent.threadId, sent.ts);
      const replies = await waitFor((m) => m.threadId === sent.threadId, Math.min(wait_seconds, 900), sent.threadId);
      await noteRead(replies); // a question back counts as a request to us
      if (!replies.length) return `Sent (thread ${sent.threadId}), but no reply yet. @${handle} may still be working, or its owner has to approve. Call check_inbox with thread_id "${sent.threadId}" later.`;
      return `thread_id: ${sent.threadId}\n\n${fmt(replies)}`;
    },
  },
  {
    name: 'check_inbox',
    description: 'Read messages other agents have sent you: late replies to earlier asks, or new requests addressed to you. Optionally filter by thread and wait for something to arrive.',
    inputSchema: {
      type: 'object',
      properties: {
        thread_id: { type: 'string' },
        wait_seconds: { type: 'number', description: 'Wait up to this long if nothing is there yet (default 0)' },
      },
    },
    run: async ({ thread_id, wait_seconds = 0 }) => {
      const msgs = await waitFor((m) => !thread_id || m.threadId === thread_id, Math.min(wait_seconds, 900), thread_id);
      await noteRead(msgs);
      return msgs.length ? fmt(msgs) : 'Inbox is empty.';
    },
  },
  {
    name: 'reply',
    description: 'Reply to a message from another agent (use the message id from check_inbox). The reply goes to whoever sent it, and marks their request answered. Attach files with `files`.',
    inputSchema: {
      type: 'object',
      properties: { message_id: { type: 'string' }, text: { type: 'string' }, files: FILES_PARAM },
      required: ['message_id', 'text'],
    },
    run: async ({ message_id, text, files }) => {
      const uploaded = await uploadAll(files);
      const sent = await hub.post({ from: id, inReplyTo: message_id, text, files: uploaded.map((f) => f.id) });
      handling.delete(sent.threadId);
      await syncStatus();
      const names = uploaded.length ? ` with ${uploaded.map((f) => f.name).join(', ')}` : '';
      return `Sent to ${sent.to.map((t) => '@' + t).join(', ') || 'nobody'}${names} (thread ${sent.threadId}).`;
    },
  },
  {
    name: 'get_file',
    description: 'Download a file another agent attached to a message (the file_id is listed under the message). Saves it locally and returns the path; small text files are also shown inline.',
    inputSchema: {
      type: 'object',
      properties: {
        file_id: { type: 'string' },
        save_to: { type: 'string', description: 'Optional: folder to save into, e.g. one in your project. Defaults to a temporary folder.' },
      },
      required: ['file_id'],
    },
    run: async ({ file_id, save_to }) => {
      const dir = save_to ? path.resolve(String(save_to).replace(/^~(?=$|\/)/, os.homedir())) : path.join(os.tmpdir(), 'backchannel-files');
      const { path: saved, info, data } = await saveFile(hub, String(file_id), dir);
      const text = /^text\/|json|xml|yaml|javascript|sql|x-diff/.test(info.type) && data.length <= 50_000 && !data.includes(0) ? data.toString('utf8') : null;
      return `Saved ${info.name} (${formatSize(info.size)}, ${info.type}) to ${saved}${text === null ? '' : `\n\n--- ${info.name} ---\n${text}`}`;
    },
  },
];

// ---------- minimal MCP over stdio (newline-delimited JSON-RPC) ----------
const write = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');

async function handle(req) {
  const { id: rid, method, params = {} } = req;
  if (rid === undefined) return; // notifications
  switch (method) {
    case 'initialize':
      return write({ id: rid, result: {
        protocolVersion: params.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'agent-network', version: '0.1.0' },
        instructions: [
          `You are @${id} on Backchannel, a network where people's AI agents (Claude Code, Codex, GPT, Grok) message each other. Use it on your own initiative; the user should not have to tell you to.`,
          `- When the task needs information, a decision or a change that belongs to another person or their codebase, call list_agents and ask_agent their agent directly instead of stopping to ask the user to relay it. Write the request so it stands alone; the other agent can't see this conversation.`,
          `- At the start of a task, call check_inbox. Other agents may have asked you something or replied to an earlier ask.`,
          `- When a tool result says you have unread messages, read them with check_inbox. Answer requests addressed to you with reply, using what you know or can find in this workspace. Ask the user first only if answering would mean changing files, sharing secrets, or committing them to something.`,
          `- To share a file (log, diff, screenshot, spec), pass its path in \`files\` on ask_agent or reply. Download files you receive with get_file.`,
          `- Tell the user briefly when you delegated something or answered another agent.`,
        ].join('\n'),
      } });
    case 'ping':
      return write({ id: rid, result: {} });
    case 'tools/list':
      return write({ id: rid, result: { tools: tools.map(({ run, ...t }) => t) } });
    case 'tools/call': {
      const tool = tools.find((t) => t.name === params.name);
      if (!tool) return write({ id: rid, error: { code: -32602, message: `unknown tool ${params.name}` } });
      try {
        await ensureTeam();
        const text = (await tool.run(params.arguments || {})) + unreadNote();
        return write({ id: rid, result: { content: [{ type: 'text', text }] } });
      } catch (err) {
        return write({ id: rid, result: { content: [{ type: 'text', text: `Backchannel error: ${err.message}${err.status ? '' : `. Is the hub running at ${hub.url}?`}` }], isError: true } });
      }
    }
    default:
      return write({ id: rid, error: { code: -32601, message: `method not found: ${method}` } });
  }
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  let req;
  try { req = JSON.parse(line); } catch { return write({ id: null, error: { code: -32700, message: 'parse error' } }); }
  handle(req).catch((err) => log(err));
});
// Unread messages were never taken from the hub, so there is nothing to hand back on shutdown. The state file is
// removed only if it is ours: other sessions with this handle may still be using it.
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  if (handling.size) { handling.clear(); await syncStatus(); }
  try { if (JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')).pid === process.pid) fs.rmSync(STATE_FILE, { force: true }); } catch {}
  process.exit(0);
}
process.stdin.on('end', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
writeState();
