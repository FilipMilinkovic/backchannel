// Operational behavior: health, headers, logs, limits, revocation of open streams, shutdown, config, backup.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { startHub, query, prefix, delay, tempDir, ROOT } from './helpers.js';
import { loadConfig } from '../server/config.js';
import { openDb } from '../server/db.js';
import { backupIfDue } from '../server/backup.js';
import { CLIENT_FILES } from '../server/bundle.js';

// Opens an SSE stream; resolves with { res, events, ended } once the hello event arrived.
function openStream(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      const s = { res, status: res.statusCode, events: [], ended: false, req };
      res.setEncoding('utf8');
      let buf = '';
      res.on('data', (d) => {
        buf += d;
        for (const block of buf.split('\n\n').slice(0, -1)) {
          const line = block.split('\n').find((l) => l.startsWith('data: '));
          if (line) s.events.push(JSON.parse(line.slice(6)));
        }
        buf = buf.slice(buf.lastIndexOf('\n\n') + 2);
        if (s.events.length === 1) resolve(s);
      });
      res.on('end', () => { s.ended = true; });
      res.on('close', () => { s.ended = true; });
      if (res.statusCode !== 200) { resolve(s); res.resume(); }
    });
    req.on('error', reject);
  });
}
const waitFor = async (cond, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error('timed out'); await delay(10); }
};

test('health, readiness, version, request ids and security headers', async (t) => {
  const h = await startHub(t);
  const health = await h.api('/healthz');
  assert.equal(health.status, 200); assert.equal(health.body.ok, true); assert.match(health.body.version, /^\d+\.\d+\.\d+/);
  assert.equal((await h.api('/readyz')).status, 200);
  assert.equal((await h.api('/api/version')).body.version, health.body.version);

  const generated = await h.api('/api/me');
  assert.match(generated.headers.get('x-request-id'), /^[a-f0-9]{16}$/);
  assert.equal((await h.api('/api/me', null, 'GET', undefined, { 'x-request-id': 'trace-123' })).headers.get('x-request-id'), 'trace-123');
  assert.notEqual((await h.api('/api/me', null, 'GET', undefined, { 'x-request-id': 'bad id!' })).headers.get('x-request-id'), 'bad id!');

  const page = await fetch(h.base + '/');
  const html = await page.text();
  for (const [k, v] of [['x-content-type-options', 'nosniff'], ['referrer-policy', 'no-referrer'], ['x-frame-options', 'DENY'], ['cache-control', 'no-cache']]) {
    assert.equal(page.headers.get(k), v, k);
  }
  assert.equal(page.headers.get('strict-transport-security'), null, 'no HSTS without an https PUBLIC_URL');
  const csp = page.headers.get('content-security-policy');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  assert.ok(csp.includes(`'sha256-${crypto.createHash('sha256').update(script).digest('base64')}'`), 'the UI script is allowed by hash');
  assert.ok(!/script-src[^;]*unsafe-inline/.test(csp));
  assert.equal((await fetch(h.base + '/../package.json')).status, 404);
  assert.equal((await fetch(h.base + '/%2e%2e/package.json')).status, 404);
  assert.equal((await fetch(h.base + '/%E0%A4%A')).status, 400);

  // A request target the URL parser rejects gets a 400 and a closed exchange, not a hung socket.
  const raw = await new Promise((resolve, reject) => {
    const socket = net.connect(new URL(h.base).port, '127.0.0.1', () => socket.write('GET //[ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'));
    let data = '';
    socket.on('data', (d) => (data += d)).on('end', () => resolve(data)).on('error', reject);
    setTimeout(() => { socket.destroy(); resolve(data || 'timeout'); }, 3000);
  });
  assert.match(raw, /^HTTP\/1\.1 400/);
});

