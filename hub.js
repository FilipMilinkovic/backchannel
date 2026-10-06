#!/usr/bin/env node
// Backchannel hub: team registry, @mention routing, threads, live feed. Zero dependencies.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, agentKey } from './server/store.js';
import { HANDLE, ROLES, newId, newToken, hashToken, publicUser, httpError, authenticate, requireRole } from './server/auth.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 7777);
const HOST = process.env.HOST || '127.0.0.1';
let publicUrl = (process.env.PUBLIC_URL || `http://${HOST}:${PORT}`).replace(/\/$/, '');
const ONLINE_MS = 40_000;
const store = new Store(path.resolve(process.env.DATA_DIR || './data'));
const { agents, inboxes, messages, byId } = store;
const waiters = new Map();
const sseClients = new Set();

function members(team) {
  return team.members.map((m) => {
    const { handle, name } = store.users.find((u) => u.id === m.userId);
    return { ...m, handle, name };
  });
}
function publicTeam(team, user) {
  return { id: team.id, name: team.name, role: team.members.find((m) => m.userId === user.id)?.role,
    maxHops: team.maxHops, members: members(team) };
}
function publicAgent(a) {
  return { ...a, ownerHandle: store.users.find((u) => u.id === a.ownerUserId)?.handle || null,
    online: Date.now() - a.lastSeen < ONLINE_MS };
}
function agentList(teamId) {
  return [...agents.values()].filter((a) => a.teamId === teamId).map(publicAgent).sort((a, b) => a.id.localeCompare(b.id));
}
function config(team) { return { name: team.name, maxHops: team.maxHops, tokenRequired: true }; }
function broadcast(teamId, event) {
  for (const client of sseClients) if (client.teamId === teamId) client.res.write(`data: ${JSON.stringify(event)}\n\n`);
}
function closeSessions(userId, teamId) {
  for (const client of sseClients) if (client.userId === userId && (!teamId || client.teamId === teamId)) {
    client.res.end();
    sseClients.delete(client);
  }
  for (const [key, list] of waiters) {
    const agent = agents.get(key);
    if (agent?.ownerUserId === userId && (!teamId || agent.teamId === teamId)) for (const wake of [...list]) wake();
  }
}
function removeAgent(agent) {
  const key = agentKey(agent.teamId, agent.id);
  agents.delete(key);
  inboxes.delete(key);
  for (const wake of [...(waiters.get(key) || [])]) wake();
  waiters.delete(key);
}
function leadingMentions(text) {
  const out = [];
  const re = /^[\s,:;]*@([a-zA-Z][\w-]*)/;
  let rest = text, m;
  while ((m = rest.match(re))) { out.push(m[1].toLowerCase()); rest = rest.slice(m[0].length); }
  return [...new Set(out)];
}
function threadMessages(teamId, threadId) { return messages.filter((m) => m.teamId === teamId && m.threadId === threadId); }
function ownedAgent(team, user, id) {
  const agent = agents.get(agentKey(team.id, id));
  if (!agent) throw httpError(404, 'unknown agent');
  if (agent.ownerUserId !== user.id) throw httpError(403, 'agent belongs to another user');
  return agent;
}
function postMessage(team, user, b) {
  if (typeof b.text !== 'string' || !b.text.trim()) throw httpError(400, 'text is required');
  if (b.title !== undefined && (typeof b.title !== 'string' || b.title.trim().length > 120)) {
    throw httpError(400, 'title must be a string of at most 120 characters');
  }
  const text = b.text.trim();
  const fromKind = b.from === undefined ? 'user' : 'agent';
  const from = fromKind === 'user' ? user.handle : String(b.from).toLowerCase();
  if (fromKind === 'agent') ownedAgent(team, user, from);
  if (b.to !== undefined && (!Array.isArray(b.to) || b.to.some((id) => typeof id !== 'string' || !HANDLE.test(id.toLowerCase())))) {
    throw httpError(400, 'to must be an array of handles');
  }
  let parent = b.inReplyTo ? byId.get(b.inReplyTo) : null;
  if (b.inReplyTo && (!parent || parent.teamId !== team.id)) throw httpError(404, 'unknown parent message');
  if (b.threadId && !threadMessages(team.id, b.threadId).length) throw httpError(404, 'unknown thread');
  if (parent && b.threadId && parent.threadId !== b.threadId) throw httpError(400, 'parent is in another thread');
  if (!parent && b.threadId) {
    parent = [...threadMessages(team.id, b.threadId)].reverse().find((m) => m.fromKind === 'agent'
      && agents.has(agentKey(team.id, m.from)) && (fromKind !== 'agent' || m.from !== from)) || null;
  }
  const msg = { id: newId(), teamId: team.id, threadId: b.threadId || parent?.threadId || null,
    inReplyTo: parent?.id || null, from, fromKind, by: user.id, text, ts: Date.now(),
    hop: fromKind === 'agent' ? (parent?.hop ?? 0) + 1 : 0 };
  if (b.kind === 'error' || b.kind === 'declined') msg.kind = b.kind;
  if (b.title !== undefined) msg.title = b.title.trim();
  if (!msg.threadId) msg.threadId = msg.id;
  let recipients = Array.isArray(b.to) ? b.to.map((id) => id.toLowerCase()) : leadingMentions(text);
  if (!Array.isArray(b.to) && !recipients.length && parent?.fromKind === 'agent') recipients = [parent.from];
  msg.to = [...new Set(recipients)].filter((id) => fromKind !== 'agent' || id !== from);
  const targets = msg.to.filter((id) => agents.has(agentKey(team.id, id)));
  if (msg.hop >= team.maxHops && targets.length) {
    msg.note = `hop limit (${team.maxHops}) reached; not delivered. Post a new message to continue.`;
  }
  store.persistMessage(msg);
  if (!msg.note) {
    for (const id of targets) {
      const key = agentKey(team.id, id);
      if (!inboxes.has(key)) inboxes.set(key, []);
      inboxes.get(key).push(msg);
      for (const wake of [...(waiters.get(key) || [])]) wake();
    }
    store.saveRegistry();
  }
  broadcast(team.id, { type: 'message', message: msg });
  return msg;
}
function threadSummaries(teamId) {
  const map = new Map();
  for (const m of messages) {
    if (m.teamId !== teamId) continue;
    const t = map.get(m.threadId) || { id: m.threadId, title: m.text.slice(0, 80), started: m.ts, updated: m.ts, count: 0, participants: new Set() };
    t.updated = m.ts; t.count++; t.participants.add(m.from);
    map.set(m.threadId, t);
  }
  return [...map.values()].map((t) => ({ ...t, participants: [...t.participants] })).sort((a, b) => b.updated - a.updated);
}
function agentCard(a) {
  return { protocolVersion: 'agent-network/0.1 (A2A-shaped)', name: a.name, description: a.description,
    url: `${publicUrl}/api/teams/${a.teamId}/agents/${a.id}`, version: '0.1.0', provider: { organization: a.owner || 'unknown' },
    capabilities: { streaming: false, pushNotifications: false }, defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain'],
    skills: a.skills?.length ? a.skills : [{ id: 'chat', name: 'Chat', description: a.description || 'General conversation' }],
    'x-backend': a.backend, 'x-handle': `@${a.id}` };
}
function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}
async function readJson(req) {
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > 2_000_000) throw httpError(413, 'body too large'); }
  if (!raw) return {};
  let body;
  try { body = JSON.parse(raw); } catch { throw httpError(400, 'invalid JSON'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw httpError(400, 'body must be an object');
  return body;
}
function validName(name) {
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 200) throw httpError(400, 'name must be 1 to 200 characters');
  return name.trim();
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
function serveStatic(res, pathname) {
  const root = path.join(ROOT, 'public');
  const file = path.resolve(root, pathname === '/' ? 'index.html' : '.' + pathname);
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404); return res.end('not found');
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}
async function poll(req, res, url, team, user, member, id) {
  requireRole(member, ['owner', 'member']);
  const a = ownedAgent(team, user, id);
  const tokenHash = user.tokenHash;
  const key = agentKey(team.id, id);
  const wasOnline = Date.now() - a.lastSeen < ONLINE_MS;
  a.lastSeen = Date.now();
  if (!wasOnline) broadcast(team.id, { type: 'agents', agents: agentList(team.id) });
  const seconds = Number(url.searchParams.get('wait') || 0);
  if (!Number.isFinite(seconds) || seconds < 0) throw httpError(400, 'wait must be a non-negative number');
  const wait = Math.min(seconds, 30) * 1000;
  const take = () => {
    const box = inboxes.get(key) || [];
    if (box.length) { inboxes.set(key, []); store.saveRegistry(); }
    return box;
  };
  let gone = res.destroyed;
  let box = [];
  let restored = false;
  const restore = () => {
    if (!restored && box.length && agents.get(key) === a) {
      restored = true;
      inboxes.set(key, [...box, ...(inboxes.get(key) || [])]);
      store.saveRegistry();
    }
  };
  res.on('close', () => { if (!res.writableFinished) { gone = true; restore(); } });
  box = take();
  if (!box.length && wait && !gone) {
    await new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        res.off('close', wake);
        const list = waiters.get(key);
        if (list) { const index = list.indexOf(wake); if (index !== -1) list.splice(index, 1); if (!list.length) waiters.delete(key); }
        resolve();
      };
      const timer = setTimeout(wake, wait);
      const list = waiters.get(key) || [];
      list.push(wake); waiters.set(key, list);
      res.on('close', wake);
    });
    if (gone) return;
    if (agents.get(key) !== a) throw httpError(404, 'agent was removed');
    if (user.tokenHash !== tokenHash) throw httpError(401, 'token was rotated');
    if (!team.members.includes(member)) throw httpError(404, 'unknown team');
    requireRole(member, ['owner', 'member']);
    a.lastSeen = Date.now();
    box = take();
  }
  if (gone) { restore(); return; }
  send(res, 200, box);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const p = url.pathname;
    if (p !== '/api' && !p.startsWith('/api/')) return serveStatic(res, p);
    // Authenticate before reading bodies, then again after the await to honor revocations.
    const publicInvite = /^\/api\/invites\/([a-f0-9]+)(\/accept)?$/.exec(p);
    authenticate(req, url, store.users, !!publicInvite);
    const b = ['POST', 'PATCH'].includes(req.method) ? await readJson(req) : {};
    let user = authenticate(req, url, store.users, !!publicInvite);
    if (publicInvite) {
      const found = store.findInvite(publicInvite[1]);
      if (!found) throw httpError(404, 'invalid invite');
      const { team, invite } = found;
      if (!publicInvite[2] && req.method === 'GET') return send(res, 200, {
        teamName: team.name, role: invite.role, invitedBy: store.users.find((u) => u.id === invite.createdBy)?.handle || null, expiresAt: invite.expiresAt,
      });
      if (publicInvite[2] && req.method === 'POST') {
        let token;
        if (!user) {
          if (typeof b.handle !== 'string' || !HANDLE.test(b.handle)) throw httpError(400, 'invalid handle');
          if (store.users.some((u) => u.handle === b.handle)) throw httpError(409, 'handle already exists');
          const name = b.name === undefined ? b.handle : validName(b.name);
          token = newToken();
          user = { id: newId(), handle: b.handle, name, tokenHash: hashToken(token), createdAt: Date.now() };
          store.users.push(user);
          store.saveUsers();
        }
        if (!team.members.some((m) => m.userId === user.id)) {
          team.members.push({ userId: user.id, role: invite.role, joinedAt: Date.now() });
          invite.usesLeft--;
          if (invite.createdBy === null) {
            for (const a of agents.values()) if (a.teamId === team.id && !a.ownerUserId) a.ownerUserId = user.id;
            store.saveRegistry();
          }
          store.saveTeams();
          broadcast(team.id, { type: 'members', members: members(team) });
          broadcast(team.id, { type: 'agents', agents: agentList(team.id) });
        }
        return send(res, 200, { ...(token ? { token } : {}), user: publicUser(user), team: publicTeam(team, user) });
      }
      throw httpError(404, 'no such endpoint');
    }
    if (p === '/api/me' && req.method === 'GET') return send(res, 200, {
      user: publicUser(user), teams: store.teams.filter((t) => t.members.some((m) => m.userId === user.id))
        .map((t) => ({ id: t.id, name: t.name, role: t.members.find((m) => m.userId === user.id).role })),
    });
    if (p === '/api/me/token' && req.method === 'POST') {
      const token = newToken(); user.tokenHash = hashToken(token); store.saveUsers(); closeSessions(user.id);
      return send(res, 200, { token });
    }
    if (p === '/api/teams' && req.method === 'POST') {
      const team = store.createTeam(validName(b.name), user.id);
      return send(res, 200, { team: publicTeam(team, user) });
    }
    const route = /^\/api\/teams\/([a-f0-9]+)(\/.*)?$/.exec(p);
    const team = route && store.teams.find((t) => t.id === route[1]);
    const member = team?.members.find((m) => m.userId === user.id);
    if (!member) throw httpError(404, 'unknown team');
    const rest = route[2] || '/';
    if (rest === '/' && req.method === 'GET') return send(res, 200, publicTeam(team, user));
    if (rest === '/' && req.method === 'PATCH') {
      requireRole(member, ['owner']);
      const name = b.name === undefined ? team.name : validName(b.name);
      const maxHops = b.maxHops === undefined ? team.maxHops : b.maxHops;
      if (!Number.isInteger(maxHops) || maxHops < 1 || maxHops > 50) throw httpError(400, 'maxHops must be a whole number from 1 to 50');
      Object.assign(team, { name, maxHops }); store.saveTeams();
      broadcast(team.id, { type: 'config', config: config(team) });
      return send(res, 200, publicTeam(team, user));
    }
    if (rest === '/members' && req.method === 'GET') return send(res, 200, members(team));
    let m;
    if ((m = /^\/members\/([a-f0-9]+)$/.exec(rest)) && ['PATCH', 'DELETE'].includes(req.method)) {
      if (req.method !== 'DELETE' || m[1] !== user.id) requireRole(member, ['owner']);
      const target = team.members.find((x) => x.userId === m[1]);
      if (!target) throw httpError(404, 'unknown member');
      if (req.method === 'PATCH' && !ROLES.includes(b.role)) throw httpError(400, 'invalid role');
      if (target.role === 'owner' && (req.method === 'DELETE' || b.role !== 'owner') && team.members.filter((x) => x.role === 'owner').length === 1) {
        throw httpError(403, 'the last owner cannot be demoted or removed');
      }
      if (req.method === 'DELETE') {
        team.members.splice(team.members.indexOf(target), 1);
        for (const a of agents.values()) if (a.teamId === team.id && a.ownerUserId === target.userId) removeAgent(a);
        store.saveRegistry();
      } else target.role = b.role;
      store.saveTeams();
      closeSessions(target.userId, team.id);
      broadcast(team.id, { type: 'members', members: members(team) });
      broadcast(team.id, { type: 'agents', agents: agentList(team.id) });
      return send(res, 200, { ok: true });
    }
    if (rest === '/invites') {
      requireRole(member, ['owner']);
      if (req.method === 'GET') return send(res, 200, team.invites.filter((i) => store.activeInvite(i)).map((i) => ({ ...i, url: `${publicUrl}/#join/${i.code}` })));
      if (req.method === 'POST') {
        const { role = 'member', expiresInHours = 168, uses = 1 } = b;
        if (!ROLES.includes(role)) throw httpError(400, 'invalid role');
        if (typeof expiresInHours !== 'number' || !Number.isFinite(expiresInHours) || expiresInHours <= 0 || !Number.isFinite(Date.now() + expiresInHours * 3_600_000)) throw httpError(400, 'invalid expiry');
        if (!Number.isSafeInteger(uses) || uses < 1) throw httpError(400, 'uses must be a positive integer');
        const invite = store.createInvite(team, role, user.id, expiresInHours, uses);
        return send(res, 200, { ...invite, url: `${publicUrl}/#join/${invite.code}` });
      }
    }
    if ((m = /^\/invites\/([a-f0-9]+)$/.exec(rest)) && req.method === 'DELETE') {
      requireRole(member, ['owner']);
      const index = team.invites.findIndex((i) => i.code === m[1]);
      if (index === -1) throw httpError(404, 'unknown invite');
      team.invites.splice(index, 1); store.saveTeams();
      return send(res, 200, { ok: true });
    }
    if (rest === '/events' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify({ type: 'hello', agents: agentList(team.id), config: config(team), members: members(team), role: member.role })}\n\n`);
      const client = { res, teamId: team.id, userId: user.id };
      sseClients.add(client); res.on('close', () => sseClients.delete(client));
      return;
    }
    if (rest === '/agents' && req.method === 'GET') return send(res, 200, agentList(team.id));
    if (rest === '/agents' && req.method === 'POST') {
      requireRole(member, ['owner', 'member']);
      const id = String(b.id || '').toLowerCase();
      if (!HANDLE.test(id) || id === 'human') throw httpError(400, 'id must be a handle; "human" is reserved');
      const key = agentKey(team.id, id);
      const prev = agents.get(key);
      if (prev && prev.ownerUserId !== user.id) throw httpError(409, 'agent belongs to another user');
      const agent = { id, teamId: team.id, ownerUserId: user.id, name: b.name || id, backend: b.backend || 'unknown',
        model: b.model || null, owner: b.owner || null, description: b.description || '', kind: b.kind === 'session' ? 'session' : 'agent',
        access: b.access === 'write' ? 'write' : 'read', repo: b.repo || null, skills: Array.isArray(b.skills) ? b.skills : [],
        state: prev?.state || 'idle', stateThread: prev?.stateThread || null, registeredAt: prev?.registeredAt || Date.now(), lastSeen: Date.now() };
      // Preserve object identity for active long polls.
      if (prev) Object.assign(prev, agent); else agents.set(key, agent);
      store.saveRegistry(); broadcast(team.id, { type: 'agents', agents: agentList(team.id) });
      return send(res, 200, publicAgent(agents.get(key)));
    }
    if ((m = /^\/agents\/([\w-]+)(?:\/(card|inbox|status|requeue))?$/.exec(rest))) {
      const a = agents.get(agentKey(team.id, m[1]));
      if (!a) throw httpError(404, 'unknown agent');
      const key = agentKey(team.id, a.id);
      if (!m[2] && req.method === 'DELETE') {
        requireRole(member, ['owner', 'member']);
        if (member.role !== 'owner') ownedAgent(team, user, a.id);
        removeAgent(a); store.saveRegistry(); broadcast(team.id, { type: 'agents', agents: agentList(team.id) });
        return send(res, 200, { ok: true });
      }
      if (m[2] === 'card' && req.method === 'GET') return send(res, 200, agentCard(a));
      if (m[2] === 'inbox' && req.method === 'GET') return await poll(req, res, url, team, user, member, a.id);
      if (['status', 'requeue'].includes(m[2]) && req.method === 'POST') {
        requireRole(member, ['owner', 'member']); ownedAgent(team, user, a.id);
        if (m[2] === 'requeue') {
          if (!Array.isArray(b.ids) || b.ids.some((id) => typeof id !== 'string')) throw httpError(400, 'ids must be an array');
          const box = inboxes.get(key) || [];
          const back = [...new Set(b.ids)].map((id) => byId.get(id)).filter((msg) => msg?.teamId === team.id && msg.to?.includes(a.id) && !msg.note && !box.includes(msg));
          inboxes.set(key, [...back, ...box]); store.saveRegistry();
          for (const wake of [...(waiters.get(key) || [])]) wake();
          return send(res, 200, { requeued: back.length });
        }
        if (b.threadId && !threadMessages(team.id, b.threadId).length) throw httpError(404, 'unknown thread');
        a.state = ['working', 'approval'].includes(b.state) ? b.state : 'idle';
        a.stateThread = a.state === 'idle' ? null : b.threadId || null;
        a.lastSeen = Date.now(); store.saveRegistry();
        broadcast(team.id, { type: 'status', id: a.id, state: a.state, threadId: a.stateThread });
        return send(res, 200, { ok: true });
      }
    }
    if (rest === '/messages' && req.method === 'POST') {
      requireRole(member, ['owner', 'member']); return send(res, 200, postMessage(team, user, b));
    }
    if (rest === '/messages' && req.method === 'GET') return send(res, 200, messages.filter((msg) => msg.teamId === team.id).slice(-5000));
    if (rest === '/threads' && req.method === 'GET') return send(res, 200, threadSummaries(team.id));
    if ((m = /^\/threads\/([\w-]+)$/.exec(rest)) && req.method === 'GET') {
      const thread = threadMessages(team.id, m[1]);
      if (!thread.length) throw httpError(404, 'unknown thread');
      return send(res, 200, thread);
    }
    throw httpError(404, 'no such endpoint');
  } catch (err) {
    if (!res.headersSent && !res.destroyed) send(res, err.status || 500, { error: err.status ? err.message : 'internal server error' });
    if (!err.status) console.error(err);
  }
});

setInterval(() => store.saveRegistry(), 30_000).unref();
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { store.saveRegistry(); process.exit(0); });
setInterval(() => { for (const team of store.teams) broadcast(team.id, { type: 'agents', agents: agentList(team.id) }); }, 10_000).unref();
setInterval(() => { for (const client of sseClients) client.res.write(': ping\n\n'); }, 20_000).unref();
server.listen(PORT, HOST, () => {
  const port = server.address().port;
  if (!process.env.PUBLIC_URL) publicUrl = `http://${HOST}:${port}`;
  console.log(`Backchannel hub on http://${HOST}:${port}`);
  if (store.setupInvite) console.log(`Setup link: ${publicUrl}/#join/${store.setupInvite.code}`);
});
