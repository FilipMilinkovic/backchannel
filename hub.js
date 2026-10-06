#!/usr/bin/env node
// Backchannel hub: registry, @mention routing, threads, live feed. Zero dependencies.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 7777);
const HOST = process.env.HOST || '127.0.0.1';
const TOKEN = process.env.HUB_TOKEN || '';
const CONFIG_FILE = path.join(ROOT, 'data', 'config.json');
const ONLINE_MS = 40_000;
const DATA_DIR = path.join(ROOT, 'data');
const LOG_FILE = path.join(DATA_DIR, 'messages.jsonl');
const REGISTRY_FILE = path.join(DATA_DIR, 'agents.json');

const agents = new Map();   // id -> agent card + presence
const inboxes = new Map();  // id -> pending messages
const waiters = new Map();  // id -> [resolve] long-poll callbacks
const messages = [];
const byId = new Map();
const sseClients = new Set();

// ---------- persistence ----------
fs.mkdirSync(DATA_DIR, { recursive: true });
if (fs.existsSync(LOG_FILE)) {
  for (const line of fs.readFileSync(LOG_FILE, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { const m = JSON.parse(line); messages.push(m); byId.set(m.id, m); } catch {}
  }
}
const config = { maxHops: Number(process.env.MAX_HOPS || 8) };
try { Object.assign(config, JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))); } catch {}
const saveConfig = () => fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
const persist = (m) => fs.appendFileSync(LOG_FILE, JSON.stringify(m) + '\n');

// Registry: agents plus undelivered inbox messages (stored as message ids; the bodies live in the log).
// Agents come back offline and idle; they show online again as soon as their connector or session polls.
try {
  const saved = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'));
  for (const a of saved.agents || []) agents.set(a.id, { ...a, state: 'idle', stateThread: null });
  for (const [id, ids] of Object.entries(saved.inboxes || {})) {
    if (agents.has(id)) inboxes.set(id, ids.map((x) => byId.get(x)).filter(Boolean));
  }
} catch (err) {
  if (err.code !== 'ENOENT') console.warn(`Could not read ${REGISTRY_FILE}: ${err.message}`);
}
function writeRegistry() {
  const data = {
    agents: [...agents.values()],
    inboxes: Object.fromEntries([...inboxes].filter(([, box]) => box.length).map(([id, box]) => [id, box.map((m) => m.id)])),
  };
  const tmp = REGISTRY_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, REGISTRY_FILE);
}
let saveTimer = null;
function saveRegistry() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; writeRegistry(); }, 250);
}
function flushRegistry() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  writeRegistry();
}

// ---------- helpers ----------
const newId = () => crypto.randomBytes(6).toString('hex');
const HANDLE = /^[a-z][a-z0-9_-]{0,31}$/;

function publicAgent(a) {
  return { ...a, online: Date.now() - a.lastSeen < ONLINE_MS };
}
function agentList() {
  return [...agents.values()].map(publicAgent).sort((a, b) => a.id.localeCompare(b.id));
}

// Recipients are the @handles a message *starts* with: "@grok @gpt what do you think?"
// Mentions later in the text are just references, so quoting or naming an agent doesn't wake it.
function leadingMentions(text) {
  const out = [];
  const re = /^[\s,:;]*@([a-zA-Z][\w-]*)/;
  let rest = text, m;
  while ((m = rest.match(re))) { out.push(m[1].toLowerCase()); rest = rest.slice(m[0].length); }
  return [...new Set(out)];
}

function broadcast(event) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of sseClients) res.write(data);
}

function deliver(agentId, msg) {
  if (!inboxes.has(agentId)) inboxes.set(agentId, []);
  inboxes.get(agentId).push(msg);
  saveRegistry();
  const ws = waiters.get(agentId) || [];
  waiters.set(agentId, []);
  for (const wake of ws) wake();
}

function threadMessages(threadId) {
  return messages.filter((m) => m.threadId === threadId);
}

function postMessage({ from, text, threadId, inReplyTo, to, kind }) {
  from = String(from || 'human').toLowerCase();
  text = String(text || '').trim();
  if (!text) throw httpError(400, 'text is required');
  const fromAgent = agents.has(from);

  let parent = inReplyTo ? byId.get(inReplyTo) : null;
  if (!parent && threadId) {
    // A human posting into an existing thread with no @mention continues with the last agent that spoke.
    parent = [...threadMessages(threadId)].reverse().find((m) => agents.has(m.from) && m.from !== from) || null;
  }

  const msg = {
    id: newId(),
    threadId: threadId || parent?.threadId || null,
    inReplyTo: parent?.id || null,
    from,
    text,
    ts: Date.now(),
    hop: fromAgent ? (parent?.hop ?? 0) + 1 : 0,
  };
  if (kind === 'error' || kind === 'declined') msg.kind = kind;
  if (!msg.threadId) msg.threadId = msg.id;

  let recipients = Array.isArray(to) ? to.map((x) => String(x).toLowerCase()) : leadingMentions(text);
  if (!Array.isArray(to) && recipients.length === 0 && parent) recipients = [parent.from];
  recipients = recipients.filter((r) => r !== from);
  msg.to = recipients;

  const agentRecipients = recipients.filter((r) => agents.has(r));
  if (msg.hop >= config.maxHops && agentRecipients.length) {
    msg.note = `hop limit (${config.maxHops}) reached; not delivered. Post a new message to continue.`;
  } else {
    for (const r of agentRecipients) deliver(r, msg);
  }

  messages.push(msg);
  byId.set(msg.id, msg);
  persist(msg);
  broadcast({ type: 'message', message: msg });
  return msg;
}

