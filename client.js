// Tiny hub client shared by the connector (agent.js), the MCP server (mcp.js) and the CLI (cli.js).
// Every agent and message call is scoped to one team: /api/teams/:team/...
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CONFIG_FILE = path.join(os.homedir(), '.backchannel', 'config.json');
export function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; }
}

// Settings from env (HUB_URL, HUB_TOKEN, HUB_TEAM), falling back to what `cli.js join` saved,
// so local agents work without copying the token around. The saved token is only used for the hub it belongs to.
export function hubFromEnv({ url, team } = {}) {
  const cfg = loadConfig();
  const hubUrl = (url || process.env.HUB_URL || cfg.hub || 'http://127.0.0.1:7777').replace(/\/$/, '');
  const sameHub = cfg.hub && cfg.hub.replace(/\/$/, '') === hubUrl;
  return new Hub(hubUrl, process.env.HUB_TOKEN || (sameHub ? cfg.token : undefined), team || process.env.HUB_TEAM || (sameHub ? cfg.team : undefined));
}

export class Hub {
  constructor(url, token, team) {
    this.url = String(url || 'http://127.0.0.1:7777').replace(/\/$/, '');
    this.token = token;
    this.team = team || null;
  }

  async req(method, p, body) {
    const res = await fetch(this.url + p, {
      method,
      headers: { 'content-type': 'application/json', ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(data.error || `hub ${res.status}`); e.status = res.status; throw e; }
    return data;
  }

  // Picks the team: the configured one, or the user's only team. Call once before team-scoped calls.
  async resolveTeam() {
    if (!this.token) throw Object.assign(new Error(`no token for ${this.url}. Join a team first (node cli.js join <invite-link>), or set HUB_TOKEN.`), { status: 401 });
    const me = await this.req('GET', '/api/me');
    if (this.team) {
      const t = me.teams.find((x) => x.id === this.team || x.name.toLowerCase() === String(this.team).toLowerCase());
      if (!t) throw new Error(`you're not a member of team "${this.team}". Your teams: ${me.teams.map((x) => `${x.name} (${x.id})`).join(', ') || 'none'}`);
      this.team = t.id;
    } else if (me.teams.length === 1) {
      this.team = me.teams[0].id;
    } else {
      throw new Error(me.teams.length
        ? `you're in several teams; set HUB_TEAM to one of: ${me.teams.map((x) => `${x.id} (${x.name})`).join(', ')}`
        : "you're not in any team yet. Accept an invite first.");
    }
    this.me = me;
    return me;
  }

  t(p) {
    if (!this.team) throw new Error('team not resolved; call resolveTeam() first');
    return `/api/teams/${this.team}${p}`;
  }

  register(card) { return this.req('POST', this.t('/agents'), card); }
  agents() { return this.req('GET', this.t('/agents')); }
  thread(id) { return this.req('GET', this.t(`/threads/${id}`)); }
  post(msg) { return this.req('POST', this.t('/messages'), msg); }
  status(id, state, threadId) { return this.req('POST', this.t(`/agents/${id}/status`), { state, threadId }); }
  requeue(id, ids) { return this.req('POST', this.t(`/agents/${id}/requeue`), { ids }); }
  inbox(id, wait = 25) { return this.req('GET', this.t(`/agents/${id}/inbox?wait=${wait}`)); }

  // Register, then long-poll the inbox forever. Re-registers if the hub restarts; backs off if it's down.
  // Stops on auth/permission errors, since retrying can't fix those.
  async listen(card, onMessage, log = () => {}) {
    let registered = false, backoff = 1000;
    for (;;) {
      try {
        if (!this.team) await this.resolveTeam();
        if (!registered) { await this.register(card); registered = true; backoff = 1000; log(`@${card.id} online in team ${this.team}`); }
        for (const msg of await this.inbox(card.id)) await onMessage(msg);
      } catch (err) {
        if (err.status === 401 || err.status === 403 || err.status === 409) { log(`stopped: ${err.message}`); throw err; }
        // A 404 while registered means the hub forgot the agent (restart, removal): register again right away.
        if (err.status === 404 && registered) { registered = false; continue; }
        if (registered) log(`hub unreachable (${err.message}), retrying…`);
        registered = false;
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 15000);
      }
    }
  }
}
