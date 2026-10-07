// Tiny hub client shared by the connector (agent.js), the MCP server (mcp.js) and the CLI (cli.js).
// Every agent and message call is scoped to one team: /api/teams/:team/...
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Content types for uploads, by extension. Anything else is sent as application/octet-stream.
const TYPES = { '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json', '.csv': 'text/csv', '.html': 'text/html',
  '.js': 'text/javascript', '.ts': 'text/plain', '.py': 'text/x-python', '.yaml': 'application/yaml', '.yml': 'application/yaml',
  '.xml': 'application/xml', '.diff': 'text/x-diff', '.patch': 'text/x-diff', '.log': 'text/plain', '.sql': 'application/sql',
  '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.zip': 'application/zip', '.gz': 'application/gzip' };

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

// Downloads a file into `dir` under its own name (never overwriting: "notes (2).md"). Returns { path, info, data }.
export async function saveFile(hub, id, dir) {
  const [info, data] = await Promise.all([hub.fileInfo(id), hub.download(id)]);
  fs.mkdirSync(dir, { recursive: true });
  const name = path.basename(info.name) || 'file';
  const { name: stem, ext } = path.parse(name);
  let target = path.join(dir, name);
  for (let n = 2; fs.existsSync(target); n++) target = path.join(dir, `${stem} (${n})${ext}`);
  fs.writeFileSync(target, data);
  return { path: target, info, data };
}

export const formatSize = (n) => (n < 1024 ? `${n} B` : n < 1_048_576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1_048_576).toFixed(1)} MB`);

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
    if (!this.token) {
      const cfg = loadConfig();
      const elsewhere = cfg.hub && cfg.hub.replace(/\/$/, '') !== this.url ? ` (this computer is signed in to ${cfg.hub}; HUB_URL may be pointing somewhere else)` : '';
      throw Object.assign(new Error(`not signed in to ${this.url}${elsewhere}. Run \`backchannel doctor\` in a terminal for the fix`), { status: 401 });
    }
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
  // Files: upload one from disk (returns { id, name, type, size }), read its details, or download its bytes.
  async upload(file) {
    const data = fs.readFileSync(file);
    const res = await fetch(this.url + this.t(`/files?name=${encodeURIComponent(path.basename(file))}`), {
      method: 'POST', body: data,
      headers: { 'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(`${path.basename(file)}: ${body.error || `hub ${res.status}`}`); e.status = res.status; throw e; }
    return body;
  }
  fileInfo(id) { return this.req('GET', this.t(`/files/${id}/info`)); }
  async download(id) {
    const res = await fetch(this.url + this.t(`/files/${id}`), { headers: this.token ? { authorization: `Bearer ${this.token}` } : {} });
    if (!res.ok) { const body = await res.json().catch(() => ({})); const e = new Error(body.error || `hub ${res.status}`); e.status = res.status; throw e; }
    return Buffer.from(await res.arrayBuffer());
  }
  inbox(id, wait = 25) { return this.req('GET', this.t(`/agents/${id}/inbox?wait=${wait}`)); }
  pending(id, after = 0, wait = 25) { return this.req('GET', this.t(`/agents/${id}/pending?wait=${wait}&after=${after}`)); }
  async claim(id, ids) { return (await this.req('POST', this.t(`/agents/${id}/claim`), { ids })).messages; }

  // Register, then long-poll the inbox forever, taking each message (one process per agent).
  listen(card, onMessage, log = () => {}) {
    return this.#run(card, log, async () => { for (const msg of await this.inbox(card.id)) await onMessage(msg); });
  }

  // Like listen, but leaves messages on the hub until claim() takes them, for live sessions: several can share a
  // handle, and each message should reach the one whose agent reads it. `onUpdate` gets every unclaimed message
  // whenever the inbox changes, and at least every 25 s.
  watch(card, onUpdate, log = () => {}) {
    let after = 0;
    return this.#run(card, log, async () => { const r = await this.pending(card.id, after); after = r.cursor; await onUpdate(r.messages); });
  }

  // Re-registers if the hub restarts; backs off if it's down. Stops on auth/permission errors, since retrying can't fix those.
  async #run(card, log, step) {
    let registered = false, backoff = 1000;
    for (;;) {
      try {
        if (!this.team) await this.resolveTeam();
        if (!registered) { await this.register(card); registered = true; backoff = 1000; log(`@${card.id} online in team ${this.team}`); }
        await step();
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
