// Data access. Every query the hub runs lives here; rows come back in the API's camelCase shapes.
import crypto from 'node:crypto';
import { newId } from './auth.js';

const MAX_SESSIONS = 20;
const plain = (row) => (row ? { ...row } : null);

export function createRepo(db) {
  const q = new Map();
  // Prepared statements are cached by their SQL text.
  const st = (sql) => { let s = q.get(sql); if (!s) { s = db.prepare(sql); q.set(sql, s); } return s; };
  const get = (sql, ...p) => plain(st(sql).get(...p));
  const all = (sql, ...p) => st(sql).all(...p).map(plain);
  const run = (sql, ...p) => st(sql).run(...p);

  const USER = 'SELECT id, handle, name, token_hash AS tokenHash, created_at AS createdAt FROM users';
  const TEAM = 'SELECT id, name, max_hops AS maxHops, created_at AS createdAt FROM teams';
  const INVITE = 'SELECT code, role, created_by AS createdBy, created_at AS createdAt, expires_at AS expiresAt, uses_left AS usesLeft, team_id AS teamId FROM invites';
  const toAgent = (r) => r && { ...JSON.parse(r.card), id: r.id, teamId: r.teamId, ownerUserId: r.ownerUserId, registeredAt: r.registeredAt };
  const AGENT = 'SELECT team_id AS teamId, id, owner_user_id AS ownerUserId, card, registered_at AS registeredAt FROM agents';
  const toMessage = (r) => r && JSON.parse(r.body);
  const inviteOut = ({ teamId, ...i }) => i;

  return {
    db,
    tx: db.tx,
    ping: () => get('SELECT 1 AS ok').ok === 1,

    // ---------- users and sessions ----------
    countUsers: () => get('SELECT count(*) AS n FROM users').n,
    userById: (id) => get(`${USER} WHERE id = ?`, id),
    userByHandle: (handle) => get(`${USER} WHERE handle = ?`, handle),
    userByTokenHash: (hash) => get(`${USER} WHERE token_hash = ?`, hash),
    sessionByHash: (hash) => get('SELECT hash, user_id AS userId, label, scopes, created_at AS createdAt, last_used_at AS lastUsedAt FROM sessions WHERE hash = ?', hash),
    createUser({ handle, name, tokenHash }) {
      const user = { id: newId(), handle, name, tokenHash, createdAt: Date.now() };
      run('INSERT INTO users (id, handle, name, token_hash, created_at) VALUES (?, ?, ?, ?, ?)', user.id, handle, name, tokenHash, user.createdAt);
      return user;
    },
    // Replaces the main token and signs out every browser session, including sign-in links not used yet.
    setToken: (userId, tokenHash) => db.tx(() => {
      run('UPDATE users SET token_hash = ? WHERE id = ?', tokenHash, userId);
      run('DELETE FROM sessions WHERE user_id = ?', userId);
      run('DELETE FROM login_codes WHERE user_id = ?', userId);
    }),
    // Browsers and computers (`backchannel login`) are capped separately, and the least recently used one goes first,
    // so opening many browsers never signs out a computer that runs connectors. Scoped tokens are never pushed out:
    // they're capped when they're made (MAX_SCOPED_TOKENS), and automation would break without warning.
    createSession: (userId, hash, label, kind = 'browser', scopes = null) => db.tx(() => {
      const now = Date.now();
      run('INSERT INTO sessions (hash, user_id, label, kind, created_at, last_used_at, scopes) VALUES (?, ?, ?, ?, ?, ?, ?)',
        hash, userId, label, kind, now, now, scopes && JSON.stringify(scopes));
      if (scopes) return;
      run(`DELETE FROM sessions WHERE user_id = ? AND kind = ? AND scopes IS NULL AND hash NOT IN
             (SELECT hash FROM sessions WHERE user_id = ? AND kind = ? AND scopes IS NULL ORDER BY last_used_at DESC, rowid DESC LIMIT ${MAX_SESSIONS})`, userId, kind, userId, kind);
    }),
    // An account's scoped tokens, by their public id (the first 16 characters of the stored hash).
    scopedTokens: (userId) => all(`SELECT substr(hash, 1, 16) AS id, label, scopes, created_at AS createdAt, last_used_at AS lastUsedAt
      FROM sessions WHERE user_id = ? AND scopes IS NOT NULL ORDER BY created_at, rowid`, userId).map((r) => ({ ...r, scopes: JSON.parse(r.scopes) })),
    deleteScopedToken: (userId, id) => run('DELETE FROM sessions WHERE user_id = ? AND scopes IS NOT NULL AND substr(hash, 1, 16) = ?', userId, id).changes,
    touchSession: (hash, at) => run('UPDATE sessions SET last_used_at = ? WHERE hash = ?', at, hash),
    deleteSession: (hash) => run('DELETE FROM sessions WHERE hash = ?', hash),
    // Scoped tokens are kept: they last until revoked.
    pruneSessions: (usedBefore) => run('DELETE FROM sessions WHERE last_used_at < ? AND scopes IS NULL', usedBefore).changes,

    // One-time sign-in codes are stored hashed; taking one deletes it.
    createLoginCode: (codeHash, userId, expiresAt) => {
      run('DELETE FROM login_codes WHERE expires_at <= ?', Date.now());
      run('INSERT INTO login_codes (code_hash, user_id, expires_at) VALUES (?, ?, ?)', codeHash, userId, expiresAt);
    },
    takeLoginCode: (codeHash) => db.tx(() => {
      const row = get('SELECT user_id AS userId, expires_at AS expiresAt FROM login_codes WHERE code_hash = ?', codeHash);
      if (row) run('DELETE FROM login_codes WHERE code_hash = ?', codeHash);
      return row && row.expiresAt > Date.now() ? row.userId : null;
    }),

    // ---------- teams and members ----------
    teamById: (id) => get(`${TEAM} WHERE id = ?`, id),
    firstTeam: () => get(`${TEAM} ORDER BY created_at, rowid LIMIT 1`),
    teamsForUser: (userId) => all(`SELECT t.id, t.name, m.role FROM members m JOIN teams t ON t.id = m.team_id
      WHERE m.user_id = ? ORDER BY m.joined_at, t.rowid`, userId),
    createTeam(name, userId = null, maxHops = 8) {
      const team = { id: newId(), name, maxHops, createdAt: Date.now() };
      db.tx(() => {
        run('INSERT INTO teams (id, name, max_hops, created_at) VALUES (?, ?, ?, ?)', team.id, name, maxHops, team.createdAt);
        if (userId) run('INSERT INTO members (team_id, user_id, role, joined_at, seq) VALUES (?, ?, ?, ?, 0)', team.id, userId, 'owner', team.createdAt);
      });
      return team;
    },
    updateTeam: (id, { name, maxHops }) => run('UPDATE teams SET name = ?, max_hops = ? WHERE id = ?', name, maxHops, id),
    members: (teamId) => all(`SELECT m.user_id AS userId, m.role, m.joined_at AS joinedAt, u.handle, u.name
      FROM members m JOIN users u ON u.id = m.user_id WHERE m.team_id = ? ORDER BY m.seq`, teamId),
    member: (teamId, userId) => get('SELECT user_id AS userId, role, joined_at AS joinedAt FROM members WHERE team_id = ? AND user_id = ?', teamId, userId),
    addMember: (teamId, userId, role) => run(`INSERT INTO members (team_id, user_id, role, joined_at, seq)
      VALUES (?, ?, ?, ?, (SELECT coalesce(max(seq), -1) + 1 FROM members WHERE team_id = ?))`, teamId, userId, role, Date.now(), teamId),
    setRole: (teamId, userId, role) => run('UPDATE members SET role = ? WHERE team_id = ? AND user_id = ?', role, teamId, userId),
    removeMember: (teamId, userId) => run('DELETE FROM members WHERE team_id = ? AND user_id = ?', teamId, userId),
    ownerCount: (teamId) => get("SELECT count(*) AS n FROM members WHERE team_id = ? AND role = 'owner'", teamId).n,

    // ---------- invites ----------
    activeInvites: (teamId) => all(`${INVITE} WHERE team_id = ? AND uses_left > 0 AND expires_at > ? ORDER BY created_at, rowid`, teamId, Date.now()).map(inviteOut),
    createInvite(teamId, role, createdBy, expiresInHours, uses) {
      const invite = { code: crypto.randomBytes(12).toString('hex'), role, createdBy, createdAt: Date.now(),
        expiresAt: Date.now() + expiresInHours * 3_600_000, usesLeft: uses };
      run('INSERT INTO invites (code, team_id, role, created_by, created_at, expires_at, uses_left) VALUES (?, ?, ?, ?, ?, ?, ?)',
        invite.code, teamId, role, createdBy, invite.createdAt, invite.expiresAt, uses);
      return invite;
    },
    findInvite(code) {
      const row = get(`${INVITE} WHERE code = ? AND uses_left > 0 AND expires_at > ?`, code, Date.now());
      return row && { team: get(`${TEAM} WHERE id = ?`, row.teamId), invite: inviteOut(row) };
    },
    useInvite: (code) => run('UPDATE invites SET uses_left = uses_left - 1 WHERE code = ?', code),
    deleteInvite: (teamId, code) => run('DELETE FROM invites WHERE team_id = ? AND code = ?', teamId, code).changes,
    // The owner invite printed at first start: reused across restarts until someone claims it.
    setupInvite() {
      const team = this.firstTeam() || this.createTeam('Backchannel');
      const found = get(`${INVITE} WHERE team_id = ? AND created_by IS NULL AND uses_left > 0 AND expires_at > ?`, team.id, Date.now());
      return found ? inviteOut(found) : this.createInvite(team.id, 'owner', null, 168, 1);
    },

    // ---------- agents ----------
    agents: (teamId) => all(`${AGENT} WHERE team_id = ? ORDER BY id`, teamId).map(toAgent),
    agent: (teamId, id) => toAgent(get(`${AGENT} WHERE team_id = ? AND id = ?`, teamId, id)),
    saveAgent({ teamId, id, ownerUserId, registeredAt, ...card }) {
      run(`INSERT INTO agents (team_id, id, owner_user_id, card, registered_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (team_id, id) DO UPDATE SET owner_user_id = excluded.owner_user_id, card = excluded.card`,
      teamId, id, ownerUserId, JSON.stringify(card), registeredAt);
    },
    deleteAgent: (teamId, id) => run('DELETE FROM agents WHERE team_id = ? AND id = ?', teamId, id),
    // Removes the agent and remembers who disconnected it, so its running process stops instead of re-registering,
    // and who owned it, so nobody else can take its handle.
    disconnectAgent: (teamId, id, byUserId) => db.tx(() => {
      const ownerUserId = get('SELECT owner_user_id AS o FROM agents WHERE team_id = ? AND id = ?', teamId, id)?.o ?? null;
      run('DELETE FROM agents WHERE team_id = ? AND id = ?', teamId, id);
      run(`INSERT INTO agent_disconnects (team_id, id, by_user_id, at, owner_user_id) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (team_id, id) DO UPDATE SET by_user_id = excluded.by_user_id, at = excluded.at, owner_user_id = excluded.owner_user_id`,
      teamId, id, byUserId, Date.now(), ownerUserId);
    }),
    disconnected: (teamId, id) => get('SELECT by_user_id AS byUserId, owner_user_id AS ownerUserId, at FROM agent_disconnects WHERE team_id = ? AND id = ?', teamId, id),
    clearDisconnect: (teamId, id) => run('DELETE FROM agent_disconnects WHERE team_id = ? AND id = ?', teamId, id),
    // A live session's stand-in: 'read' unless its owner chose otherwise.
    standIn: (teamId, id) => get('SELECT stand_in AS v FROM agent_settings WHERE team_id = ? AND id = ?', teamId, id)?.v || 'read',
    setStandIn: (teamId, id, value, byUserId) => run(`INSERT INTO agent_settings (team_id, id, stand_in, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (team_id, id) DO UPDATE SET stand_in = excluded.stand_in, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    teamId, id, value, byUserId, Date.now()),
    agentIdsOf: (teamId, userId) => all('SELECT id FROM agents WHERE team_id = ? AND owner_user_id = ?', teamId, userId).map((r) => r.id),
    claimOwnerless: (teamId, userId) => run('UPDATE agents SET owner_user_id = ? WHERE team_id = ? AND owner_user_id IS NULL', userId, teamId),

    // ---------- messages and inboxes ----------
    insertMessage: (m) => run('INSERT INTO messages (id, team_id, thread_id, ts, body) VALUES (?, ?, ?, ?, ?)', m.id, m.teamId, m.threadId, m.ts, JSON.stringify(m)),
    message: (id) => toMessage(get('SELECT body FROM messages WHERE id = ?', id)),
    recentMessages: (teamId, limit) => all(`SELECT body FROM (SELECT seq, body FROM messages WHERE team_id = ? ORDER BY seq DESC LIMIT ?) ORDER BY seq`, teamId, limit).map(toMessage),
    threadMessages: (teamId, threadId) => all('SELECT body FROM messages WHERE team_id = ? AND thread_id = ? ORDER BY seq', teamId, threadId).map(toMessage),
    threadExists: (teamId, threadId) => !!get('SELECT 1 AS x FROM messages WHERE team_id = ? AND thread_id = ? LIMIT 1', teamId, threadId),

    // ---------- thread summaries (server/threads.js) ----------
    // Newest first. Each row is the stored summary plus the thread's id and state.
    threads: (teamId) => all(`SELECT id, state, data FROM threads WHERE team_id = ? ORDER BY updated DESC, id DESC`, teamId)
      .map((r) => ({ ...JSON.parse(r.data), id: r.id, state: r.state })),
    thread: (teamId, id) => { const r = get('SELECT id, state, data FROM threads WHERE team_id = ? AND id = ?', teamId, id); return r && { ...JSON.parse(r.data), id: r.id, state: r.state }; },
    saveThread: (teamId, id, row) => run(`INSERT INTO threads (team_id, id, updated, data) VALUES (?, ?, ?, ?)
      ON CONFLICT (team_id, id) DO UPDATE SET updated = excluded.updated, data = excluded.data`, teamId, id, row.updated, JSON.stringify(row)),
    // What an agent did, for its profile: requests it got (threads), replies and messages it sent, the last one's time.
    agentActivity(teamId, agentId) {
      const sent = get(`SELECT count(*) AS n, max(ts) AS last,
          sum(CASE WHEN coalesce(json_extract(body, '$.reply'), json_extract(body, '$.inReplyTo') IS NOT NULL) THEN 1 ELSE 0 END) AS replies
        FROM messages WHERE team_id = ? AND json_extract(body, '$.from') = ?`, teamId, agentId);
      const received = get(`SELECT count(DISTINCT m.thread_id) AS n FROM messages m, json_each(json_extract(m.body, '$.to')) t
        WHERE m.team_id = ? AND t.value = ? AND json_extract(m.body, '$.from') != ?`, teamId, agentId, agentId).n;
      return { sent: sent.n, replies: sent.replies || 0, lastMessageAt: sent.last ?? null, received };
    },

    // ---------- files ----------
    // Metadata only; fileData() reads the bytes.
    insertFile: (f) => run('INSERT INTO files (id, team_id, name, type, size, sha256, uploaded_by, created_at, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      f.id, f.teamId, f.name, f.type, f.size, f.sha256, f.uploadedBy, f.createdAt, f.data),
    file: (teamId, id) => get(`SELECT id, name, type, size, sha256, uploaded_by AS uploadedBy, created_at AS createdAt
      FROM files WHERE team_id = ? AND id = ?`, teamId, id),
    fileData: (teamId, id) => get('SELECT data FROM files WHERE team_id = ? AND id = ?', teamId, id)?.data,
    // Threads a file is attached in (a scoped token may read a file only through a thread it can read). Scans the
    // team's messages; fine at today's sizes, and the place for an index on attachments if that changes.
    fileThreadIds: (teamId, fileId) => all(`SELECT DISTINCT m.thread_id AS id FROM messages m, json_each(json_extract(m.body, '$.files')) f
      WHERE m.team_id = ? AND json_extract(f.value, '$.id') = ?`, teamId, fileId).map((r) => r.id),
    teamFileBytes: (teamId) => get('SELECT coalesce(sum(size), 0) AS n FROM files WHERE team_id = ?', teamId).n,

    // Inboxes are delivered in the order messages were posted. A no-op if the agent is gone.
    enqueue: (teamId, agentId, messageId) => run(`INSERT OR IGNORE INTO inbox (team_id, agent_id, message_id)
      SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM agents WHERE team_id = ? AND id = ?)`, teamId, agentId, messageId, teamId, agentId),
    // Messages waiting to be taken. Leased ones (taken, not yet answered) are hidden until their lease runs out.
    inbox: (teamId, agentId) => all(`SELECT m.body FROM inbox i JOIN messages m ON m.id = i.message_id
      WHERE i.team_id = ? AND i.agent_id = ? AND i.leased_until IS NULL ORDER BY m.seq`, teamId, agentId).map(toMessage),
    // Hands the whole inbox over. With `leaseMs`, the messages stay until acknowledged (ack, or a reply to them) and
    // come back if the lease runs out; without it they're removed, as older clients expect.
    takeInbox(teamId, agentId, leaseMs = 0) {
      return db.tx(() => {
        const box = this.inbox(teamId, agentId);
        if (!box.length) return box;
        if (leaseMs) run(`UPDATE inbox SET leased_until = ?, attempts = attempts + 1
          WHERE team_id = ? AND agent_id = ? AND leased_until IS NULL`, Date.now() + leaseMs, teamId, agentId);
        else run('DELETE FROM inbox WHERE team_id = ? AND agent_id = ? AND leased_until IS NULL', teamId, agentId);
        return box;
      });
    },
    // The inbox left in place, with each message's position, for sessions that claim messages only when read.
    peekInbox: (teamId, agentId) => all(`SELECT m.seq, m.body FROM inbox i JOIN messages m ON m.id = i.message_id
      WHERE i.team_id = ? AND i.agent_id = ? AND i.leased_until IS NULL ORDER BY m.seq`, teamId, agentId).map((r) => ({ seq: r.seq, message: toMessage(r) })),
    // Takes the given messages and returns the ones that were still there, in order. Several sessions sharing a handle
    // may claim the same message; only one of them gets it. `leaseMs` works as in takeInbox.
    claimInbox(teamId, agentId, ids, leaseMs = 0) {
      const want = new Set(ids);
      const take = (id) => (leaseMs
        ? run(`UPDATE inbox SET leased_until = ?, attempts = attempts + 1 WHERE team_id = ? AND agent_id = ? AND message_id = ?
            AND leased_until IS NULL`, Date.now() + leaseMs, teamId, agentId, id)
        : run('DELETE FROM inbox WHERE team_id = ? AND agent_id = ? AND message_id = ? AND leased_until IS NULL', teamId, agentId, id)).changes === 1;
      return db.tx(() => this.peekInbox(teamId, agentId).filter(({ message: m }) => want.has(m.id) && take(m.id)).map((r) => r.message));
    },
    // Done with these: answered, or nothing to say. Returns how many were removed.
    ack: (teamId, agentId, ids) => db.tx(() => ids.reduce((n, id) =>
      n + Number(run('DELETE FROM inbox WHERE team_id = ? AND agent_id = ? AND message_id = ?', teamId, agentId, id).changes), 0)),
    // Puts messages back to be taken again: a lease is dropped, a removed message is queued again.
    requeue: (teamId, agentId, ids) => db.tx(() => {
      for (const id of ids) run(`INSERT INTO inbox (team_id, agent_id, message_id) SELECT ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM agents WHERE team_id = ? AND id = ?)
        ON CONFLICT (team_id, agent_id, message_id) DO UPDATE SET leased_until = NULL`, teamId, agentId, id, teamId, agentId);
    }),
    // The agent is still working: keep its leases from running out before `until`.
    extendLeases: (teamId, agentId, until) => run(`UPDATE inbox SET leased_until = ? WHERE team_id = ? AND agent_id = ?
      AND leased_until IS NOT NULL AND leased_until < ?`, until, teamId, agentId, until).changes,
    // Leases that ran out: the message goes back in the inbox, or, after `maxAttempts` takes, is dropped (something
    // about it keeps failing). Returns { back: [{ teamId, agentId }], dropped: [{ teamId, agentId, messageId }] }.
    expireLeases(now, maxAttempts) {
      return db.tx(() => {
        const due = all(`SELECT team_id AS teamId, agent_id AS agentId, message_id AS messageId, attempts FROM inbox
          WHERE leased_until IS NOT NULL AND leased_until <= ?`, now);
        const dropped = due.filter((r) => r.attempts >= maxAttempts);
        for (const r of dropped) run('DELETE FROM inbox WHERE team_id = ? AND agent_id = ? AND message_id = ?', r.teamId, r.agentId, r.messageId);
        run(`UPDATE inbox SET leased_until = NULL WHERE leased_until IS NOT NULL AND leased_until <= ? AND attempts < ?`, now, maxAttempts);
        return { back: due.filter((r) => r.attempts < maxAttempts), dropped };
      });
    },
  };
}
