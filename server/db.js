// SQLite storage (built-in node:sqlite): one file, WAL mode, forward-only migrations tracked in PRAGMA user_version.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readLegacy, LEGACY_FILES } from './legacy.js';

// Append only. Each entry moves the schema from version i to i + 1.
const MIGRATIONS = [
  `CREATE TABLE users (
     id TEXT PRIMARY KEY, handle TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
     token_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);
   CREATE TABLE sessions (
     hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     label TEXT NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL);
   CREATE INDEX sessions_user ON sessions(user_id);
   CREATE TABLE login_codes (
     code_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
   CREATE TABLE teams (id TEXT PRIMARY KEY, name TEXT NOT NULL, max_hops INTEGER NOT NULL, created_at INTEGER NOT NULL);
   CREATE TABLE members (
     team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     role TEXT NOT NULL CHECK (role IN ('owner', 'member', 'viewer')), joined_at INTEGER NOT NULL, seq INTEGER NOT NULL,
     PRIMARY KEY (team_id, user_id));
   CREATE INDEX members_user ON members(user_id);
   CREATE TABLE invites (
     code TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
     role TEXT NOT NULL CHECK (role IN ('owner', 'member', 'viewer')), created_by TEXT,
     created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, uses_left INTEGER NOT NULL);
   CREATE INDEX invites_team ON invites(team_id);
   CREATE TABLE agents (
     team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE, id TEXT NOT NULL, owner_user_id TEXT,
     card TEXT NOT NULL, registered_at INTEGER NOT NULL, PRIMARY KEY (team_id, id));
   CREATE TABLE messages (
     seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, team_id TEXT NOT NULL,
     thread_id TEXT NOT NULL, ts INTEGER NOT NULL, body TEXT NOT NULL);
   CREATE INDEX messages_team ON messages(team_id, seq);
   CREATE INDEX messages_thread ON messages(team_id, thread_id, seq);
   CREATE TABLE inbox (
     team_id TEXT NOT NULL, agent_id TEXT NOT NULL, message_id TEXT NOT NULL REFERENCES messages(id),
     PRIMARY KEY (team_id, agent_id, message_id),
     FOREIGN KEY (team_id, agent_id) REFERENCES agents(team_id, id) ON DELETE CASCADE);`,
];

export function openDb(dir, log) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'backchannel.db');
  const fresh = !fs.existsSync(file);
  const db = new DatabaseSync(file);
  if (fresh) fs.chmodSync(file, 0o600);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.tx = (fn) => {
    if (db.isTransaction) return fn();
    db.exec('BEGIN IMMEDIATE');
    try { const out = fn(); db.exec('COMMIT'); return out; } catch (err) { db.exec('ROLLBACK'); throw err; }
  };
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version > MIGRATIONS.length) {
    throw Object.assign(new Error(`database ${file} has schema v${version}, newer than this hub (v${MIGRATIONS.length}). Upgrade the hub.`), { code: 'DB_TOO_NEW' });
  }
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.tx(() => { db.exec(MIGRATIONS[v]); db.exec(`PRAGMA user_version = ${v + 1}`); });
    log?.info(`database migrated to schema v${v + 1}`, { file });
  }
  importLegacy(db, dir, log);
  return db;
}

// One-time import of the JSON files used before SQLite (v2, and v1 through readLegacy). Runs only into an empty database,
// in one transaction, and then renames the files to *.imported so nothing is lost.
function importLegacy(db, dir, log) {
  const present = LEGACY_FILES.filter((f) => fs.existsSync(path.join(dir, f)));
  if (!present.length) return;
  const empty = !db.prepare('SELECT 1 FROM users UNION ALL SELECT 1 FROM teams UNION ALL SELECT 1 FROM messages LIMIT 1').get();
  if (!empty) {
    log?.warn('found JSON data files next to a non-empty database; ignoring them', { files: present });
    return;
  }
  const data = readLegacy(dir, log);
  db.tx(() => {
    const users = db.prepare('INSERT INTO users (id, handle, name, token_hash, created_at) VALUES (?, ?, ?, ?, ?)');
    const sessions = db.prepare('INSERT OR IGNORE INTO sessions (hash, user_id, label, created_at, last_used_at) VALUES (?, ?, ?, ?, ?)');
    for (const u of data.users) {
      users.run(u.id, u.handle, u.name || u.handle, u.tokenHash, u.createdAt || Date.now());
      for (const s of u.sessions || []) sessions.run(s.hash, u.id, s.label || 'browser', s.createdAt || Date.now(), s.createdAt || Date.now());
    }
    const userIds = new Set(data.users.map((u) => u.id));
    const teams = db.prepare('INSERT INTO teams (id, name, max_hops, created_at) VALUES (?, ?, ?, ?)');
    const members = db.prepare('INSERT INTO members (team_id, user_id, role, joined_at, seq) VALUES (?, ?, ?, ?, ?)');
    const invites = db.prepare('INSERT INTO invites (code, team_id, role, created_by, created_at, expires_at, uses_left) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const t of data.teams) {
      teams.run(t.id, t.name, t.maxHops || 8, t.createdAt || Date.now());
      (t.members || []).filter((m) => userIds.has(m.userId)).forEach((m, i) => members.run(t.id, m.userId, m.role, m.joinedAt || Date.now(), i));
      for (const i of t.invites || []) invites.run(i.code, t.id, i.role, i.createdBy ?? null, i.createdAt || Date.now(), i.expiresAt, i.usesLeft);
    }
    const teamIds = new Set(data.teams.map((t) => t.id));
    const agents = db.prepare('INSERT OR IGNORE INTO agents (team_id, id, owner_user_id, card, registered_at) VALUES (?, ?, ?, ?, ?)');
    for (const a of data.agents) {
      if (!teamIds.has(a.teamId)) continue;
      const { teamId, id, ownerUserId, registeredAt, lastSeen, state, stateThread, ...card } = a;
      agents.run(teamId, id, ownerUserId && userIds.has(ownerUserId) ? ownerUserId : null, JSON.stringify(card), registeredAt || Date.now());
    }
    const messages = db.prepare('INSERT OR IGNORE INTO messages (id, team_id, thread_id, ts, body) VALUES (?, ?, ?, ?, ?)');
    for (const m of data.messages) {
      if (!m.id || !teamIds.has(m.teamId)) continue;
      messages.run(String(m.id), m.teamId, String(m.threadId || m.id), Number(m.ts) || 0, JSON.stringify(m));
    }
    const inbox = db.prepare(`INSERT OR IGNORE INTO inbox (team_id, agent_id, message_id)
      SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM agents WHERE team_id = ? AND id = ?) AND EXISTS (SELECT 1 FROM messages WHERE id = ?)`);
    for (const [key, ids] of Object.entries(data.inboxes)) {
      const [teamId, agentId] = key.split('/');
      for (const id of ids) inbox.run(teamId, agentId, id, teamId, agentId, id);
    }
  });
  for (const f of present) fs.renameSync(path.join(dir, f), path.join(dir, f + '.imported'));
  log?.info('imported JSON data into the database', { users: data.users.length, teams: data.teams.length, messages: data.messages.length, files: present });
}