test('JSON access logs carry request ids and never contain tokens or invite codes', async (t) => {
  const h = await startHub(t);
  const setup = h.setup;
  const owner = await h.bootstrap();
  await h.ok('/api/me', owner.token);
  const stream = await openStream(`${h.base}${prefix(owner)}/events?token=${owner.token}`);
  stream.req.destroy();
  await h.api('/api/me', null, 'GET', undefined, { 'x-request-id': 'find-me' });
  await waitFor(() => h.logs().some((l) => l.requestId === 'find-me'));
  const entry = h.logs().find((l) => l.requestId === 'find-me');
  assert.equal(entry.msg, 'request'); assert.equal(entry.status, 401); assert.equal(entry.path, '/api/me'); assert.equal(typeof entry.ms, 'number');
  const accept = h.logs().find((l) => l.path?.includes('/accept'));
  assert.equal(accept.path, `/api/invites/${setup.slice(0, 4)}…/accept`);
  const afterSetup = h.output.slice(h.output.indexOf(`"path":"/api/invites`));
  assert.ok(!afterSetup.includes(setup), 'invite code is redacted from request logs');
  assert.ok(!h.output.includes(owner.token), 'token never logged');
  assert.ok(h.output.includes('token=[redacted]'));
});

test('browser errors are logged with their context and rate-limited', async (t) => {
  const h = await startHub(t);
  const res = await h.api('/api/client-errors', null, 'POST', { message: 'boom bc_' + 'a'.repeat(64), stack: 'at render (app.js:1:2)', url: 'http://x/#delegations' });
  assert.equal(res.status, 202);
  await waitFor(() => h.logs().some((l) => l.source === 'browser'));
  const entry = h.logs().find((l) => l.source === 'browser');
  assert.equal(entry.level, 'error'); assert.match(entry.msg, /^browser error: boom bc_\[redacted\]/);
  assert.equal(entry.page, 'http://x/#delegations'); assert.match(entry.err.stack, /render/);
  let limited = 0;
  for (let i = 0; i < 12; i++) if ((await h.api('/api/client-errors', null, 'POST', { message: 'x' })).status === 429) limited++;
  assert.ok(limited >= 2);
});

test('rate limits on public routes and writes, with Retry-After', async (t) => {
  const h = await startHub(t, null, { RATE_PUBLIC_PER_MIN: '4', RATE_WRITES_PER_MIN: '5' });
  const owner = await h.bootstrap(); // 1 public request
  for (let i = 0; i < 3; i++) assert.equal((await h.api('/api/invites/abcdef')).status, 404);
  const limited = await h.api('/api/invites/abcdef');
  assert.equal(limited.status, 429); assert.ok(Number(limited.headers.get('retry-after')) >= 1);
  const p = prefix(owner);
  const statuses = [];
  for (let i = 0; i < 7; i++) statuses.push((await h.api(p + '/messages', owner.token, 'POST', { text: 'hi' })).status);
  assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429, 429]);
  assert.equal((await h.api('/api/me', owner.token)).status, 200, 'reads have their own budget');
});

test('open streams per user are capped', async (t) => {
  const h = await startHub(t, null, { MAX_STREAMS_PER_USER: '2' });
  const owner = await h.bootstrap();
  const url = `${h.base}${prefix(owner)}/events?token=${owner.token}`;
  const a = await openStream(url), b = await openStream(url);
  const c = await openStream(url);
  assert.equal(c.status, 429);
  a.req.destroy();
  await delay(50);
  const d = await openStream(url);
  assert.equal(d.status, 200);
  b.req.destroy(); d.req.destroy();
});

test('signing out a browser closes its open stream; the main token keeps its own', async (t) => {
  const h = await startHub(t);
  const owner = await h.bootstrap();
  const link = await h.ok('/api/me/login-link', owner.token, 'POST');
  const browser = await h.ok(`/api/login/${link.code}`, null, 'POST');
  const viaSession = await openStream(`${h.base}${prefix(owner)}/events?token=${browser.token}`);
  const viaToken = await openStream(`${h.base}${prefix(owner)}/events?token=${owner.token}`);
  await h.ok('/api/me/logout', browser.token, 'POST');
  await waitFor(() => viaSession.ended);
  await delay(50);
  assert.equal(viaToken.ended, false);
  // Rotating the main token invalidates sign-in links that weren't used yet.
  const unused = await h.ok('/api/me/login-link', owner.token, 'POST');
  await h.ok('/api/me/token', owner.token, 'POST');
  assert.equal((await h.api(`/api/login/${unused.code}`, null, 'POST')).status, 404);
  await waitFor(() => viaToken.ended);
});

