// SQLite storage (built-in node:sqlite): one file, WAL mode, forward-only migrations tracked in PRAGMA user_version.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readLegacy, LEGACY_FILES } from './legacy.js';
import { buildThread } from './threads.js';

// Append only. Each entry moves the schema from version i to i + 1: SQL, or a function given the database.
const MIGRATIONS = [
  `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   CREATE TABLE users (
     id TEXT PRIMARY KEY, handle TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
     token_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);
   CREATE TABLE sessions (
     hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     label TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'browser' CHECK (kind IN ('browser', 'cli')),
     created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL);
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
  // Files attached to messages. Stored in the database so backups and restores carry them.
  `CREATE TABLE files (
     id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
     name TEXT NOT NULL, type TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL,
     uploaded_by TEXT, created_at INTEGER NOT NULL, data BLOB NOT NULL);
   CREATE INDEX files_team ON files(team_id, created_at);`,
  // Agents someone disconnected. Their running connector or session is told to stop instead of registering again;
  // a fresh start of that agent clears the row.
  `CREATE TABLE agent_disconnects (
     team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE, id TEXT NOT NULL,
     by_user_id TEXT, at INTEGER NOT NULL, PRIMARY KEY (team_id, id));`,
  // What a live session's stand-in may do when nobody in the session picks a request up. Kept apart from the agent
  // row so it survives re-registering and disconnecting; no row means the default.
  `CREATE TABLE agent_settings (
     team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE, id TEXT NOT NULL,
     stand_in TEXT NOT NULL CHECK (stand_in IN ('off', 'read', 'write')),
     updated_by TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY (team_id, id));`,
  // Delegation summaries kept by the hub (server/threads.js), and inbox leases: a message taken by a connector or a
  // stand-in stays in the inbox, hidden, until it's answered or acknowledged; if the lease runs out it comes back.
  (db) => {
    db.exec(`CREATE TABLE threads (
       team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE, id TEXT NOT NULL, updated INTEGER NOT NULL,
       state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'done')), closed_by TEXT, closed_at INTEGER, summary TEXT,
       data TEXT NOT NULL, PRIMARY KEY (team_id, id));
     CREATE INDEX threads_updated ON threads(team_id, updated);
     ALTER TABLE inbox ADD COLUMN leased_until INTEGER;
     ALTER TABLE inbox ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;`);
    rebuildThreads(db);
  },
  // Who a disconnected agent belonged to, so its handle stays theirs: only they can start it again.
  // Checked first, because a database copied back from an older version may already have the column.
  (db) => {
    const cols = db.prepare('PRAGMA table_info(agent_disconnects)').all().map((c) => c.name);
    if (!cols.includes('owner_user_id')) db.exec('ALTER TABLE agent_disconnects ADD COLUMN owner_user_id TEXT');
  },
];

// Summaries for every thread, from its messages. Agents are judged by who is registered now, as the UI did.
function rebuildThreads(db) {
  const agents = new Map();
  for (const { team_id: t, id } of db.prepare('SELECT team_id, id FROM agents').all()) {
    if (!agents.has(t)) agents.set(t, new Set());
    agents.get(t).add(id);
  }
  const insert = db.prepare('INSERT INTO threads (team_id, id, updated, data) VALUES (?, ?, ?, ?)');
  let key = null, msgs = [];
  const flush = () => {
    if (!msgs.length) return;
    const [teamId, threadId] = key;
    const row = buildThread(msgs, (id) => agents.get(teamId)?.has(id) || false);
    insert.run(teamId, threadId, row.updated, JSON.stringify(row));
    msgs = [];
  };
  for (const r of db.prepare('SELECT team_id, thread_id, body FROM messages ORDER BY team_id, thread_id, seq').iterate()) {
    if (!key || key[0] !== r.team_id || key[1] !== r.thread_id) { flush(); key = [r.team_id, r.thread_id]; }
    msgs.push(JSON.parse(r.body));
  }
  flush();
}

export const DB_FILE = 'backchannel.db';

export function openDb(dir, log) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, DB_FILE);
  const fresh = !fs.existsSync(file);
  const db = new DatabaseSync(file);
  if (fresh) fs.chmodSync(file, 0o600);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  // Nested calls join the outer transaction. (Tracked by hand: db.isTransaction needs a newer Node than 22.13.)
  let depth = 0;
  db.tx = (fn) => {
    if (depth) { depth++; try { return fn(); } finally { depth--; } }
    db.exec('BEGIN IMMEDIATE');
    depth = 1;
    try { const out = fn(); db.exec('COMMIT'); return out; } catch (err) { db.exec('ROLLBACK'); throw err; } finally { depth = 0; }
  };
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version > MIGRATIONS.length) {
    throw Object.assign(new Error(`database ${file} has schema v${version}, newer than this hub (v${MIGRATIONS.length}). Upgrade the hub.`), { code: 'DB_TOO_NEW' });
  }
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.tx(() => {
      const step = MIGRATIONS[v];
      if (typeof step === 'function') step(db); else db.exec(step);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
    log?.info(`database migrated to schema v${v + 1}`, { file });
  }
  importLegacy(db, dir, log);
  return db;
}

// One-time import of the JSON files used before SQLite (v2, and v1 through readLegacy). The data and a completion
// marker commit in one transaction; the files are renamed to *.imported afterwards, so nothing is deleted.
// If the process dies between the commit and the renames, the next start sees the marker and only finishes the renames.
function importLegacy(db, dir, log) {
  const present = LEGACY_FILES.filter((f) => fs.existsSync(path.join(dir, f)));
  if (!present.length) return;
  const rename = (files) => {
    for (const f of files) {
      if (fs.existsSync(path.join(dir, f + '.imported'))) log?.warn(`leaving ${f} alone: it was already imported once`, { file: f });
      else fs.renameSync(path.join(dir, f), path.join(dir, f + '.imported'));
    }
  };
  if (db.prepare("SELECT 1 AS x FROM meta WHERE key = 'json_import'").get()) return rename(present);
  if (db.prepare('SELECT 1 AS x FROM users UNION ALL SELECT 1 FROM teams UNION ALL SELECT 1 FROM messages LIMIT 1').get()) {
    log?.warn('found JSON data files next to a database that already has data; ignoring them', { files: present });
    return;
  }
  const data = readLegacy(dir, log); // throws with file and line on damaged data
  const skipped = { members: 0, agents: 0, messages: 0, inboxEntries: 0, sessions: 0 };
  db.tx(() => {
    const now = Date.now();
    const users = db.prepare('INSERT INTO users (id, handle, name, token_hash, created_at) VALUES (?, ?, ?, ?, ?)');
    // Imported sessions count as used now, so nobody is signed out by the upgrade.
    const sessions = db.prepare('INSERT OR IGNORE INTO sessions (hash, user_id, label, created_at, last_used_at) VALUES (?, ?, ?, ?, ?)');
    for (const u of data.users) {
      users.run(u.id, u.handle, u.name || u.handle, u.tokenHash, u.createdAt || now);
      for (const s of u.sessions || []) skipped.sessions += 1 - Number(sessions.run(s.hash, u.id, String(s.label || 'browser'), s.createdAt || now, now).changes);
    }
    const userIds = new Set(data.users.map((u) => u.id));
    const teams = db.prepare('INSERT INTO teams (id, name, max_hops, created_at) VALUES (?, ?, ?, ?)');
    const members = db.prepare('INSERT INTO members (team_id, user_id, role, joined_at, seq) VALUES (?, ?, ?, ?, ?)');
    const invites = db.prepare('INSERT INTO invites (code, team_id, role, created_by, created_at, expires_at, uses_left) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const t of data.teams) {
      teams.run(t.id, t.name, t.maxHops || 8, t.createdAt || now);
      const known = (t.members || []).filter((m) => userIds.has(m.userId));
      skipped.members += (t.members || []).length - known.length;
      known.forEach((m, i) => members.run(t.id, m.userId, m.role, m.joinedAt || now, i));
      for (const i of t.invites || []) invites.run(i.code, t.id, i.role, i.createdBy ?? null, i.createdAt || now, i.expiresAt, i.usesLeft);
    }
    const teamIds = new Set(data.teams.map((t) => t.id));
    const agents = db.prepare('INSERT OR IGNORE INTO agents (team_id, id, owner_user_id, card, registered_at) VALUES (?, ?, ?, ?, ?)');
    for (const a of data.agents) {
      const { teamId, id, ownerUserId, registeredAt, lastSeen, state, stateThread, ...card } = a;
      if (!teamIds.has(teamId) || !id) { skipped.agents++; continue; }
      skipped.agents += 1 - Number(agents.run(teamId, id, ownerUserId && userIds.has(ownerUserId) ? ownerUserId : null, JSON.stringify(card), registeredAt || now).changes);
    }
    // File order is kept: it becomes the message sequence.
    const messages = db.prepare('INSERT OR IGNORE INTO messages (id, team_id, thread_id, ts, body) VALUES (?, ?, ?, ?, ?)');
    for (const m of data.messages) {
      if (!m.id || !teamIds.has(m.teamId)) { skipped.messages++; continue; }
      skipped.messages += 1 - Number(messages.run(String(m.id), m.teamId, String(m.threadId || m.id), Number(m.ts) || 0, JSON.stringify(m)).changes);
    }
    // Inboxes come from the saved queues (never from recipients, which would redeliver consumed messages).
    const inbox = db.prepare(`INSERT OR IGNORE INTO inbox (team_id, agent_id, message_id)
      SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM agents WHERE team_id = ? AND id = ?) AND EXISTS (SELECT 1 FROM messages WHERE id = ? AND team_id = ?)`);
    for (const [key, ids] of Object.entries(data.inboxes)) {
      const [teamId, agentId] = key.split('/');
      for (const id of ids) skipped.inboxEntries += 1 - Number(inbox.run(teamId, agentId, id, teamId, agentId, id, teamId).changes);
    }
    rebuildThreads(db); // the database was empty, so this covers exactly the imported messages
    db.prepare("INSERT INTO meta (key, value) VALUES ('json_import', ?)").run(JSON.stringify({ at: now, files: present, skipped }));
  });
  rename(present);
  log?.info('imported JSON data into the database', { users: data.users.length, teams: data.teams.length, messages: data.messages.length, files: present });
  if (Object.values(skipped).some(Boolean)) log?.warn('some imported records were skipped (duplicates or references to missing data)', { skipped });
}

