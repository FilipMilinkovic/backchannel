// The hub API (see docs/TEAMS-PLAN.md): accounts, invites, teams, members, agents, messages, threads, live events.
import crypto from 'node:crypto';
import { HANDLE, ROLES, newId, newToken, hashToken, publicUser, httpError, authenticate, stillValid, requireRole } from './auth.js';
import { cleanRemote } from './util.js';
import { buildThread, present } from './threads.js';
import { parseScopes, scopedRoute, ownsHandle, MAX_SCOPED_TOKENS } from './scopes.js';

const LOGIN_TTL_MS = 60_000;
// After this many takes that never got an answer or an acknowledgement, a message is dropped from the inbox.
export const MAX_ATTEMPTS = 3;
const MAX_ATTACHMENTS = 20;
const FILE_PATH = /^\/api\/teams\/[a-f0-9]+\/files$/;

// A file name safe to store and to put in a download header: no folders, control characters or quotes.
function fileName(raw) {
  const base = String(raw || '').split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f"]/g, '').trim().slice(0, 200);
  return base && base !== '.' && base !== '..' ? base : 'file';
}
const fileType = (raw) => {
  const t = String(raw || '').split(';')[0].trim().toLowerCase();
  return /^[a-z0-9][\w.+-]*\/[\w.+-]+$/.test(t) && t.length <= 100 ? t : 'application/octet-stream';
};
const fileView = ({ id, name, type, size }) => ({ id, name, type, size });