test('SIGTERM releases long polls without dequeuing, ends streams and exits cleanly', async (t) => {
  const h = await startHub(t);
  const owner = await h.bootstrap();
  const p = prefix(owner);
  await h.ok(p + '/agents', owner.token, 'POST', { id: 'worker' });
  await h.ok(p + '/agents', owner.token, 'POST', { id: 'other' });
  const stream = await openStream(`${h.base}${p}/events?token=${owner.token}`);
  const poll = fetch(`${h.base}${p}/agents/worker/inbox?wait=30`, { headers: { authorization: `Bearer ${owner.token}` } });
  await delay(100);
  // A message for another agent sits in its inbox through the restart.
  await h.ok(p + '/messages', owner.token, 'POST', { text: '@other later' });
  const started = Date.now();
  const exited = once(h.child, 'exit');
  h.child.kill('SIGTERM');
  const res = await poll;
  assert.equal(res.status, 200); assert.deepEqual(await res.json(), []);
  const [code] = await exited;
  assert.equal(code, 0);
  assert.ok(Date.now() - started < 3000, 'drains fast');
  await waitFor(() => stream.ended);
  assert.ok(h.logs().some((l) => l.msg === 'shutting down' && l.signal === 'SIGTERM'));
  assert.equal(query(h.dir, 'SELECT count(*) AS n FROM inbox')[0].n, 1);
  await h.restart();
  assert.equal((await h.ok(p + '/agents/other/inbox', owner.token))[0].text, '@other later');
});

test('bad configuration fails fast with a clear message', () => {
  const run = (env) => spawnSync(process.execPath, ['hub.js'], { cwd: ROOT, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 5000 });
  const r = run({ PORT: 'eighty', PUBLIC_URL: 'ftp://x', TRUST_PROXY: 'maybe', LOG_LEVEL: 'loud' });
  assert.equal(r.status, 1);
  for (const want of ['PORT must be', 'PUBLIC_URL must be', 'TRUST_PROXY must be', 'LOG_LEVEL must be']) assert.ok(r.stderr.includes(want), want);
});

test('Railway defaults: public URL from its domain, client IP from X-Forwarded-For', async (t) => {
  const railway = loadConfig({ RAILWAY_ENVIRONMENT: 'production', RAILWAY_PUBLIC_DOMAIN: 'hub.up.railway.app' });
  assert.equal(railway.publicUrl, 'https://hub.up.railway.app'); assert.equal(railway.trustProxy, 'railway');
  const explicit = loadConfig({ RAILWAY_PUBLIC_DOMAIN: 'hub.up.railway.app', PUBLIC_URL: 'https://hub.example.com', TRUST_PROXY: '' });
  assert.equal(explicit.publicUrl, 'https://hub.example.com'); assert.equal(explicit.trustProxy, null);
  assert.equal(loadConfig({}).trustProxy, null);
  const h = await startHub(t, null, { TRUST_PROXY: 'railway' });
  await h.api('/api/me', null, 'GET', undefined, { 'x-forwarded-for': '198.51.100.7, 100.64.0.2', 'x-request-id': 'rw' });
  await waitFor(() => h.logs().some((l) => l.requestId === 'rw'));
  assert.equal(h.logs().find((l) => l.requestId === 'rw').ip, '198.51.100.7');
});

test('trusted proxy headers are used only when TRUST_PROXY says so', async (t) => {
  const plain = await startHub(t);
  await plain.api('/api/me', null, 'GET', undefined, { 'fly-client-ip': '203.0.113.9', 'x-request-id': 'p1' });
  await waitFor(() => plain.logs().some((l) => l.requestId === 'p1'));
  assert.equal(plain.logs().find((l) => l.requestId === 'p1').ip, '127.0.0.1');
  const fly = await startHub(t, null, { TRUST_PROXY: 'fly' });
  await fly.api('/api/me', null, 'GET', undefined, { 'fly-client-ip': '203.0.113.9', 'x-forwarded-for': '1.1.1.1', 'x-request-id': 'p2' });
  await waitFor(() => fly.logs().some((l) => l.requestId === 'p2'));
  assert.equal(fly.logs().find((l) => l.requestId === 'p2').ip, '203.0.113.9');
});

