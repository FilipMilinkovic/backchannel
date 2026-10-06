// The hub API (see docs/TEAMS-PLAN.md): accounts, invites, teams, members, agents, messages, threads, live events.
import { HANDLE, ROLES, newId, newToken, hashToken, publicUser, httpError, authenticate, stillValid, requireRole } from './auth.js';

const LOGIN_TTL_MS = 60_000;

export function createApi({ repo, rt, config, publicUrl, limits }) {
  // ---------- views ----------
  const members = (teamId) => repo.members(teamId);
  const publicTeam = (team, userId) => ({ id: team.id, name: team.name, role: repo.member(team.id, userId)?.role,
    maxHops: team.maxHops, members: members(team.id) });
  const teamConfig = (team) => ({ name: team.name, maxHops: team.maxHops, tokenRequired: true });
  function publicAgent(a) {
    const p = rt.presenceOf(a.teamId, a.id);
    return { ...a, state: p.state, stateThread: p.stateThread, lastSeen: p.lastSeen,
      ownerHandle: a.ownerUserId ? repo.userById(a.ownerUserId)?.handle || null : null, online: rt.online(p) };
  }
  const agentList = (teamId) => repo.agents(teamId).map(publicAgent);
  const broadcastAgents = (teamId) => rt.broadcast(teamId, { type: 'agents', agents: agentList(teamId) });
  const broadcastMembers = (teamId) => rt.broadcast(teamId, { type: 'members', members: members(teamId) });
  function agentCard(a) {
    return { protocolVersion: 'agent-network/0.1 (A2A-shaped)', name: a.name, description: a.description,
      url: `${publicUrl()}/api/teams/${a.teamId}/agents/${a.id}`, version: '0.1.0', provider: { organization: a.owner || 'unknown' },
      capabilities: { streaming: false, pushNotifications: false }, defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain'],
      skills: a.skills?.length ? a.skills : [{ id: 'chat', name: 'Chat', description: a.description || 'General conversation' }],
      'x-backend': a.backend, 'x-handle': `@${a.id}` };
  }
  const ownedBy = (userId) => (key) => {
    const [t, id] = key.split('/');
    return repo.agent(t, id)?.ownerUserId === userId;
  };
  const closeUser = (userId, teamId) => rt.closeUser(userId, teamId, ownedBy(userId));
  // Re-checks every live stream's credential and membership; SSE time counts as session activity.
  function revalidateStreams() {
    const now = Date.now();
    rt.revalidate((c) => {
      if (!stillValid(repo, c.auth) || !repo.member(c.teamId, c.userId)) return false;
      if (c.auth.sessionHash) {
        const s = repo.sessionByHash(c.auth.sessionHash);
        if (now - s.lastUsedAt > config.sessionDays * 86_400_000) return false;
        if (now - s.lastUsedAt > 60_000) repo.touchSession(s.hash, now);
      }
      return true;
    });
  }
  function removeAgent(teamId, id) { repo.deleteAgent(teamId, id); rt.forget(teamId, id); }
  function validName(name) {
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 200) throw httpError(400, 'name must be 1 to 200 characters');
    return name.trim();
  }
  function ownedAgent(team, user, id) {
    const agent = repo.agent(team.id, id);
    if (!agent) throw httpError(404, 'unknown agent');
    if (agent.ownerUserId !== user.id) throw httpError(403, 'agent belongs to another user');
    return agent;
  }

  // ---------- messages ----------
  function leadingMentions(text) {
    const out = [];
    const re = /^[\s,:;]*@([a-zA-Z][\w-]*)/;
    let rest = text, m;
    while ((m = rest.match(re))) { out.push(m[1].toLowerCase()); rest = rest.slice(m[0].length); }
    return [...new Set(out)];
  }
  function postMessage(team, user, b) {
    if (typeof b.text !== 'string' || !b.text.trim()) throw httpError(400, 'text is required');
    if (b.text.length > 200_000) throw httpError(413, 'text is too long (max 200000 characters)');
    if (b.title !== undefined && (typeof b.title !== 'string' || b.title.trim().length > 120)) {
      throw httpError(400, 'title must be a string of at most 120 characters');
    }
    const text = b.text.trim();
    const fromKind = b.from === undefined ? 'user' : 'agent';
    const from = fromKind === 'user' ? user.handle : String(b.from).toLowerCase();
    if (fromKind === 'agent') ownedAgent(team, user, from);
    if (b.to !== undefined && (!Array.isArray(b.to) || b.to.length > 50 || b.to.some((id) => typeof id !== 'string' || !HANDLE.test(id.toLowerCase())))) {
      throw httpError(400, 'to must be an array of handles');
    }
    if (b.threadId !== undefined && b.threadId !== null && typeof b.threadId !== 'string') throw httpError(400, 'threadId must be a string');
    if (b.inReplyTo !== undefined && b.inReplyTo !== null && typeof b.inReplyTo !== 'string') throw httpError(400, 'inReplyTo must be a string');
    let parent = b.inReplyTo ? repo.message(b.inReplyTo) : null;
    if (b.inReplyTo && (!parent || parent.teamId !== team.id)) throw httpError(404, 'unknown parent message');
    const thread = b.threadId ? repo.threadMessages(team.id, b.threadId) : null;
    if (b.threadId && !thread.length) throw httpError(404, 'unknown thread');
    if (parent && b.threadId && parent.threadId !== b.threadId) throw httpError(400, 'parent is in another thread');
    if (!parent && b.threadId) {
      parent = [...thread].reverse().find((m) => m.fromKind === 'agent'
        && repo.agent(team.id, m.from) && (fromKind !== 'agent' || m.from !== from)) || null;
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
    const targets = msg.to.filter((id) => repo.agent(team.id, id));
    if (msg.hop >= team.maxHops && targets.length) {
      msg.note = `hop limit (${team.maxHops}) reached; not delivered. Post a new message to continue.`;
    }
    repo.tx(() => {
      repo.insertMessage(msg);
      if (!msg.note) for (const id of targets) repo.enqueue(team.id, id, msg.id);
    });
    if (!msg.note) for (const id of targets) rt.wake(team.id, id);
    rt.broadcast(team.id, { type: 'message', message: msg });
    return msg;
  }

  // ---------- long poll ----------
  async function poll({ res, url, team, auth, member, id, draining }) {
    requireRole(member, ['owner', 'member']);
    ownedAgent(team, auth.user, id);
    const seconds = Number(url.searchParams.get('wait') || 0);
    if (!Number.isFinite(seconds) || seconds < 0) throw httpError(400, 'wait must be a non-negative number');
    const p = rt.presenceOf(team.id, id);
    const wasOnline = rt.online(p);
    p.lastSeen = Date.now();
    if (!wasOnline) broadcastAgents(team.id);
    const wait = Math.min(seconds, 30) * 1000;
    let gone = res.destroyed, box = [], restored = false;
    // Messages taken for a client that disconnected before receiving them go back into the inbox.
    const restore = () => {
      if (restored || !box.length || rt.currentPresence(team.id, id) !== p) return;
      restored = true;
      repo.tx(() => { for (const m of box) repo.enqueue(team.id, id, m.id); });
    };
    res.on('close', () => { if (!res.writableFinished) { gone = true; restore(); } });
    box = repo.takeInbox(team.id, id);
    if (!box.length && wait && !gone && !draining()) {
      const release = limits.streams.acquire(auth.user.id);
      try { await rt.wait(team.id, id, wait, res); } finally { release(); }
      if (gone) return;
      if (draining()) return send(res, 200, []);
      if (rt.currentPresence(team.id, id) !== p || !repo.agent(team.id, id)) throw httpError(404, 'agent was removed');
      if (!stillValid(repo, auth)) throw httpError(401, 'token was rotated');
      const now = repo.member(team.id, auth.user.id);
      if (!now) throw httpError(404, 'unknown team');
      requireRole(now, ['owner', 'member']);
      p.lastSeen = Date.now();
      box = repo.takeInbox(team.id, id);
    }
    if (gone) { restore(); return; }
    send(res, 200, box);
  }

  // ---------- routes ----------
  // ctx: { req, res, url, path, readBody, draining }
  async function handle(ctx) {
    const { req, res, url, path: p } = ctx;
    const sessionDays = config.sessionDays;
    const publicInvite = /^\/api\/invites\/([a-f0-9]+)(\/accept)?$/.exec(p);
    const publicLogin = /^\/api\/login\/([a-f0-9]+)$/.exec(p);
    const isPublic = !!(publicInvite || publicLogin);
    if (isPublic) limits.public.take(`ip:${ctx.ip}`);
    // Authenticate before reading bodies, then again after the await to honor revocations.
    let auth = authenticate(req, url, repo, { optional: isPublic, sessionDays });
    if (auth) (req.method === 'GET' ? limits.reads : limits.writes).take(`user:${auth.user.id}`);
    const b = ['POST', 'PATCH'].includes(req.method) ? await ctx.readBody() : {};
    auth = authenticate(req, url, repo, { optional: isPublic, sessionDays });
    let user = auth?.user || null;
    ctx.userId = user?.id;

    // Exchange a one-time sign-in link for a browser session token.
    if (publicLogin && req.method === 'POST') {
      const token = newToken();
      const owner = repo.tx(() => {
        const userId = repo.takeLoginCode(hashToken(publicLogin[1]));
        const found = userId && repo.userById(userId);
        if (found) repo.createSession(found.id, hashToken(token), String(b.label || 'browser').slice(0, 60));
        return found;
      });
      if (!owner) throw httpError(404, 'this sign-in link is invalid, expired or already used');
      revalidateStreams(); // the session cap may have evicted an older browser
      return send(res, 200, { token, user: publicUser(owner) });
    }
    if (publicInvite) {
      const found = repo.findInvite(publicInvite[1]);
      if (!found) throw httpError(404, 'invalid invite');
      const { team, invite } = found;
      if (!publicInvite[2] && req.method === 'GET') return send(res, 200, {
        teamName: team.name, role: invite.role, invitedBy: invite.createdBy ? repo.userById(invite.createdBy)?.handle || null : null, expiresAt: invite.expiresAt,
      });
      if (publicInvite[2] && req.method === 'POST') {
        let token;
        const joined = repo.tx(() => {
          if (!user) {
            if (typeof b.handle !== 'string' || !HANDLE.test(b.handle)) throw httpError(400, 'invalid handle');
            if (repo.userByHandle(b.handle)) throw httpError(409, 'handle already exists');
            const name = b.name === undefined ? b.handle : validName(b.name);
            token = newToken();
            user = repo.createUser({ handle: b.handle, name, tokenHash: hashToken(token) });
          }
          if (repo.member(team.id, user.id)) return false;
          // Re-check inside the transaction: two people may race for the last use.
          if (!repo.findInvite(invite.code)) throw httpError(404, 'invalid invite');
          repo.addMember(team.id, user.id, invite.role);
          repo.useInvite(invite.code);
          if (invite.createdBy === null) repo.claimOwnerless(team.id, user.id);
          return true;
        });
        if (joined) { broadcastMembers(team.id); broadcastAgents(team.id); }
        return send(res, 200, { ...(token ? { token } : {}), user: publicUser(user), team: publicTeam(team, user.id) });
      }
      throw httpError(404, 'no such endpoint');
    }

    if (p === '/api/me' && req.method === 'GET') return send(res, 200, { user: publicUser(user), teams: repo.teamsForUser(user.id) });
    if (p === '/api/me/login-link' && req.method === 'POST') {
      const code = newId() + newId() + newId() + newId().slice(0, 8);
      repo.createLoginCode(hashToken(code), user.id, Date.now() + LOGIN_TTL_MS);
      return send(res, 200, { code, url: `${publicUrl()}/#login/${code}`, expiresInSeconds: LOGIN_TTL_MS / 1000 });
    }
    if (p === '/api/me/logout' && req.method === 'POST') {
      if (!auth.sessionHash) throw httpError(400, "that's your main token; rotate it instead (POST /api/me/token)");
      repo.deleteSession(auth.sessionHash);
      // Close what this browser still has open; the user's other credentials keep working.
      revalidateStreams();
      rt.wakeIf(ownedBy(user.id));
      return send(res, 200, { ok: true });
    }
    if (p === '/api/me/token' && req.method === 'POST') {
      // Rotating the main token also signs out every browser session.
      const token = newToken();
      repo.setToken(user.id, hashToken(token));
      closeUser(user.id);
      return send(res, 200, { token });
    }
    if (p === '/api/teams' && req.method === 'POST') {
      const team = repo.createTeam(validName(b.name), user.id);
      return send(res, 200, { team: publicTeam(team, user.id) });
    }

    const route = /^\/api\/teams\/([a-f0-9]+)(\/.*)?$/.exec(p);
    const team = route && repo.teamById(route[1]);
    const member = team && repo.member(team.id, user.id);
    if (!member) throw httpError(404, 'unknown team');
    const rest = route[2] || '/';
    let m;

    if (rest === '/' && req.method === 'GET') return send(res, 200, publicTeam(team, user.id));
    if (rest === '/' && req.method === 'PATCH') {
      requireRole(member, ['owner']);
      const name = b.name === undefined ? team.name : validName(b.name);
      const maxHops = b.maxHops === undefined ? team.maxHops : b.maxHops;
      if (!Number.isInteger(maxHops) || maxHops < 1 || maxHops > 50) throw httpError(400, 'maxHops must be a whole number from 1 to 50');
      repo.updateTeam(team.id, { name, maxHops });
      Object.assign(team, { name, maxHops });
      rt.broadcast(team.id, { type: 'config', config: teamConfig(team) });
      return send(res, 200, publicTeam(team, user.id));
    }
    if (rest === '/members' && req.method === 'GET') return send(res, 200, members(team.id));
    if ((m = /^\/members\/([a-f0-9]+)$/.exec(rest)) && ['PATCH', 'DELETE'].includes(req.method)) {
      if (req.method !== 'DELETE' || m[1] !== user.id) requireRole(member, ['owner']);
      const target = repo.member(team.id, m[1]);
      if (!target) throw httpError(404, 'unknown member');
      if (req.method === 'PATCH' && !ROLES.includes(b.role)) throw httpError(400, 'invalid role');
      if (target.role === 'owner' && (req.method === 'DELETE' || b.role !== 'owner') && repo.ownerCount(team.id) === 1) {
        throw httpError(403, 'the last owner cannot be demoted or removed');
      }
      if (req.method === 'DELETE') {
        const removed = repo.tx(() => {
          const ids = repo.agentIdsOf(team.id, target.userId);
          for (const id of ids) repo.deleteAgent(team.id, id);
          repo.removeMember(team.id, target.userId);
          return ids;
        });
        for (const id of removed) rt.forget(team.id, id);
      } else repo.setRole(team.id, target.userId, b.role);
      closeUser(target.userId, team.id);
      broadcastMembers(team.id); broadcastAgents(team.id);
      return send(res, 200, { ok: true });
    }
    if (rest === '/invites') {
      requireRole(member, ['owner']);
      if (req.method === 'GET') return send(res, 200, repo.activeInvites(team.id).map((i) => ({ ...i, url: `${publicUrl()}/#join/${i.code}` })));
      if (req.method === 'POST') {
        const { role = 'member', expiresInHours = 168, uses = 1 } = b;
        if (!ROLES.includes(role)) throw httpError(400, 'invalid role');
        if (typeof expiresInHours !== 'number' || !Number.isFinite(expiresInHours) || expiresInHours <= 0 || expiresInHours > 24 * 365) throw httpError(400, 'invalid expiry');
        if (!Number.isSafeInteger(uses) || uses < 1 || uses > 1000) throw httpError(400, 'uses must be a whole number from 1 to 1000');
        const invite = repo.createInvite(team.id, role, user.id, expiresInHours, uses);
        return send(res, 200, { ...invite, url: `${publicUrl()}/#join/${invite.code}` });
      }
    }
    if ((m = /^\/invites\/([a-f0-9]+)$/.exec(rest)) && req.method === 'DELETE') {
      requireRole(member, ['owner']);
      if (!repo.deleteInvite(team.id, m[1])) throw httpError(404, 'unknown invite');
      return send(res, 200, { ok: true });
    }
    if (rest === '/events' && req.method === 'GET') {
      const release = limits.streams.acquire(user.id);
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      res.write(`data: ${JSON.stringify({ type: 'hello', agents: agentList(team.id), config: teamConfig(team), members: members(team.id), role: member.role })}\n\n`);
      res.on('close', release);
      rt.addClient({ res, teamId: team.id, userId: user.id, auth });
      return;
    }
    if (rest === '/agents' && req.method === 'GET') return send(res, 200, agentList(team.id));
    if (rest === '/agents' && req.method === 'POST') {
      requireRole(member, ['owner', 'member']);
      const id = String(b.id || '').toLowerCase();
      if (!HANDLE.test(id) || id === 'human') throw httpError(400, 'id must be a handle; "human" is reserved');
      const prev = repo.agent(team.id, id);
      if (prev && prev.ownerUserId !== user.id) throw httpError(409, 'agent belongs to another user');
      const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : null);
      const agent = { id, teamId: team.id, ownerUserId: user.id, name: str(b.name, 200) || id, backend: str(b.backend, 40) || 'unknown',
        model: str(b.model, 100), owner: str(b.owner, 200), description: str(b.description, 2000) || '', kind: b.kind === 'session' ? 'session' : 'agent',
        access: b.access === 'write' ? 'write' : 'read', repo: str(b.repo, 200), skills: Array.isArray(b.skills) ? b.skills.slice(0, 50) : [],
        registeredAt: prev?.registeredAt || Date.now() };
      repo.saveAgent(agent);
      rt.presenceOf(team.id, id).lastSeen = Date.now();
      broadcastAgents(team.id);
      return send(res, 200, publicAgent(repo.agent(team.id, id)));
    }
    if ((m = /^\/agents\/([\w-]+)(?:\/(card|inbox|status|requeue))?$/.exec(rest))) {
      const a = repo.agent(team.id, m[1]);
      if (!a) throw httpError(404, 'unknown agent');
      if (!m[2] && req.method === 'DELETE') {
        requireRole(member, ['owner', 'member']);
        if (member.role !== 'owner') ownedAgent(team, user, a.id);
        removeAgent(team.id, a.id); broadcastAgents(team.id);
        return send(res, 200, { ok: true });
      }
      if (m[2] === 'card' && req.method === 'GET') return send(res, 200, agentCard(a));
      if (m[2] === 'inbox' && req.method === 'GET') return await poll({ res, url, team, auth, member, id: a.id, draining: ctx.draining });
      if (['status', 'requeue'].includes(m[2]) && req.method === 'POST') {
        requireRole(member, ['owner', 'member']); ownedAgent(team, user, a.id);
        if (m[2] === 'requeue') {
          if (!Array.isArray(b.ids) || b.ids.length > 5000 || b.ids.some((id) => typeof id !== 'string')) throw httpError(400, 'ids must be an array');
          const queued = new Set(repo.inbox(team.id, a.id).map((x) => x.id));
          const back = [...new Set(b.ids)].map((id) => repo.message(id))
            .filter((msg) => msg?.teamId === team.id && msg.to?.includes(a.id) && !msg.note && !queued.has(msg.id));
          repo.tx(() => { for (const msg of back) repo.enqueue(team.id, a.id, msg.id); });
          rt.wake(team.id, a.id);
          return send(res, 200, { requeued: back.length });
        }
        if (b.threadId && (typeof b.threadId !== 'string' || !repo.threadExists(team.id, b.threadId))) throw httpError(404, 'unknown thread');
        const pr = rt.presenceOf(team.id, a.id);
        pr.state = ['working', 'approval'].includes(b.state) ? b.state : 'idle';
        pr.stateThread = pr.state === 'idle' ? null : b.threadId || null;
        pr.lastSeen = Date.now();
        rt.broadcast(team.id, { type: 'status', id: a.id, state: pr.state, threadId: pr.stateThread });
        return send(res, 200, { ok: true });
      }
    }
    if (rest === '/messages' && req.method === 'POST') {
      requireRole(member, ['owner', 'member']); return send(res, 200, postMessage(team, user, b));
    }
    if (rest === '/messages' && req.method === 'GET') return send(res, 200, repo.recentMessages(team.id, 5000));
    if (rest === '/threads' && req.method === 'GET') return send(res, 200, repo.threadSummaries(team.id));
    if ((m = /^\/threads\/([\w-]+)$/.exec(rest)) && req.method === 'GET') {
      const thread = repo.threadMessages(team.id, m[1]);
      if (!thread.length) throw httpError(404, 'unknown thread');
      return send(res, 200, thread);
    }
    throw httpError(404, 'no such endpoint');
  }
  handle.broadcastAgents = broadcastAgents;
  handle.revalidateStreams = revalidateStreams;
  return handle;
}

export function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}
