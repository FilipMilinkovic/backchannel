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
    sessionByHash: (hash) => get('SELECT hash, user_id AS userId, label, created_at AS createdAt, last_used_at AS lastUsedAt FROM sessions WHERE hash = ?', hash),
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
    createSession: (userId, hash, label) => db.tx(() => {
      const now = Date.now();
      run('INSERT INTO sessions (hash, user_id, label, created_at, last_used_at) VALUES (?, ?, ?, ?, ?)', hash, userId, label, now, now);
      run(`DELETE FROM sessions WHERE user_id = ? AND hash NOT IN
             (SELECT hash FROM sessions WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ${MAX_SESSIONS})`, userId, userId);
    }),
    touchSession: (hash, at) => run('UPDATE sessions SET last_used_at = ? WHERE hash = ?', at, hash),
    deleteSession: (hash) => run('DELETE FROM sessions WHERE hash = ?', hash),
    pruneSessions: (usedBefore) => run('DELETE FROM sessions WHERE last_used_at < ?', usedBefore).changes,

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
    agentIdsOf: (teamId, userId) => all('SELECT id FROM agents WHERE team_id = ? AND owner_user_id = ?', teamId, userId).map((r) => r.id),
    claimOwnerless: (teamId, userId) => run('UPDATE agents SET owner_user_id = ? WHERE team_id = ? AND owner_user_id IS NULL', userId, teamId),

    // ---------- messages and inboxes ----------
    insertMessage: (m) => run('INSERT INTO messages (id, team_id, thread_id, ts, body) VALUES (?, ?, ?, ?, ?)', m.id, m.teamId, m.threadId, m.ts, JSON.stringify(m)),
    message: (id) => toMessage(get('SELECT body FROM messages WHERE id = ?', id)),
    recentMessages: (teamId, limit) => all(`SELECT body FROM (SELECT seq, body FROM messages WHERE team_id = ? ORDER BY seq DESC LIMIT ?) ORDER BY seq`, teamId, limit).map(toMessage),
    threadMessages: (teamId, threadId) => all('SELECT body FROM messages WHERE team_id = ? AND thread_id = ? ORDER BY seq', teamId, threadId).map(toMessage),
    threadExists: (teamId, threadId) => !!get('SELECT 1 AS x FROM messages WHERE team_id = ? AND thread_id = ? LIMIT 1', teamId, threadId),
    threadSummaries(teamId) {
      const map = new Map();
      for (const { threadId, ts, from, text } of all(`SELECT thread_id AS threadId, ts, json_extract(body, '$.from') AS "from",
          json_extract(body, '$.text') AS text FROM messages WHERE team_id = ? ORDER BY seq`, teamId)) {
        const t = map.get(threadId) || { id: threadId, title: String(text).slice(0, 80), started: ts, updated: ts, count: 0, participants: new Set() };
        t.updated = ts; t.count++; t.participants.add(from);
        map.set(threadId, t);
      }
      return [...map.values()].map((t) => ({ ...t, participants: [...t.participants] })).sort((a, b) => b.updated - a.updated);
    },

    // Inboxes are delivered in the order messages were posted. A no-op if the agent is gone.
    enqueue: (teamId, agentId, messageId) => run(`INSERT OR IGNORE INTO inbox (team_id, agent_id, message_id)
      SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM agents WHERE team_id = ? AND id = ?)`, teamId, agentId, messageId, teamId, agentId),
    inbox: (teamId, agentId) => all(`SELECT m.body FROM inbox i JOIN messages m ON m.id = i.message_id
      WHERE i.team_id = ? AND i.agent_id = ? ORDER BY m.seq`, teamId, agentId).map(toMessage),
    // Hands the whole inbox over and empties it.
    takeInbox(teamId, agentId) {
      return db.tx(() => {
        const box = this.inbox(teamId, agentId);
        if (box.length) run('DELETE FROM inbox WHERE team_id = ? AND agent_id = ?', teamId, agentId);
        return box;
      });
    },
  };
}
