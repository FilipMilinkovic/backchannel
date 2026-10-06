import fs from 'node:fs';
import path from 'node:path';
import { newId } from './auth.js';

export const agentKey = (teamId, agentId) => `${teamId}/${agentId}`;

export class Store {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.users = this.read('users.json', []);
    this.teams = this.read('teams.json', []);
    this.messages = [];
    const log = path.join(dir, 'messages.jsonl');
    if (fs.existsSync(log)) {
      for (const line of fs.readFileSync(log, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try { this.messages.push(JSON.parse(line)); } catch { console.warn('Skipping invalid message log line'); }
      }
    }
    const registry = this.read('agents.json', { agents: [], inboxes: {} });
    const savedAgents = Array.isArray(registry) ? registry : registry.agents || [];
    const legacy = this.messages.some((m) => !m.teamId) || savedAgents.some((a) => !a.teamId)
      || (!this.teams.length && (fs.existsSync(path.join(dir, 'agents.json')) || fs.existsSync(path.join(dir, 'config.json'))));
    if (legacy) {
      const config = this.read('config.json', {});
      const maxHops = Number.isInteger(config.maxHops) && config.maxHops >= 1 && config.maxHops <= 50 ? config.maxHops : 8;
      this.legacyTeam = this.teams.find((t) => t.name === 'Backchannel') || this.createTeam('Backchannel', null, maxHops);
      for (const a of savedAgents) if (!a.teamId) { a.teamId = this.legacyTeam.id; a.ownerUserId = null; }
      const ids = new Set(savedAgents.filter((a) => a.teamId === this.legacyTeam.id).map((a) => a.id));
      for (const m of this.messages) if (!m.teamId) {
        m.teamId = this.legacyTeam.id;
        m.fromKind = m.from === 'human' ? 'user' : ids.has(m.from) ? 'agent' : 'user';
        m.by = null; // v1 did not record the authenticated author.
      }
      this.atomic('messages.jsonl', this.messages.map((m) => JSON.stringify(m) + '\n').join(''));
    }
    this.byId = new Map(this.messages.map((m) => [m.id, m]));
    this.agents = new Map(savedAgents.map((a) => [agentKey(a.teamId, a.id), { ...a, lastSeen: 0, state: 'idle', stateThread: null }]));
    this.inboxes = new Map();
    for (const [oldKey, ids] of Object.entries(registry.inboxes || {})) {
      const key = oldKey.includes('/') ? oldKey : this.legacyTeam ? agentKey(this.legacyTeam.id, oldKey) : oldKey;
      const agent = this.agents.get(key);
      if (agent) this.inboxes.set(key, ids.map((id) => this.byId.get(id)).filter((m) => m?.teamId === agent.teamId));
    }
    if (!this.users.length) {
      const team = this.legacyTeam || this.teams[0] || this.createTeam('Backchannel');
      this.setupInvite = team.invites.find((i) => i.createdBy === null && this.activeInvite(i));
      if (!this.setupInvite) {
        this.setupInvite = this.createInvite(team, 'owner', null, 168, 1);
      }
    }
    this.saveTeams();
    this.saveRegistry();
  }

  read(file, fallback) {
    try { return JSON.parse(fs.readFileSync(path.join(this.dir, file), 'utf8')); }
    catch (err) { if (err.code === 'ENOENT') return fallback; throw err; }
  }

  atomic(file, contents) {
    const target = path.join(this.dir, file);
    fs.writeFileSync(target + '.tmp', contents, { mode: 0o600 });
    fs.renameSync(target + '.tmp', target);
  }

  saveUsers() { this.atomic('users.json', JSON.stringify(this.users, null, 2)); }
  saveTeams() { this.atomic('teams.json', JSON.stringify(this.teams, null, 2)); }
  saveRegistry() {
    this.atomic('agents.json', JSON.stringify({
      agents: [...this.agents.values()],
      inboxes: Object.fromEntries([...this.inboxes].filter(([, box]) => box.length).map(([key, box]) => [key, box.map((m) => m.id)])),
    }, null, 2));
  }

  createTeam(name, userId = null, maxHops = 8) {
    const team = { id: newId(), name, createdAt: Date.now(), maxHops,
      members: userId ? [{ userId, role: 'owner', joinedAt: Date.now() }] : [], invites: [] };
    this.teams.push(team);
    this.saveTeams();
    return team;
  }

  activeInvite(invite) { return invite.usesLeft > 0 && invite.expiresAt > Date.now(); }
  createInvite(team, role, createdBy, expiresInHours, uses) {
    const invite = { code: newId() + newId(), role, createdBy, createdAt: Date.now(),
      expiresAt: Date.now() + expiresInHours * 3_600_000, usesLeft: uses };
    team.invites.push(invite);
    this.saveTeams();
    return invite;
  }

  findInvite(code) {
    for (const team of this.teams) {
      const invite = team.invites.find((i) => i.code === code && this.activeInvite(i));
      if (invite) return { team, invite };
    }
    return null;
  }

  persistMessage(message) {
    fs.appendFileSync(path.join(this.dir, 'messages.jsonl'), JSON.stringify(message) + '\n', { mode: 0o600 });
    this.messages.push(message);
    this.byId.set(message.id, message);
  }
}