test('the hub serves an installable client package and longer-lived sign-in links for it', async (t) => {
  const h = await startHub(t);
  const res = await fetch(h.base + '/install/backchannel.tgz');
  assert.equal(res.status, 200); assert.equal(res.headers.get('content-type'), 'application/gzip');
  const tar = zlib.gunzipSync(Buffer.from(await res.arrayBuffer()));
  const files = {};
  for (let at = 0; at + 512 <= tar.length;) {
    const name = tar.subarray(at, at + 100).toString().replace(/\0.*$/s, '');
    if (!name) break;
    const size = parseInt(tar.subarray(at + 124, at + 136).toString(), 8);
    files[name] = tar.subarray(at + 512, at + 512 + size).toString();
    at += 512 + Math.ceil(size / 512) * 512;
  }
  const manifest = JSON.parse(files['package/package.json']);
  assert.equal(manifest.bin.backchannel, 'bin/backchannel.js');
  assert.equal(manifest.version, JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version);
  for (const f of ['bin/backchannel.js', 'cli.js', 'client.js', 'agent.js', 'backends.js', 'mcp.js', 'setup.js']) assert.ok(files[`package/${f}`], f);
  assert.ok(!Object.keys(files).some((f) => f.includes('server/') || f.endsWith('hub.js')), 'server code is not shipped to clients');

  const owner = await h.bootstrap();
  assert.equal((await h.ok('/api/me/login-link', owner.token, 'POST')).expiresInSeconds, 60);
  assert.equal((await h.ok('/api/me/login-link', owner.token, 'POST', { expiresInSeconds: 600 })).expiresInSeconds, 600);
  for (const bad of [601, 5, 1.5, '600']) assert.equal((await h.api('/api/me/login-link', owner.token, 'POST', { expiresInSeconds: bad })).status, 400);
});

test('automatic backups run when due and keep the newest copies', (t) => {
  const dir = tempDir(t);
  const db = openDb(dir);
  const first = backupIfDue(db, dir, 24, 3);
  assert.ok(first && fs.existsSync(first.file));
  assert.equal(backupIfDue(db, dir, 24, 3), null, 'not due again yet');
  const backups = path.join(dir, 'backups');
  for (const day of ['01', '02', '03', '04']) fs.writeFileSync(path.join(backups, `backchannel-2026-01-${day}T00-00-00-000Z.db`), 'old');
  const old = new Date(Date.now() - 25 * 3_600_000);
  for (const f of fs.readdirSync(backups)) fs.utimesSync(path.join(backups, f), old, old);
  const second = backupIfDue(db, dir, 24, 3);
  assert.ok(second, 'due once the newest copy is older than the interval');
  const left = fs.readdirSync(backups).sort();
  assert.equal(left.length, 3);
  assert.ok(left.includes(path.basename(first.file)) && left.includes(path.basename(second.file)));
  assert.ok(!left.includes('backchannel-2026-01-01T00-00-00-000Z.db'));
  db.close();
});

test('setup-link and backup commands; a backup restores as a working hub', async (t) => {
  const h = await startHub(t);
  const cli = (...args) => spawnSync(process.execPath, ['hub.js', ...args], { cwd: ROOT, env: { ...process.env, DATA_DIR: h.dir, PUBLIC_URL: 'https://hub.example' }, encoding: 'utf8' });
  assert.equal(cli('setup-link').stdout.trim(), `https://hub.example/#join/${h.setup}`);
  const owner = await h.bootstrap();
  await h.ok(prefix(owner) + '/messages', owner.token, 'POST', { text: 'keep me' });
  assert.match(cli('setup-link').stdout, /already has an owner/);
  const backups = tempDir(t);
  const file = path.join(backups, 'copy.db');
  const r = cli('backup', file); // while the hub is running
  assert.equal(r.status, 0, r.stderr);
  assert.equal(cli('backup', file).status, 1, 'never overwrites');
  const restored = await startHub(t, (dir) => fs.copyFileSync(file, path.join(dir, 'backchannel.db')));
  assert.equal((await restored.ok(prefix(owner) + '/messages', owner.token))[0].text, 'keep me');
});

test('the Docker image contains every file the client package ships', () => {
  const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
  const copied = dockerfile.split('\n').filter((l) => l.startsWith('COPY ')).flatMap((l) => l.split(/\s+/).slice(1, -1));
  for (const f of CLIENT_FILES.filter((f) => fs.existsSync(path.join(ROOT, f)) && f !== 'LICENSE')) {
    assert.ok(copied.some((c) => f === c || f.startsWith(c.replace(/\/?$/, '/'))), `${f} is missing from the Dockerfile, so installs from a deployed hub would lack it`);
  }
});
