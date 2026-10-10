// Test harness: runs real hub processes on random ports with throwaway data directories.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const prefix = (account) => `/api/teams/${account.team.id}`;

// Reads the hub's database directly (only while the hub is stopped, or for read-only checks).
export function query(dir, sql, ...params) {
  const db = new DatabaseSync(path.join(dir, 'backchannel.db'));
  try { return db.prepare(sql).all(...params).map((r) => ({ ...r })); } finally { db.close(); }
}
function userCount(dir) {
  if (fs.existsSync(path.join(dir, 'backchannel.db'))) return query(dir, 'SELECT count(*) AS n FROM users')[0].n;
  const usersFile = path.join(dir, 'users.json');
  return fs.existsSync(usersFile) ? JSON.parse(fs.readFileSync(usersFile, 'utf8')).length : 0;
}

export function tempDir(t, name = 'backchannel-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), name));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export async function startHub(t, seed, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backchannel-hub-test-'));
  if (seed) seed(dir);
  let child;
  let output;
  let base;
  async function stop() {
    if (child && child.exitCode === null && child.signalCode === null) {
      const ended = once(child, 'exit');
      child.kill('SIGTERM');
      await ended;
    }
  }
  async function start() {
    output = '';
    const needsSetup = userCount(dir) === 0;
    child = spawn(process.execPath, ['hub.js'], { cwd: ROOT,
      env: { ...process.env, DATA_DIR: dir, HOST: '127.0.0.1', PORT: '0', PUBLIC_URL: '', HUB_TOKEN: '', MAX_HOPS: '',
        LOG_FORMAT: 'json', LOG_LEVEL: 'info', TRUST_PROXY: '', SENTRY_DSN: '', ...env },
      stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (data) => { output += data; });
    child.stderr.on('data', (data) => { output += data; });
    const deadline = Date.now() + 5000;
    while (!/Backchannel hub on http:\/\/127\.0\.0\.1:\d+\D/.test(output)
      || (needsSetup && !/Setup link: \S*\/#join\/[a-f0-9]{24}\b/.test(output))) {
      if (child.exitCode !== null || Date.now() > deadline) throw new Error(`Hub failed to start: ${output}`);
      await delay(10);
    }
    base = output.match(/Backchannel hub on (http:\/\/127\.0\.0\.1:\d+)/)[1];
  }
  t.after(async () => { await stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  await start();
  const hub = {
    dir, get base() { return base; }, get output() { return output; }, get child() { return child; },
    get setup() { return output.match(/Setup link: .*\/#join\/([a-f0-9]+)/)?.[1]; },
    // Parsed JSON log lines.
    logs() { return output.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l)); },
    async restart() { await stop(); await start(); },
    stop,
    async api(route, token, method = 'GET', body, headers = {}) {
      const response = await fetch(base + route, { method,
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, body: await response.json().catch(() => null), headers: response.headers };
    },
    async ok(route, token, method = 'GET', body) {
      const result = await this.api(route, token, method, body);
      assert.equal(result.status, 200, JSON.stringify(result.body));
      return result.body;
    },
    async bootstrap(handle = 'alice') { return this.ok(`/api/invites/${this.setup}/accept`, null, 'POST', { handle, name: handle }); },
    async join(owner, role, handle, teamId = owner.team.id) {
      const invite = await this.ok(`/api/teams/${teamId}/invites`, owner.token, 'POST', { role });
      return this.ok(`/api/invites/${invite.code}/accept`, null, 'POST', { handle });
    },
  };
  return hub;
}

// ---------- connectors (agent.js) run against a fake claude (test/fixtures/fake-claude.js) ----------
export const BIN = path.join(ROOT, 'bin', 'backchannel.js');
export const FAKE = path.join(ROOT, 'test', 'fixtures', 'fake-claude.js');
fs.chmodSync(FAKE, 0o755);

export async function until(fn, ms = 8000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('timed out');
    await delay(50);
  }
}

// A home folder signed in as `account`, with claude replaced by the fake.
export function signedIn(t, h, account, extra = {}) {
  const home = tempDir(t, 'bc-home-');
  fs.mkdirSync(path.join(home, '.backchannel'));
  fs.writeFileSync(path.join(home, '.backchannel', 'config.json'),
    JSON.stringify({ hub: h.base, token: account.token, team: account.team.id, handle: account.user.handle }));
  const env = { ...process.env, HOME: home, CLAUDE_BIN: FAKE, FAKE_CLAUDE_LOG: path.join(home, 'claude.log'), ...extra };
  for (const k of ['HUB_URL', 'HUB_TOKEN', 'HUB_TEAM', 'BACKCHANNEL_SERVICE', 'XDG_CONFIG_HOME']) delete env[k];
  return { home, env, claudeLog: () => fs.readFileSync(env.FAKE_CLAUDE_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) };
}

export function connector(t, args, opts) {
  const child = spawn(process.execPath, [BIN, 'connect', ...args], { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  t.after(() => child.kill());
  return { child, out: () => out, async stop() { const done = once(child, 'exit'); child.kill('SIGTERM'); return (await done)[0]; } };
}

// Posts as `account` and returns the agent's answer to that message.
export async function ask(h, account, agent, text, threadId, extra = {}) {
  const p = `/api/teams/${account.team.id}`;
  const sent = await h.ok(p + '/messages', account.token, 'POST', { text: `@${agent} ${text}`, ...(threadId ? { threadId } : {}), ...extra });
  return until(async () => (await h.ok(`${p}/threads/${sent.threadId}`, account.token)).find((m) => m.from === agent && m.inReplyTo === sent.id), 15000);
}

// A git repo with one commit on main.
export function gitRepo(t, name = 'payments', files = { 'src/app.js': 'export const app = 1;\n' }) {
  const parent = fs.realpathSync(tempDir(t, 'bc-repo-'));
  const dir = path.join(parent, name);
  fs.mkdirSync(dir);
  const git = (...a) => { const r = spawnSync('git', a, { cwd: dir, encoding: 'utf8' }); if (r.status) throw new Error(r.stderr); return r.stdout.trim(); };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'Test');
  for (const [f, body] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), body); }
  git('add', '-A'); git('commit', '-q', '-m', 'first');
  return { dir, parent, git };
}