function threadSummaries() {
  const map = new Map();
  for (const m of messages) {
    const t = map.get(m.threadId) || { id: m.threadId, title: m.text.slice(0, 80), started: m.ts, updated: m.ts, count: 0, participants: new Set() };
    t.updated = m.ts; t.count++; t.participants.add(m.from);
    map.set(m.threadId, t);
  }
  return [...map.values()]
    .map((t) => ({ ...t, participants: [...t.participants] }))
    .sort((a, b) => b.updated - a.updated);
}

function publicConfig() {
  return { maxHops: config.maxHops, tokenRequired: !!TOKEN, host: HOST, port: PORT, version: '0.1.0', root: ROOT };
}

// A2A-shaped agent card, so a real A2A binding can be added later without changing the data model.
function agentCard(a, base) {
  return {
    protocolVersion: 'agent-network/0.1 (A2A-shaped)',
    name: a.name,
    description: a.description,
    url: `${base}/api/agents/${a.id}`,
    version: '0.1.0',
    provider: { organization: a.owner || 'unknown' },
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: a.skills?.length ? a.skills : [{ id: 'chat', name: 'Chat', description: a.description || 'General conversation' }],
    'x-backend': a.backend,
    'x-handle': `@${a.id}`,
  };
}

// ---------- http ----------
function httpError(status, message) { const e = new Error(message); e.status = status; return e; }

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > 2_000_000) throw httpError(413, 'body too large'); }
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw httpError(400, 'invalid JSON'); }
}

