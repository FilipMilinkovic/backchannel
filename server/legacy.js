// Reads the JSON files used before SQLite (v2: users/teams/agents.json + messages.jsonl; v1: no teams, config.json)
// into plain data for the one-time import in db.js. Never writes.
import fs from 'node:fs';
import path from 'node:path';
import { newId } from './auth.js';

export const LEGACY_FILES = ['users.json', 'teams.json', 'agents.json', 'messages.jsonl', 'config.json'];

function read(dir, file, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')); }
  catch (err) { if (err.code === 'ENOENT') return fallback; throw new Error(`can't import ${file}: ${err.message}`); }
}

export function readLegacy(dir, log) {
  const users = read(dir, 'users.json', []);
  const teams = read(dir, 'teams.json', []);
  const messages = [];
  const logFile = path.join(dir, 'messages.jsonl');
  if (fs.existsSync(logFile)) {
    const raw = fs.readFileSync(logFile, 'utf8');
    const lines = raw.split('\n');
    const last = lines.findLastIndex((l) => l.trim());
    lines.forEach((line, i) => {
      if (!line.trim()) return;
      try { messages.push(JSON.parse(line)); } catch {
        // A crash mid-append leaves one unterminated last line; that one is safe to drop. Anything else is damage.
        if (i === last && !raw.endsWith('\n')) log?.warn('dropping an incomplete last line in messages.jsonl', { line: i + 1 });
        else throw new Error(`can't import messages.jsonl: line ${i + 1} is not valid JSON. Fix or remove that line and start again.`);
      }
    });
  }
  const registry = read(dir, 'agents.json', { agents: [], inboxes: {} });
  const agents = Array.isArray(registry) ? registry : registry.agents || [];
  const inboxes = {};

  // v1 data (no teams) goes into a team called "Backchannel"; the setup invite later makes its user the owner.
  const v1 = messages.some((m) => !m.teamId) || agents.some((a) => !a.teamId)
    || (!teams.length && (fs.existsSync(path.join(dir, 'agents.json')) || fs.existsSync(path.join(dir, 'config.json'))));
  let legacyTeam = null;
  if (v1) {
    const config = read(dir, 'config.json', {});
    const maxHops = Number.isInteger(config.maxHops) && config.maxHops >= 1 && config.maxHops <= 50 ? config.maxHops : 8;
    legacyTeam = teams.find((t) => t.name === 'Backchannel');
    if (!legacyTeam) {
      legacyTeam = { id: newId(), name: 'Backchannel', createdAt: Date.now(), maxHops, members: [], invites: [] };
      teams.push(legacyTeam);
    }
    for (const a of agents) if (!a.teamId) { a.teamId = legacyTeam.id; a.ownerUserId = null; }
    const ids = new Set(agents.filter((a) => a.teamId === legacyTeam.id).map((a) => a.id));
    for (const m of messages) if (!m.teamId) {
      m.teamId = legacyTeam.id;
      m.fromKind = m.from === 'human' ? 'user' : ids.has(m.from) ? 'agent' : 'user';
      m.by = null; // v1 did not record the authenticated author.
    }
  }
  for (const [key, ids] of Object.entries(registry.inboxes || {})) {
    const full = key.includes('/') ? key : legacyTeam ? `${legacyTeam.id}/${key}` : key;
    inboxes[full] = ids;
  }
  return { users, teams, agents, messages, inboxes };
}