export function createApi({ repo, rt, config, publicUrl, limits }) {
  // A message a connector or stand-in took stays leased this long, renewed while the agent reports it's working.
  const LEASE_MS = config.inboxLeaseSeconds * 1000;
  // ---------- views ----------
  const members = (teamId) => repo.members(teamId);
  const publicTeam = (team, userId) => ({ id: team.id, name: team.name, role: repo.member(team.id, userId)?.role,
    maxHops: team.maxHops, members: members(team.id) });
  const teamConfig = (team) => ({ name: team.name, maxHops: team.maxHops, tokenRequired: true });
  function publicAgent({ scopedBy, ...a }) {
    const p = rt.presenceOf(a.teamId, a.id);
    return { ...a, ...(scopedBy ? { scoped: true } : {}), state: p.state, stateThread: p.stateThread, lastSeen: p.lastSeen,
      ownerHandle: a.ownerUserId ? repo.userById(a.ownerUserId)?.handle || null : null, online: rt.online(p),
      ...(a.kind === 'session' ? { standIn: repo.standIn(a.teamId, a.id) } : {}) };
  }
  const agentList = (teamId) => repo.agents(teamId).map(publicAgent);

  // ---------- thread summaries ----------
  function threadView(teamId) {
    const agents = repo.agents(teamId);
    const ids = new Set(agents.map((a) => a.id));
    const live = new Map(); // threadId -> states of online agents working in it
    for (const a of agents) {
      const p = rt.presenceOf(teamId, a.id);
      if (rt.online(p) && p.state !== 'idle' && p.stateThread) live.set(p.stateThread, [...(live.get(p.stateThread) || []), p.state]);
    }
    return (row) => present(row, { isAgent: (id) => ids.has(id), live: live.get(row.id) || [] });
  }
  // Rebuilds a thread's stored summary from its messages; call inside the transaction that changed them.
  function rebuildThread(teamId, threadId) {
    const ids = new Set(repo.agents(teamId).map((a) => a.id));
    repo.saveThread(teamId, threadId, buildThread(repo.threadMessages(teamId, threadId), (id) => ids.has(id)));
  }
  const broadcastThread = (teamId, threadId) => {
    const row = repo.thread(teamId, threadId);
    if (row) rt.broadcast(teamId, { type: 'thread', thread: threadView(teamId)(row) });
  };
  const broadcastAgents = (teamId) => rt.broadcast(teamId, { type: 'agents', agents: agentList(teamId) });
  const broadcastMembers = (teamId) => rt.broadcast(teamId, { type: 'members', members: members(teamId) });
  function agentCard(a) {
    return { protocolVersion: 'agent-network/0.1 (A2A-shaped)', name: a.name, description: a.description,
      url: `${publicUrl()}/api/teams/${a.teamId}/agents/${a.id}`, version: '0.1.0', provider: { organization: a.owner || 'unknown' },
      capabilities: { streaming: false, pushNotifications: false }, 'x-persistent': !!a.persistent, 'x-always-on': !!a.service, defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain'],
      skills: a.skills?.length ? a.skills : [{ id: 'chat', name: 'Chat', description: a.description || 'General conversation' }],
      'x-backend': a.backend, 'x-handle': `@${a.id}`, 'x-repos': a.repos || [] };
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
  function disconnectAgent(teamId, id, userId) { repo.disconnectAgent(teamId, id, userId); rt.forget(teamId, id); }
  // A missing agent: 410 when someone disconnected it (its process should stop, not register again), otherwise 404.
  function missingAgent(teamId, id) {
    const d = repo.disconnected(teamId, id);
    if (!d) return httpError(404, 'unknown agent');
    const by = d.byUserId && repo.userById(d.byUserId);
    return httpError(410, `@${id} was disconnected from this team${by ? ` by ${by.name || by.handle}` : ''}. Start it again to reconnect.`);
  }
  function validName(name) {
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 200) throw httpError(400, 'name must be 1 to 200 characters');
    return name.trim();
  }
  function ownedAgent(team, user, id) {
    const agent = repo.agent(team.id, id);
    if (!agent) throw missingAgent(team.id, id);
    if (agent.ownerUserId !== user.id) throw httpError(403, 'agent belongs to another user');
    return agent;
  }

  // A scoped token in `team`. Its agents are the ones it registered itself (`scopedBy` is the token's id), never the
  // account's other agents, even under the same prefix. It reads every thread (read: 'team') or only its agents'.
  function scopeFor(team, user, scopes, tokenId) {
    const owns = (a) => !!a && a.ownerUserId === user.id && a.scopedBy === tokenId && ownsHandle(scopes, a.id);
    if (scopes.read === 'team') return { scopes, tokenId, owns, canReadRow: () => true, canRead: () => true };
    let own = null; // its agents, looked up once per request
    const canReadRow = (row) => {
      own ||= new Set(repo.agents(team.id).filter(owns).map((a) => a.id));
      return row.participants.some((h) => own.has(h));
    };
    const seen = new Map();
    const canRead = (threadId) => {
      if (!seen.has(threadId)) { const row = repo.thread(team.id, threadId); seen.set(threadId, !!row && canReadRow(row)); }
      return seen.get(threadId);
    };
    return { scopes, tokenId, owns, canReadRow, canRead };
  }

  // ---------- messages ----------
  function leadingMentions(text) {
    const out = [];
    const re = /^[\s,:;]*@([a-zA-Z][\w-]*)/;
    let rest = text, m;
    while ((m = rest.match(re))) { out.push(m[1].toLowerCase()); rest = rest.slice(m[0].length); }
    return [...new Set(out)];
  }
  // `scope` is set for scoped tokens: { scopes, canRead(threadId) }.
  function postMessage(team, user, b, scope = null) {
    if (typeof b.text !== 'string' || !b.text.trim()) throw httpError(400, 'text is required');
    if (b.text.length > 200_000) throw httpError(413, 'text is too long (max 200000 characters)');
    if (b.title !== undefined && (typeof b.title !== 'string' || b.title.trim().length > 120)) {
      throw httpError(400, 'title must be a string of at most 120 characters');
    }
    const text = b.text.trim();
    const fromKind = b.from === undefined ? 'user' : 'agent';
    const from = fromKind === 'user' ? user.handle : String(b.from).toLowerCase();
    if (fromKind === 'agent') ownedAgent(team, user, from);
    if (scope && (fromKind !== 'agent' || !scope.owns(repo.agent(team.id, from)))) {
      throw httpError(403, `this token posts only as its own agents (${scope.scopes.agents}…)`);
    }
    if (b.to !== undefined && (!Array.isArray(b.to) || b.to.length > 50 || b.to.some((id) => typeof id !== 'string' || !HANDLE.test(id.toLowerCase())))) {
      throw httpError(400, 'to must be an array of handles');
    }
    if (b.threadId !== undefined && b.threadId !== null && typeof b.threadId !== 'string') throw httpError(400, 'threadId must be a string');
    if (b.inReplyTo !== undefined && b.inReplyTo !== null && typeof b.inReplyTo !== 'string') throw httpError(400, 'inReplyTo must be a string');
    if (b.files !== undefined && (!Array.isArray(b.files) || b.files.length > MAX_ATTACHMENTS || b.files.some((f) => typeof f !== 'string'))) {
      throw httpError(400, `files must be an array of at most ${MAX_ATTACHMENTS} file ids`);
    }
    // A scoped token attaches only files it could download: ones in threads it reads, or not attached anywhere yet (its
    // own uploads). Otherwise attaching a file to its own thread would make any file readable to it.
    const attachable = (f) => {
      if (!scope) return true;
      const ids = repo.fileThreadIds(team.id, f.id);
      return !ids.length || ids.some(scope.canRead);
    };
    const files = [...new Set(b.files || [])].map((fid) => {
      const f = repo.file(team.id, fid);
      if (!f || !attachable(f)) throw httpError(404, `unknown file ${fid}`);
      return f;
    });
    let parent = b.inReplyTo ? repo.message(b.inReplyTo) : null;
    if (b.inReplyTo && (!parent || parent.teamId !== team.id)) throw httpError(404, 'unknown parent message');
    const thread = b.threadId ? repo.threadMessages(team.id, b.threadId) : null;
    if (b.threadId && !thread.length) throw httpError(404, 'unknown thread');
    if (parent && b.threadId && parent.threadId !== b.threadId) throw httpError(400, 'parent is in another thread');
    // A scoped token writes only into threads it can read.
    const into = b.threadId || parent?.threadId;
    if (scope && into && !scope.canRead(into)) throw httpError(404, b.threadId ? 'unknown thread' : 'unknown parent message');
    if (!parent && b.threadId) {
      parent = [...thread].reverse().find((m) => m.fromKind === 'agent'
        && repo.agent(team.id, m.from) && (fromKind !== 'agent' || m.from !== from)) || null;
    }
    const msg = { id: newId(), teamId: team.id, threadId: b.threadId || parent?.threadId || null,
      inReplyTo: parent?.id || null, from, fromKind, by: user.id, text, ts: Date.now(),
      hop: fromKind === 'agent' ? (parent?.hop ?? 0) + 1 : 0,
      // True when the sender answered a specific message (inReplyTo given), false for new requests and follow-ups.
      // Tells the UI whether a delegation is still waiting on someone.
      reply: !!b.inReplyTo };
    if (files.length) msg.files = files.map(fileView);
    if (b.kind === 'error' || b.kind === 'declined') msg.kind = b.kind;
    // A request for the agent's owner in person (approve a PR, make a decision): the agent passes it on without
    // running its model. An FYI asks nothing: nobody owes an answer, and agents don't run on it.
    if (b.kind === 'for-owner' || b.kind === 'fyi') {
      if (b.inReplyTo) throw httpError(400, `a ${b.kind} message starts a request; it can't answer one`);
      msg.kind = b.kind;
    }
    // An agent that can't finish without its owner: the delegation stays open, waiting on that person.
    if (b.kind === 'needs-owner' && fromKind === 'agent') {
      msg.kind = 'needs-owner';
      if (typeof b.needsOwner === 'string' && b.needsOwner.trim()) msg.needsOwner = b.needsOwner.trim().slice(0, 1000);
    }
    // The repository a request is about (ask_agent's `repo`), so the agent knows where to look or make the change.
    if (b.repo !== undefined && b.repo !== null) {
      if (typeof b.repo !== 'string' || b.repo.length > 200 || !/^\w[\w.-]*(?:\/\w[\w.-]*)*$/.test(b.repo)) throw httpError(400, 'repo must be a repository name');
      msg.repo = b.repo;
    }
    if (b.title !== undefined) msg.title = b.title.trim();
    if (!msg.threadId) msg.threadId = msg.id;
    let recipients = Array.isArray(b.to) ? b.to.map((id) => id.toLowerCase()) : leadingMentions(text);
    if (!Array.isArray(b.to) && !recipients.length && parent?.fromKind === 'agent') recipients = [parent.from];
    msg.to = [...new Set(recipients)].filter((id) => fromKind !== 'agent' || id !== from);
    if (scope) {
      if (msg.to.some((id) => !scope.scopes.postTo.includes(id))) {
        throw httpError(403, `this token can only message ${scope.scopes.postTo.map((h) => '@' + h).join(', ')}`);
      }
      if (!msg.to.length) throw httpError(400, 'a scoped token\'s message must be addressed to someone it may message');
      // Marks it for connectors: posted by the account, but not by its owner in person (responder.js fromOwner).
      msg.scoped = true;
    }
    const targets = msg.to.filter((id) => repo.agent(team.id, id));
    if (msg.hop >= team.maxHops && targets.length) {
      msg.note = `hop limit (${team.maxHops}) reached; not delivered. Post a new message to continue.`;
    }
    // New requests and follow-ups to someone else's agent count against a per-person hourly quota. An answer going back
    // to the agent that asked doesn't: the parent must be that agent's request (not one of its answers) addressed to the
    // sender, or naming any message from the agent would make follow-ups free.
    // (Addressed to the sender, or to an agent of theirs: an owner answering for their agent from the UI.)
    const answersAsk = msg.reply && parent && !parent.reply
      && (parent.to || []).some((h) => h === from || repo.agent(team.id, h)?.ownerUserId === user.id);
    if (!msg.note && limits.agentRequests) {
      for (const id of targets) {
        if (repo.agent(team.id, id).ownerUserId === user.id || (answersAsk && id === parent.from)) continue;
        try { limits.agentRequests.take(`${team.id}/${id}/${user.id}`); } catch (err) {
          const minutes = Math.max(1, Math.ceil((err.retryAfter || 60) / 60));
          throw Object.assign(httpError(429, `@${id} takes at most ${config.limits.agentRequestsPerHour} requests an hour from you. Try again in ${minutes} minute${minutes > 1 ? 's' : ''}.`), { retryAfter: err.retryAfter });
        }
      }
    }
    repo.tx(() => {
      repo.insertMessage(msg);
      if (!msg.note) for (const id of targets) repo.enqueue(team.id, id, msg.id);
      // An agent answering a message is done with it: its lease (if any) ends here.
      if (fromKind === 'agent' && parent) repo.ack(team.id, from, [parent.id]);
      rebuildThread(team.id, msg.threadId);
    });
    if (!msg.note) for (const id of targets) rt.wake(team.id, id);
    rt.broadcast(team.id, { type: 'message', message: msg });
    broadcastThread(team.id, msg.threadId);
    return msg;
  }

  // ---------- long poll ----------
  // Shared by both ways of reading an inbox: the caller must own the agent, and polling keeps it online.
  function checkIn({ url, team, auth, member, id }) {
    requireRole(member, ['owner', 'member']);
    ownedAgent(team, auth.user, id);
    const seconds = Number(url.searchParams.get('wait') || 0);
    if (!Number.isFinite(seconds) || seconds < 0) throw httpError(400, 'wait must be a non-negative number');
    const p = rt.presenceOf(team.id, id);
    const wasOnline = rt.online(p);
    p.lastSeen = Date.now();
    if (!wasOnline) broadcastAgents(team.id);
    return { p, wait: Math.min(seconds, 30) * 1000 };
  }
  // After waiting, the agent, the token and the caller's role must all still hold.
  function recheck({ team, auth, id }, p) {
    if (!repo.agent(team.id, id)) throw missingAgent(team.id, id);
    if (rt.currentPresence(team.id, id) !== p) throw httpError(404, 'agent was removed');
    if (!stillValid(repo, auth)) throw httpError(401, 'token was rotated');
    const now = repo.member(team.id, auth.user.id);
    if (!now) throw httpError(404, 'unknown team');
    requireRole(now, ['owner', 'member']);
    p.lastSeen = Date.now();
  }

  // Takes the whole inbox (connectors: one process per agent). With `?lease=1` (clients from 0.5.0) the messages are
  // leased: they stay until answered or acknowledged, and come back if the connector dies first.
  async function poll(ctx) {
    const { res, url, team, auth, id, draining } = ctx;
    const { p, wait } = checkIn(ctx);
    const leaseMs = url.searchParams.get('lease') === '1' ? LEASE_MS : 0;
    let gone = res.destroyed, box = [], restored = false;
    // Messages taken for a client that disconnected before receiving them go back into the inbox.
    const restore = () => {
      if (restored || !box.length || rt.currentPresence(team.id, id) !== p) return;
      restored = true;
      repo.requeue(team.id, id, box.map((m) => m.id));
    };
    res.on('close', () => { if (!res.writableFinished) { gone = true; restore(); } });
    box = repo.takeInbox(team.id, id, leaseMs);
    if (!box.length && wait && !gone && !draining()) {
      const release = limits.streams.acquire(limitKey(auth));
      try { await rt.wait(team.id, id, wait, res); } finally { release(); }
      if (gone) return;
      if (draining()) return send(res, 200, []);
      recheck(ctx, p);
      box = repo.takeInbox(team.id, id, leaseMs);
    }
    if (gone) { restore(); return; }
    send(res, 200, box);
  }

  // Shows the inbox without taking anything (live sessions). Several sessions can share a handle, e.g. one person's
  // open Claude Code windows; a message stays here until the session whose agent reads it claims it, rather than
  // going to whichever session happened to be polling. Answers at once when a message is newer than `after` (the
  // client's cursor), otherwise when the inbox changes (new message, or another session claimed one) or `wait` ends.
  async function pending(ctx) {
    const { res, url, team, auth, id, draining } = ctx;
    const after = Number(url.searchParams.get('after') || 0);
    if (!Number.isSafeInteger(after) || after < 0) throw httpError(400, 'after must be a non-negative integer');
    const { p, wait } = checkIn(ctx);
    let box = repo.peekInbox(team.id, id);
    if (!box.some((r) => r.seq > after) && wait && !res.destroyed && !draining()) {
      const release = limits.streams.acquire(limitKey(auth));
      try { await rt.wait(team.id, id, wait, res); } finally { release(); }
      if (res.destroyed) return;
      if (!draining()) recheck(ctx, p);
      box = repo.peekInbox(team.id, id);
    }
    if (res.destroyed) return;
    // The stand-in setting rides along, so a change in the UI reaches the session within one poll.
    send(res, 200, { cursor: Math.max(after, ...box.map((r) => r.seq)), messages: box.map((r) => r.message), standIn: repo.standIn(team.id, id) });
  }

  // Rate limits and open long polls are counted per person, except that each scoped token has budgets of its own,
  // so automation running on someone's account can't use up theirs.
  const limitKey = (auth) => (auth.scopes ? `token:${auth.sessionHash}` : `user:${auth.user.id}`);

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
    if (auth) (req.method === 'GET' ? limits.reads : limits.writes).take(limitKey(auth));
    const upload = req.method === 'POST' && FILE_PATH.test(p); // raw bytes, read once the team and role are checked
    const b = ['POST', 'PATCH'].includes(req.method) && !upload ? await ctx.readBody() : {};
    auth = authenticate(req, url, repo, { optional: isPublic, sessionDays });
    let user = auth?.user || null;
    ctx.userId = user?.id;
    const scopes = auth?.scopes || null;

    // Exchange a one-time sign-in link for a browser session token.
    if (publicLogin && req.method === 'POST') {
      const token = newToken();
      const owner = repo.tx(() => {
        const userId = repo.takeLoginCode(hashToken(publicLogin[1]));
        const found = userId && repo.userById(userId);
        if (found) repo.createSession(found.id, hashToken(token), String(b.label || 'browser').slice(0, 60), b.kind === 'cli' ? 'cli' : 'browser');
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
        if (scopes) throw httpError(403, "a scoped token can't join teams");
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
          // Someone else's agent already uses this handle here, and messages to the handle would reach it.
          const taken = repo.agent(team.id, user.handle);
          if (taken?.ownerUserId && taken.ownerUserId !== user.id) {
            throw httpError(409, `@${user.handle} is already an agent in "${team.name}"; ask a team owner to disconnect it`);
          }
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

    if (p === '/api/me' && req.method === 'GET') {
      const teams = repo.teamsForUser(user.id);
      return send(res, 200, scopes ? { user: publicUser(user), teams: teams.filter((t) => t.id === scopes.team), scopes }
        : { user: publicUser(user), teams });
    }
    // A scoped token uses its one team. Of the account it may only read who it is and sign itself out.
    if (scopes && !p.startsWith('/api/teams/') && !(p === '/api/me/logout' && req.method === 'POST')) {
      throw httpError(403, "this token is scoped and can't do that");
    }
    // Scoped tokens, for automation (server/scopes.js). Only a full sign-in can make, list or revoke them.
    if (p === '/api/me/scoped-tokens' && req.method === 'POST') {
      const wanted = parseScopes(b, repo.teamsForUser(user.id), { handle: user.handle, agentIdsIn: (teamId) => repo.agentIdsOf(teamId, user.id) });
      if (repo.scopedTokens(user.id).length >= MAX_SCOPED_TOKENS) throw httpError(409, `you have ${MAX_SCOPED_TOKENS} scoped tokens; revoke one first`);
      const label = typeof b.label === 'string' && b.label.trim() ? b.label.trim().slice(0, 60) : 'scoped token';
      const token = newToken();
      const hash = hashToken(token);
      repo.createSession(user.id, hash, label, 'cli', wanted);
      return send(res, 200, { token, id: hash.slice(0, 16), label, scopes: wanted });
    }
    if (p === '/api/me/scoped-tokens' && req.method === 'GET') return send(res, 200, repo.scopedTokens(user.id));
    const revoke = /^\/api\/me\/scoped-tokens\/([a-f0-9]{16})$/.exec(p);
    if (revoke && req.method === 'DELETE') {
      if (!repo.deleteScopedToken(user.id, revoke[1])) throw httpError(404, 'unknown scoped token');
      // Its long polls re-check their credential and end.
      rt.wakeIf(ownedBy(user.id));
      return send(res, 200, { ok: true });
    }
    if (p === '/api/me/login-link' && req.method === 'POST') {
      // 60 seconds by default (`backchannel open`); up to 10 minutes for setting up another computer.
      const ttl = b.expiresInSeconds === undefined ? LOGIN_TTL_MS / 1000 : b.expiresInSeconds;
      if (!Number.isInteger(ttl) || ttl < 10 || ttl > 600) throw httpError(400, 'expiresInSeconds must be a whole number from 10 to 600');
      const code = newId() + newId() + newId() + newId().slice(0, 8);
      repo.createLoginCode(hashToken(code), user.id, Date.now() + ttl * 1000);
      return send(res, 200, { code, url: `${publicUrl()}/#login/${code}`, expiresInSeconds: ttl });
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
    if (scopes && scopes.team !== team.id) throw httpError(404, 'unknown team');
    const rest = route[2] || '/';
    let m;
    // A scoped token: only the routes it's allowed (server/scopes.js), as its own agents, reading what it may read.
    const scope = scopes && scopeFor(team, user, scopes, auth.sessionHash.slice(0, 16));
    if (scope) {
      const { agent } = scopedRoute(scopes, req.method, rest);
      const acting = agent && repo.agent(team.id, agent);
      if (acting && !scope.owns(acting)) throw httpError(403, 'this token can only use agents it registered');
    }

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
      const release = limits.streams.acquire(limitKey(auth)); // the same budget as long polls
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
      if (scope && !ownsHandle(scopes, id)) throw httpError(403, `this token only runs agents named ${scopes.agents}…`);
      const prev = repo.agent(team.id, id);
      if (prev && prev.ownerUserId !== user.id) throw httpError(409, 'agent belongs to another user');
      if (scope && prev && !scope.owns(prev)) throw httpError(403, 'this token can only use agents it registered');
      // A person's handle is theirs: as an agent id it would pass for them in threads, and to older connectors, which match their owner by handle.
      const person = repo.userByHandle(id);
      if (person && person.id !== user.id) throw httpError(409, `@${id} is someone's handle; pick another id`);
      // A disconnected agent's handle stays its owner's while they're in the team, so nobody else picks up its messages.
      const gone = !prev && repo.disconnected(team.id, id);
      if (gone?.ownerUserId && gone.ownerUserId !== user.id && repo.member(team.id, gone.ownerUserId)) {
        throw httpError(409, 'agent belongs to another user');
      }
      // A process that was already connected (resume) stays stopped once disconnected; a fresh start reconnects.
      if (gone && b.resume === true) throw missingAgent(team.id, id);
      const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : null);
      // Repositories the agent works in, for its profile. Remotes lose any credentials before they're stored.
      const repos = (Array.isArray(b.repos) ? b.repos.slice(0, 20) : []).filter((r) => r && typeof r === 'object')
        .map((r) => ({ name: str(r.name, 200) || 'repo', path: str(r.path, 500), remote: cleanRemote(str(r.remote, 500)), branch: str(r.branch, 200) }));
      const agent = { id, teamId: team.id, ownerUserId: user.id, name: str(b.name, 200) || id, backend: str(b.backend, 40) || 'unknown',
        model: str(b.model, 100), owner: str(b.owner, 200), description: str(b.description, 2000) || '', kind: b.kind === 'session' ? 'session' : 'agent',
        access: b.access === 'write' ? 'write' : 'read', repo: str(b.repo, 200),
        // Agent Card skills, kept to their text fields: anything else would be stored and broadcast to the team as sent.
        skills: (Array.isArray(b.skills) ? b.skills.slice(0, 50) : []).filter((s) => s && typeof s === 'object')
          .map((s) => ({ id: str(s.id, 100) || 'skill', name: str(s.name, 200) || str(s.id, 100) || 'skill', description: str(s.description, 1000) || '' })),
        repos, workdir: str(b.workdir, 500), host: str(b.host, 100), platform: str(b.platform, 40), client: str(b.client, 40),
        approve: typeof b.approve === 'boolean' ? b.approve : null, persistent: b.persistent === true, service: b.service === true,
        connectedAt: Date.now(),
        // Which scoped token runs it, if one does (registering again with a full sign-in takes it back).
        ...(scope ? { scopedBy: scope.tokenId } : {}),
        registeredAt: prev?.registeredAt || Date.now() };
      repo.tx(() => { repo.clearDisconnect(team.id, id); repo.saveAgent(agent); });
      rt.presenceOf(team.id, id).lastSeen = Date.now();
      broadcastAgents(team.id);
      return send(res, 200, publicAgent(repo.agent(team.id, id)));
    }
    if ((m = /^\/agents\/([\w-]+)(?:\/(card|inbox|pending|status|requeue|claim|ack|activity))?$/.exec(rest))) {
      const a = repo.agent(team.id, m[1]);
      if (!a) throw missingAgent(team.id, m[1]);
      // Disconnect: removes the agent and stops its connector or live session. Its owner or a team owner can do it.
      if (!m[2] && req.method === 'DELETE') {
        requireRole(member, ['owner', 'member']);
        if (member.role !== 'owner') ownedAgent(team, user, a.id);
        disconnectAgent(team.id, a.id, user.id); broadcastAgents(team.id);
        return send(res, 200, { ok: true });
      }
      // Settings. The stand-in runs on its owner's computer, so only the owner chooses what it may do there.
      if (!m[2] && req.method === 'PATCH') {
        requireRole(member, ['owner', 'member']); ownedAgent(team, user, a.id);
        if (a.kind !== 'session') throw httpError(400, 'only live sessions have a stand-in');
        if (!['off', 'read', 'write'].includes(b.standIn)) throw httpError(400, 'standIn must be "off", "read" or "write"');
        repo.setStandIn(team.id, a.id, b.standIn, user.id);
        broadcastAgents(team.id);
        rt.wake(team.id, a.id); // the session's pending poll answers now, with the new setting
        return send(res, 200, publicAgent(repo.agent(team.id, a.id)));
      }
      if (m[2] === 'card' && req.method === 'GET') return send(res, 200, agentCard(a));
      // For the agent's profile: what it did, and the latest delegations it took part in.
      if (m[2] === 'activity' && req.method === 'GET') {
        const view = threadView(team.id);
        const rows = repo.threads(team.id).filter((t) => t.participants.includes(a.id));
        return send(res, 200, { ...repo.agentActivity(team.id, a.id), started: rows.filter((t) => t.from === a.id).length,
          threads: rows.slice(0, 8).map(view) });
      }
      if (m[2] === 'inbox' && req.method === 'GET') return await poll({ res, url, team, auth, member, id: a.id, draining: ctx.draining });
      if (m[2] === 'pending' && req.method === 'GET') return await pending({ res, url, team, auth, member, id: a.id, draining: ctx.draining });
      if (['status', 'requeue', 'claim', 'ack'].includes(m[2]) && req.method === 'POST') {
        requireRole(member, ['owner', 'member']); ownedAgent(team, user, a.id);
        const ids = () => {
          if (!Array.isArray(b.ids) || b.ids.length > 5000 || b.ids.some((id) => typeof id !== 'string')) throw httpError(400, 'ids must be an array');
          return [...new Set(b.ids)];
        };
        if (m[2] === 'claim') {
          // `lease` (seconds): keep the messages leased instead of removing them, e.g. while a stand-in answers.
          if (b.lease !== undefined && (!Number.isInteger(b.lease) || b.lease < 10 || b.lease > 3600)) throw httpError(400, 'lease must be a whole number of seconds from 10 to 3600');
          const messages = repo.claimInbox(team.id, a.id, ids(), (b.lease || 0) * 1000);
          if (messages.length) rt.wake(team.id, a.id); // other sessions sharing the handle drop them from their view
          return send(res, 200, { messages });
        }
        if (m[2] === 'ack') return send(res, 200, { acked: repo.ack(team.id, a.id, ids()) });
        if (m[2] === 'requeue') {
          const queued = new Set(repo.inbox(team.id, a.id).map((x) => x.id));
          const back = ids().map((id) => repo.message(id))
            .filter((msg) => msg?.teamId === team.id && msg.to?.includes(a.id) && !msg.note && !queued.has(msg.id));
          repo.requeue(team.id, a.id, back.map((msg) => msg.id));
          rt.wake(team.id, a.id);
          return send(res, 200, { requeued: back.length });
        }
        if (b.threadId && (typeof b.threadId !== 'string' || !repo.threadExists(team.id, b.threadId))) throw httpError(404, 'unknown thread');
        if (b.threadId && scope && !scope.canRead(b.threadId)) throw httpError(404, 'unknown thread');
        const pr = rt.presenceOf(team.id, a.id);
        pr.state = ['working', 'approval'].includes(b.state) ? b.state : 'idle';
        pr.stateThread = pr.state === 'idle' ? null : b.threadId || null;
        pr.lastSeen = Date.now();
        // Reporting work keeps whatever the agent took leased.
        if (pr.state !== 'idle') repo.extendLeases(team.id, a.id, Date.now() + LEASE_MS);
        rt.broadcast(team.id, { type: 'status', id: a.id, state: pr.state, threadId: pr.stateThread });
        return send(res, 200, { ok: true });
      }
    }
    if (rest === '/files' && upload) {
      requireRole(member, ['owner', 'member']);
      const max = config.maxFileMb * 1_048_576;
      const data = await ctx.readRaw(max);
      // Re-check after the upload: the token or membership may have been revoked meanwhile.
      auth = authenticate(req, url, repo, { sessionDays });
      requireRole(repo.member(team.id, auth.user.id) || { role: null }, ['owner', 'member']);
      if (!data.length) throw httpError(400, 'the file is empty');
      if (repo.teamFileBytes(team.id) + data.length > config.teamFilesMb * 1_048_576) {
        throw httpError(507, `this team's file storage is full (${config.teamFilesMb} MB)`);
      }
      const file = { id: crypto.randomBytes(12).toString('hex'), teamId: team.id, name: fileName(url.searchParams.get('name')),
        type: fileType(req.headers['content-type']), size: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex'),
        uploadedBy: auth.user.id, createdAt: Date.now(), data };
      repo.insertFile(file);
      return send(res, 200, { ...fileView(file), sha256: file.sha256 });
    }
    if ((m = /^\/files\/([a-f0-9]+)(\/info)?$/.exec(rest)) && req.method === 'GET') {
      const file = repo.file(team.id, m[1]);
      if (!file || (scope && !repo.fileThreadIds(team.id, file.id).some(scope.canRead))) throw httpError(404, 'unknown file');
      if (m[2]) return send(res, 200, { ...fileView(file), sha256: file.sha256, createdAt: file.createdAt });
      const data = repo.fileData(team.id, file.id);
      // Always a download, never rendered on the hub's origin.
      res.writeHead(200, { 'content-type': file.type, 'content-length': data.length, 'cache-control': 'private, no-store',
        'content-disposition': `attachment; filename="${file.name.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
        'content-security-policy': "default-src 'none'; sandbox" });
      return res.end(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
    }
    if (rest === '/messages' && req.method === 'POST') {
      requireRole(member, ['owner', 'member']); return send(res, 200, postMessage(team, user, b, scope));
    }
    if (rest === '/messages' && req.method === 'GET') {
      const recent = repo.recentMessages(team.id, 5000);
      return send(res, 200, scope ? recent.filter((msg) => scope.canRead(msg.threadId)) : recent);
    }
    // Delegations, newest first: `state=active|done` filters, `agent` keeps the ones it took part in, `limit` and
    // `before` (an item's cursor) page. Without `limit` every match is returned.
    if (rest === '/threads' && req.method === 'GET') {
      const q = url.searchParams;
      const state = q.get('state') || 'all';
      if (!['active', 'done', 'all'].includes(state)) throw httpError(400, 'state must be active, done or all');
      const limit = q.has('limit') ? Number(q.get('limit')) : Infinity;
      if (q.has('limit') && (!Number.isInteger(limit) || limit < 1 || limit > 500)) throw httpError(400, 'limit must be a whole number from 1 to 500');
      const before = q.get('before');
      const cut = before && /^(\d+):([\w-]+)$/.exec(before);
      if (before && !cut) throw httpError(400, 'before must be a cursor from an earlier page');
      const agent = q.get('agent');
      const view = threadView(team.id);
      const out = [];
      for (const row of repo.threads(team.id)) {
        if (cut && (row.updated > Number(cut[1]) || (row.updated === Number(cut[1]) && row.id >= cut[2]))) continue;
        if (agent && !row.participants.includes(agent)) continue;
        if (scope && !scope.canReadRow(row)) continue;
        const t = view(row);
        if (state !== 'all' && t.active !== (state === 'active')) continue;
        out.push(t);
        if (out.length >= limit) break;
      }
      return send(res, 200, out);
    }
    if (rest === '/threads/counts' && req.method === 'GET') {
      const view = threadView(team.id);
      const all = repo.threads(team.id).filter((row) => !scope || scope.canReadRow(row)).map(view);
      const active = all.filter((t) => t.active).length;
      return send(res, 200, { active, done: all.length - active, total: all.length });
    }
    if ((m = /^\/threads\/([\w-]+)\/summary$/.exec(rest)) && req.method === 'GET') {
      const row = repo.thread(team.id, m[1]);
      if (!row || (scope && !scope.canReadRow(row))) throw httpError(404, 'unknown thread');
      return send(res, 200, threadView(team.id)(row));
    }
    if ((m = /^\/threads\/([\w-]+)$/.exec(rest)) && req.method === 'GET') {
      const thread = repo.threadMessages(team.id, m[1]);
      if (!thread.length || (scope && !scope.canRead(m[1]))) throw httpError(404, 'unknown thread');
      return send(res, 200, thread);
    }
    throw httpError(404, 'no such endpoint');
  }
  handle.broadcastAgents = broadcastAgents;
  // Leases that ran out put their messages back (and wake the agent); ones that keep failing are dropped.
  handle.expireLeases = (log) => {
    const { back, dropped } = repo.expireLeases(Date.now(), MAX_ATTEMPTS);
    for (const k of new Set(back.map((r) => `${r.teamId}/${r.agentId}`))) { const [t, id] = k.split('/'); rt.wake(t, id); }
    for (const r of dropped) log?.warn('dropped a message nobody could answer', { teamId: r.teamId, agentId: r.agentId, messageId: r.messageId, attempts: MAX_ATTEMPTS });
    return { back: back.length, dropped: dropped.length };
  };
  handle.revalidateStreams = revalidateStreams;
  return handle;
}

export function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}