function authorized(req, url) {
  if (!TOKEN) return true;
  const header = req.headers.authorization || '';
  return header === `Bearer ${TOKEN}` || url.searchParams.get('token') === TOKEN;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
function serveStatic(res, pathname) {
  const file = path.join(ROOT, 'public', pathname === '/' ? 'index.html' : pathname);
  if (!file.startsWith(path.join(ROOT, 'public')) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); return res.end('not found');
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  try {
    if (!p.startsWith('/api/')) return serveStatic(res, p);
    if (!authorized(req, url)) throw httpError(401, 'missing or wrong HUB_TOKEN');

    // live feed for the UI
    if (p === '/api/events' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify({ type: 'hello', agents: agentList(), config: publicConfig() })}\n\n`);
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    if (p === '/api/agents' && req.method === 'GET') return send(res, 200, agentList());

    if (p === '/api/agents' && req.method === 'POST') {
      const b = await readJson(req);
      const id = String(b.id || '').toLowerCase();
      if (!HANDLE.test(id)) throw httpError(400, 'id must be a lowercase handle like "grok" or "filip-claude"');
      if (id === 'human') throw httpError(400, '"human" is reserved');
      const prev = agents.get(id);
      const agent = {
        id,
        name: b.name || id,
        backend: b.backend || 'unknown',
        model: b.model || null,
        owner: b.owner || null,
        description: b.description || '',
        kind: b.kind === 'session' ? 'session' : 'agent',
        access: b.access === 'write' ? 'write' : 'read',
        repo: b.repo || null,
        skills: b.skills || [],
        state: prev?.state || 'idle',
        registeredAt: prev?.registeredAt || Date.now(),
        lastSeen: Date.now(),
      };
      // Update in place so open long-polls keep pointing at the live record.
      if (prev) Object.assign(prev, agent); else agents.set(id, agent);
      saveRegistry();
      broadcast({ type: 'agents', agents: agentList() });
      return send(res, 200, publicAgent(agents.get(id)));
    }

    let m;
    if ((m = p.match(/^\/api\/agents\/([\w-]+)$/)) && req.method === 'DELETE') {
      if (!agents.delete(m[1])) throw httpError(404, 'unknown agent');
      inboxes.delete(m[1]);
      for (const wake of waiters.get(m[1]) || []) wake();
      waiters.delete(m[1]);
      saveRegistry();
      broadcast({ type: 'agents', agents: agentList() });
      return send(res, 200, { ok: true });
    }

    if ((m = p.match(/^\/api\/agents\/([\w-]+)\/card$/))) {
      const a = agents.get(m[1]);
      if (!a) throw httpError(404, 'unknown agent');
      return send(res, 200, agentCard(a, `http://${req.headers.host}`));
    }

    if ((m = p.match(/^\/api\/agents\/([\w-]+)\/inbox$/)) && req.method === 'GET') {
      const a = agents.get(m[1]);
      if (!a) throw httpError(404, 'unknown agent; register first');
      const wasOnline = Date.now() - a.lastSeen < ONLINE_MS;
      a.lastSeen = Date.now();
      if (!wasOnline) broadcast({ type: 'agents', agents: agentList() });
      const wait = Math.min(Number(url.searchParams.get('wait') || 0), 30) * 1000;
      const take = () => {
        const box = inboxes.get(a.id) || [];
        if (box.length) { inboxes.set(a.id, []); saveRegistry(); }
        return box;
      };
      let gone = false;
      res.on('close', () => { if (!res.writableFinished) gone = true; });
      let box = take();
      if (!box.length && wait) {
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, wait);
          const list = waiters.get(a.id) || [];
          list.push(() => { clearTimeout(timer); resolve(); });
          waiters.set(a.id, list);
          res.on('close', resolve);
        });
        if (agents.get(a.id) !== a) return gone ? undefined : send(res, 404, { error: 'agent was removed' });
        a.lastSeen = Date.now();
        box = take();
      }
      if (gone) { // connector went away mid-poll: put messages back
        if (box.length) { inboxes.set(a.id, [...box, ...(inboxes.get(a.id) || [])]); saveRegistry(); }
        return;
      }
      return send(res, 200, box);
    }

    // A session shutting down hands back messages it took but never showed to its agent.
    if ((m = p.match(/^\/api\/agents\/([\w-]+)\/requeue$/)) && req.method === 'POST') {
      const a = agents.get(m[1]);
      if (!a) throw httpError(404, 'unknown agent');
      const b = await readJson(req);
      const box = inboxes.get(a.id) || [];
      const back = (b.ids || []).map((x) => byId.get(x)).filter((msg) => msg && !box.includes(msg));
      inboxes.set(a.id, [...back, ...box]);
      saveRegistry();
      return send(res, 200, { requeued: back.length });
    }

    if ((m = p.match(/^\/api\/agents\/([\w-]+)\/status$/)) && req.method === 'POST') {
      const a = agents.get(m[1]);
      if (!a) throw httpError(404, 'unknown agent');
      const b = await readJson(req);
      a.state = ['working', 'approval'].includes(b.state) ? b.state : 'idle';
      a.stateThread = a.state === 'idle' ? null : b.threadId || null;
      a.lastSeen = Date.now();
      saveRegistry();
      broadcast({ type: 'status', id: a.id, state: a.state, threadId: b.threadId || null });
      return send(res, 200, { ok: true });
    }

    if (p === '/api/messages' && req.method === 'POST') {
      return send(res, 200, postMessage(await readJson(req)));
    }

    if (p === '/api/messages' && req.method === 'GET') return send(res, 200, messages.slice(-5000));

    if (p === '/api/config' && req.method === 'GET') return send(res, 200, publicConfig());
    if (p === '/api/config' && req.method === 'POST') {
      const b = await readJson(req);
      if (b.maxHops !== undefined) {
        const n = Number(b.maxHops);
        if (!Number.isInteger(n) || n < 1 || n > 50) throw httpError(400, 'maxHops must be a whole number from 1 to 50');
        config.maxHops = n;
      }
      saveConfig();
      broadcast({ type: 'config', config: publicConfig() });
      return send(res, 200, publicConfig());
    }

    if (p === '/api/threads' && req.method === 'GET') return send(res, 200, threadSummaries());

    if ((m = p.match(/^\/api\/threads\/([\w-]+)$/)) && req.method === 'GET') {
      return send(res, 200, threadMessages(m[1]));
    }

    throw httpError(404, 'no such endpoint');
  } catch (err) {
    if (!res.headersSent) send(res, err.status || 500, { error: err.message });
  }
});

// Persist lastSeen periodically, and flush everything on shutdown.
setInterval(saveRegistry, 30_000).unref();
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { flushRegistry(); process.exit(0); });

// Presence ticks so the UI notices agents going offline.
setInterval(() => broadcast({ type: 'agents', agents: agentList() }), 10_000).unref();
setInterval(() => { for (const r of sseClients) r.write(': ping\n\n'); }, 20_000).unref();

server.listen(PORT, HOST, () => {
  console.log(`Backchannel hub on http://${HOST}:${PORT}  (max hops ${config.maxHops}${TOKEN ? ', token required' : ''})`);
  if (HOST !== '127.0.0.1' && !TOKEN) console.warn('WARNING: hub is exposed beyond localhost without HUB_TOKEN.');
});
