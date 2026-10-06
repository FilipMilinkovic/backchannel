import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { Store } from '../server/store.js';
import { authenticate, hashToken, newToken } from '../server/auth.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function startHub(t, seed) {
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
    const usersFile = path.join(dir, 'users.json');
    const needsSetup = !fs.existsSync(usersFile) || JSON.parse(fs.readFileSync(usersFile, 'utf8')).length === 0;
    child = spawn(process.execPath, ['hub.js'], { cwd: ROOT,
      env: { ...process.env, DATA_DIR: dir, HOST: '127.0.0.1', PORT: '0', PUBLIC_URL: '', HUB_TOKEN: '', MAX_HOPS: '' },
      stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (data) => { output += data; });
    child.stderr.on('data', (data) => { output += data; });
    const deadline = Date.now() + 5000;
    while (!/Backchannel hub on http:\/\/127\.0\.0\.1:\d+\r?\n/.test(output)
      || (needsSetup && !/Setup link: .*\/#join\/[a-f0-9]+\r?\n/.test(output))) {
      if (child.exitCode !== null || Date.now() > deadline) throw new Error(`Hub failed to start: ${output}`);
      await delay(10);
    }
    base = output.match(/Backchannel hub on (http:\/\/127\.0\.0\.1:\d+)/)[1];
  }
  t.after(async () => { await stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  await start();
  const hub = {
    dir, get base() { return base; }, get output() { return output; },
    get setup() { return output.match(/Setup link: .*\/#join\/([a-f0-9]+)/)?.[1]; },
    async restart() { await stop(); await start(); },
    async api(route, token, method = 'GET', body) {
      const response = await fetch(base + route, { method,
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, body: await response.json() };
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
const prefix = (account) => `/api/teams/${account.team.id}`;

test('messages append one log line each and validate optional titles', async (t) => {
  const h = await startHub(t);
  const owner = await h.bootstrap();
  const p = prefix(owner);
  const log = path.join(h.dir, 'messages.jsonl');
  const posted = [];
  let contents = '';
  for (const title of [undefined, '  Delegation title  ', 'x'.repeat(120), '   ']) {
    const message = await h.ok(p + '/messages', owner.token, 'POST', { text: 'hello\nworld', title });
    if (title === undefined) assert.ok(!Object.hasOwn(message, 'title'));
    else assert.equal(message.title, title.trim());
    posted.push(message);
    contents += JSON.stringify(message) + '\n';
    assert.equal(fs.readFileSync(log, 'utf8'), contents);
    assert.equal(contents.trimEnd().split('\n').length, posted.length);
  }
  for (const title of ['x'.repeat(121), null, 42, {}, []]) {
    assert.equal((await h.api(p + '/messages', owner.token, 'POST', { text: 'invalid', title })).status, 400);
    assert.equal(fs.readFileSync(log, 'utf8'), contents);
  }
  await h.restart();
  assert.deepEqual(await h.ok(p + '/messages', owner.token), posted);
});

test('bootstrap, authentication, public views and token rotation persist', async (t) => {
  const h = await startHub(t);
  assert.ok(h.setup);
  assert.equal(h.output.split('Setup link:').length - 1, 1);
  assert.equal((await h.ok(`/api/invites/${h.setup}`)).role, 'owner');
  assert.equal((await h.api('/api/me')).status, 401);
  assert.equal((await fetch(h.base + '/')).status, 200);
  const owner = await h.bootstrap();
  assert.match(owner.token, /^bc_[a-f0-9]{64}$/);
  assert.equal(owner.team.role, 'owner');
  assert.equal((await h.api(`/api/invites/${h.setup}`)).status, 404);
  assert.equal((await h.ok('/api/me', owner.token)).teams[0].id, owner.team.id);
  assert.equal((await h.api('/api/agents', owner.token)).status, 404);
  assert.equal((await h.api(`/api/me?token=${owner.token}`)).status, 401);
  const users = fs.readFileSync(path.join(h.dir, 'users.json'), 'utf8');
  assert.ok(!users.includes(owner.token));
  assert.match(JSON.parse(users)[0].tokenHash, /^[a-f0-9]{64}$/);
  const rotated = await h.ok('/api/me/token', owner.token, 'POST');
  assert.equal((await h.api('/api/me', owner.token)).status, 401);
  assert.equal((await h.ok('/api/me', rotated.token)).user.id, owner.user.id);
  await h.restart();
  assert.ok(!h.setup);
  assert.equal((await h.ok('/api/me', rotated.token)).user.id, owner.user.id);
});

test('roles, agent ownership, last owner protection and leaving', async (t) => {
  const h = await startHub(t);
  const owner = await h.bootstrap();
  const member = await h.join(owner, 'member', 'bob');
  const viewer = await h.join(owner, 'viewer', 'eve');
  const p = prefix(owner);
  await h.ok(p + '/agents', owner.token, 'POST', { id: 'claude' });
  await h.ok(p + '/agents', member.token, 'POST', { id: 'codex' });
  for (const [method, route, body] of [
    ['POST', '/messages', { text: 'no' }], ['POST', '/agents', { id: 'evebot' }],
    ['PATCH', '', { name: 'bad' }], ['POST', '/invites', {}],
  ]) assert.equal((await h.api(p + route, viewer.token, method, body)).status, 403);
  for (const [method, route, body] of [
    ['GET', '/agents/claude/inbox'], ['POST', '/messages', { from: 'claude', text: 'no' }],
    ['DELETE', '/agents/claude'], ['POST', '/agents/claude/status', {}], ['POST', '/agents/claude/requeue', { ids: [] }],
  ]) assert.equal((await h.api(p + route, member.token, method, body)).status, 403);
  assert.equal((await h.api(p + '/agents', member.token, 'POST', { id: 'claude' })).status, 409);
  assert.equal((await h.api(p + '/agents/codex/inbox', owner.token)).status, 403);
  await h.ok(p + '/agents/codex', owner.token, 'DELETE');
  for (const [method, body] of [['PATCH', { role: 'member' }], ['DELETE', undefined]]) {
    assert.equal((await h.api(p + `/members/${owner.user.id}`, owner.token, method, body)).status, 403);
  }
  await h.ok(p + '/agents', member.token, 'POST', { id: 'codex' });
  await h.ok(p + `/members/${member.user.id}`, member.token, 'DELETE');
  assert.equal((await h.api(p, member.token)).status, 404);
  assert.ok(!(await h.ok(p + '/agents', owner.token)).some((a) => a.id === 'codex'));
  await h.ok(p + `/members/${viewer.user.id}`, owner.token, 'PATCH', { role: 'owner' });
  await h.ok(p + `/members/${owner.user.id}`, owner.token, 'DELETE');
  assert.equal((await h.api(p, owner.token)).status, 404);
  assert.deepEqual(await h.ok(p + '/agents', viewer.token), []);
});

test('invite expiry, uses, revocation, existing users and validation', async (t) => {
  const h = await startHub(t);
  const owner = await h.bootstrap();
  const p = prefix(owner);
  const invite = await h.ok(p + '/invites', owner.token, 'POST', { uses: 2 });
  assert.equal(invite.url, `${h.base}/#join/${invite.code}`);
  const bob = await h.ok(`/api/invites/${invite.code}/accept`, null, 'POST', { handle: 'bob' });
  const repeat = await h.ok(`/api/invites/${invite.code}/accept`, bob.token, 'POST', {});
  assert.equal(repeat.token, undefined);
  await h.ok(`/api/invites/${invite.code}/accept`, null, 'POST', { handle: 'eve' });
  assert.equal((await h.api(`/api/invites/${invite.code}`)).status, 404);
  assert.equal((await h.api(`/api/invites/${invite.code}/accept`, null, 'POST', { handle: 'third' })).status, 404);
  const revoked = await h.ok(p + '/invites', owner.token, 'POST', {});
  await h.ok(p + `/invites/${revoked.code}`, owner.token, 'DELETE');
  assert.equal((await h.api(`/api/invites/${revoked.code}`)).status, 404);
  const expired = await h.ok(p + '/invites', owner.token, 'POST', { expiresInHours: 0.00001 });
  await delay(60);
  assert.equal((await h.api(`/api/invites/${expired.code}`)).status, 404);
  const team = (await h.ok('/api/teams', owner.token, 'POST', { name: 'Second' })).team;
  const existingInvite = await h.ok(`/api/teams/${team.id}/invites`, owner.token, 'POST', {});
  const existing = await h.ok(`/api/invites/${existingInvite.code}/accept`, bob.token, 'POST', {});
  assert.equal(existing.user.id, bob.user.id);
  assert.equal(existing.token, undefined);
  assert.equal((await h.ok('/api/me', bob.token)).teams.length, 2);
  for (const body of [{ role: 'admin' }, { uses: 0 }, { uses: 1.5 }, { expiresInHours: -1 }]) {
    assert.equal((await h.api(p + '/invites', owner.token, 'POST', body)).status, 400);
  }
  assert.equal((await h.api('/api/teams', owner.token, 'POST', null)).status, 400);
});

test('team isolation includes messages, thread references, inboxes and requeue', async (t) => {
  const h = await startHub(t);
  const owner = await h.bootstrap();
  const bob = await h.join(owner, 'member', 'bob');
  const a = prefix(owner);
  const teamB = (await h.ok('/api/teams', bob.token, 'POST', { name: 'Private' })).team;
  const b = `/api/teams/${teamB.id}`;
  for (const route of ['', '/agents', '/messages', '/threads', '/members', '/events', '/invites']) {
    assert.equal((await h.api(b + route, owner.token)).status, 404);
  }
  await h.ok(a + '/agents', owner.token, 'POST', { id: 'same' });
  await h.ok(b + '/agents', bob.token, 'POST', { id: 'same' });
  await h.ok(b + '/agents', bob.token, 'POST', { id: 'only-b' });
  const ma = await h.ok(a + '/messages', owner.token, 'POST', { text: '@same @only-b hello' });
  assert.equal((await h.ok(a + '/agents/same/inbox', owner.token)).length, 1);
  assert.deepEqual(await h.ok(b + '/agents/same/inbox', bob.token), []);
  assert.deepEqual(await h.ok(b + '/agents/only-b/inbox', bob.token), []);
  assert.deepEqual(await h.ok(b + '/messages', bob.token), []);
  const mb = await h.ok(b + '/messages', bob.token, 'POST', { text: '@same secret' });
  for (const body of [{ inReplyTo: mb.id }, { threadId: mb.threadId }]) {
    assert.equal((await h.api(a + '/messages', owner.token, 'POST', { text: 'no', ...body })).status, 404);
  }
  assert.equal((await h.api(a + `/threads/${mb.threadId}`, owner.token)).status, 404);
  assert.equal((await h.ok(a + '/agents/same/requeue', owner.token, 'POST', { ids: [mb.id] })).requeued, 0);
  assert.equal((await h.ok(a + '/agents/same/requeue', owner.token, 'POST', { ids: [ma.id, ma.id] })).requeued, 1);
});

test('routing distinguishes user and agent senders and retains hop/error behavior', async (t) => {
  const h = await startHub(t);
  const owner = await h.bootstrap();
  const p = prefix(owner);
  for (const id of ['alice', 'worker']) await h.ok(p + '/agents', owner.token, 'POST', { id });
  const parent = await h.ok(p + '/messages', owner.token, 'POST', { text: '@worker start' });
  assert.equal(parent.fromKind, 'user'); assert.equal(parent.by, owner.user.id); assert.equal(parent.hop, 0);
  const reply = await h.ok(p + '/messages', owner.token, 'POST', { from: 'worker', text: 'answer', inReplyTo: parent.id, kind: 'declined' });
  assert.deepEqual(reply.to, []); assert.equal(reply.kind, 'declined'); assert.equal(reply.hop, 1);
  assert.deepEqual(await h.ok(p + '/agents/alice/inbox', owner.token), []);
  const follow = await h.ok(p + '/messages', owner.token, 'POST', { text: 'continue', threadId: parent.threadId });
  assert.deepEqual(follow.to, ['worker']);
  const selfHandle = await h.ok(p + '/messages', owner.token, 'POST', { text: '@alice hello' });
  assert.deepEqual(selfHandle.to, ['alice']);
  await h.ok(p, owner.token, 'PATCH', { maxHops: 1 });
  const stopped = await h.ok(p + '/messages', owner.token, 'POST', { from: 'worker', text: '@alice error', kind: 'error' });
  assert.match(stopped.note, /hop limit \(1\)/); assert.equal(stopped.kind, 'error');
  assert.deepEqual((await h.ok(p + '/agents/alice/inbox', owner.token)).map((m) => m.id), [selfHandle.id]);
});

test('long polling survives re-registration, status/requeue and restart', async (t) => {
  const h = await startHub(t);
  const owner = await h.bootstrap();
  const p = prefix(owner);
  await h.ok(p + '/agents', owner.token, 'POST', { id: 'worker' });
  const pending = h.ok(p + '/agents/worker/inbox?wait=2', owner.token);
  await delay(30);
  await h.ok(p + '/agents', owner.token, 'POST', { id: 'worker', name: 'Updated' });
  const message = await h.ok(p + '/messages', owner.token, 'POST', { text: '@worker hello' });
  assert.deepEqual((await pending).map((m) => m.id), [message.id]);
  await h.ok(p + '/agents/worker/status', owner.token, 'POST', { state: 'working', threadId: message.threadId });
  let agent = (await h.ok(p + '/agents', owner.token))[0];
  assert.equal(agent.state, 'working'); assert.equal(agent.stateThread, message.threadId);
  const next = h.ok(p + '/agents/worker/inbox?wait=2', owner.token);
  await delay(30);
  await h.ok(p + '/agents/worker/requeue', owner.token, 'POST', { ids: [message.id] });
  assert.equal((await next)[0].id, message.id);
  await h.ok(p + '/agents/worker/requeue', owner.token, 'POST', { ids: [message.id] });
  await h.restart();
  agent = (await h.ok(p + '/agents', owner.token))[0];
  assert.equal(agent.name, 'Updated'); assert.equal(agent.online, false); assert.equal(agent.state, 'idle');
  assert.equal((await h.ok(p + '/agents/worker/inbox', owner.token))[0].id, message.id);
  const card = await h.ok(p + '/agents/worker/card', owner.token);
  assert.equal(card.url, h.base + p + '/agents/worker');
});

test('disconnected polls preserve later messages and removed agents wake pending polls', async (t) => {
  const h = await startHub(t);
  const owner = await h.bootstrap();
  const p = prefix(owner);
  await h.ok(p + '/agents', owner.token, 'POST', { id: 'worker' });
  const request = http.get(h.base + p + '/agents/worker/inbox?wait=30', { headers: { authorization: `Bearer ${owner.token}` } });
  request.on('error', () => {});
  await delay(40);
  request.destroy();
  await delay(30);
  const message = await h.ok(p + '/messages', owner.token, 'POST', { text: '@worker retain' });
  assert.equal((await h.ok(p + '/agents/worker/inbox', owner.token))[0].id, message.id);
  const pending = h.api(p + '/agents/worker/inbox?wait=30', owner.token);
  await delay(30);
  await h.ok(p + '/agents/worker', owner.token, 'DELETE');
  assert.equal((await pending).status, 404);
});

test('role changes and token rotation terminate outstanding agent polls', async (t) => {
  const h = await startHub(t);
  const owner = await h.bootstrap();
  const bob = await h.join(owner, 'member', 'bob');
  const p = prefix(owner);
  await h.ok(p + '/agents', bob.token, 'POST', { id: 'worker' });
  const pending = h.api(p + '/agents/worker/inbox?wait=30', bob.token);
  await delay(30);
  await h.ok(p + `/members/${bob.user.id}`, owner.token, 'PATCH', { role: 'viewer' });
  assert.equal((await pending).status, 403);
  await h.ok(p + `/members/${bob.user.id}`, owner.token, 'PATCH', { role: 'member' });
  const pendingRotation = h.api(p + '/agents/worker/inbox?wait=30', bob.token);
  await delay(30);
  await h.ok('/api/me/token', bob.token, 'POST');
  assert.equal((await pendingRotation).status, 401);
});

async function events(h, team, token) {
  const controller = new AbortController();
  const response = await fetch(`${h.base}/api/teams/${team}/events?token=${token}`, { signal: controller.signal });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const seen = [];
  const done = (async () => {
    let buffer = '';
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += new TextDecoder().decode(value);
        let end;
        while ((end = buffer.indexOf('\n\n')) !== -1) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          if (line.startsWith('data: ')) seen.push(JSON.parse(line.slice(6)));
        }
      }
    } catch (err) { if (err.name !== 'AbortError') throw err; }
  })();
  return { seen, done, close() { controller.abort(); } };
}

test('SSE emits team-scoped members, agents, message, status and config events', async (t) => {
  const h = await startHub(t);
  const owner = await h.bootstrap();
  const second = (await h.ok('/api/teams', owner.token, 'POST', { name: 'Second' })).team;
  const a = await events(h, owner.team.id, owner.token);
  const b = await events(h, second.id, owner.token);
  t.after(async () => { a.close(); b.close(); await Promise.all([a.done, b.done]); });
  const p = prefix(owner);
  await h.join(owner, 'member', 'bob');
  await h.ok(p + '/agents', owner.token, 'POST', { id: 'worker' });
  const message = await h.ok(p + '/messages', owner.token, 'POST', { text: '@worker event' });
  await h.ok(p + '/agents/worker/status', owner.token, 'POST', { state: 'working', threadId: message.threadId });
  await h.ok(p, owner.token, 'PATCH', { maxHops: 3 });
  await delay(30);
  for (const type of ['hello', 'members', 'agents', 'message', 'status', 'config']) assert.ok(a.seen.some((e) => e.type === type), type);
  assert.deepEqual(b.seen.map((e) => e.type), ['hello']);
  for (const [stream, team] of [[a, owner.team], [b, second]]) {
    const hello = stream.seen.find((e) => e.type === 'hello');
    assert.equal(hello.role, 'owner');
    assert.deepEqual(hello.members, team.members);
    assert.deepEqual(hello.agents, []);
    assert.equal(hello.config.maxHops, 8);
  }
  await h.ok('/api/me/token', owner.token, 'POST');
  await Promise.all([a.done, b.done]);
});

test('SSE reconnects with fresh members and role after a role change', async (t) => {
  const h = await startHub(t);
  const owner = await h.bootstrap();
  const bob = await h.join(owner, 'member', 'bob');
  const before = await events(h, owner.team.id, bob.token);
  t.after(async () => { before.close(); await before.done; });
  const p = prefix(owner);
  await h.ok(p + `/members/${bob.user.id}`, owner.token, 'PATCH', { role: 'viewer' });
  await before.done;
  assert.equal(before.seen[0].role, 'member');
  const after = await events(h, owner.team.id, bob.token);
  t.after(async () => { after.close(); await after.done; });
  const currentMembers = await h.ok(p + '/members', bob.token);
  await h.ok('/api/me/token', bob.token, 'POST');
  await after.done;
  assert.equal(after.seen[0].type, 'hello');
  assert.equal(after.seen[0].role, 'viewer');
  assert.deepEqual(after.seen[0].members, currentMembers);
});

test('v1 migration preserves messages, agents, inboxes and configured hop limit', async (t) => {
  const h = await startHub(t, (dir) => {
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ maxHops: 5 }));
    fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify({ agents: [{ id: 'legacy', name: 'Legacy', lastSeen: Date.now() }], inboxes: { legacy: ['old'] } }));
    fs.writeFileSync(path.join(dir, 'messages.jsonl'), JSON.stringify({ id: 'old', threadId: 'old', from: 'human', text: '@legacy hi', to: ['legacy'], hop: 0, ts: 1 }) + '\n');
  });
  const owner = await h.bootstrap();
  assert.equal(owner.team.name, 'Backchannel'); assert.equal(owner.team.maxHops, 5);
  const p = prefix(owner);
  const agent = (await h.ok(p + '/agents', owner.token))[0];
  assert.equal(agent.ownerUserId, owner.user.id); assert.equal(agent.ownerHandle, 'alice');
  const message = (await h.ok(p + '/agents/legacy/inbox', owner.token))[0];
  assert.equal(message.id, 'old'); assert.equal(message.teamId, owner.team.id); assert.equal(message.fromKind, 'user');
  await h.restart();
  assert.equal((await h.ok('/api/me', owner.token)).teams.length, 1);
  assert.equal((await h.ok(p + '/messages', owner.token)).length, 1);
});

test('store: appending messages preserves existing log bytes and adds one line', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backchannel-store-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir);
  const log = path.join(dir, 'messages.jsonl');
  // Existing formatting must survive: rewriting parsed messages would normalize it.
  let contents = `{ "id": "old", "teamId": "${store.teams[0].id}", "text": "existing" }\n`;
  fs.writeFileSync(log, contents);
  const restored = new Store(dir);
  for (const id of ['new1', 'new2']) {
    const message = { id, teamId: store.teams[0].id, text: 'new\nmessage' };
    restored.persistMessage(message);
    contents += JSON.stringify(message) + '\n';
    assert.equal(fs.readFileSync(log, 'utf8'), contents);
    assert.equal(contents.trimEnd().split('\n').length, restored.messages.length);
    assert.equal(restored.byId.get(id), message);
  }
  assert.equal(new Store(dir).messages.length, 3);
});

test('store: atomic snapshots, bootstrap reuse, migration and registry restoration', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backchannel-store-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify({ agents: [{ id: 'oldbot' }], inboxes: { oldbot: ['m1'] } }));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ maxHops: 4 }));
  fs.writeFileSync(path.join(dir, 'messages.jsonl'), JSON.stringify({ id: 'm1', threadId: 'm1', from: 'oldbot', text: 'legacy', to: ['oldbot'] }) + '\n');
  const first = new Store(dir);
  assert.equal(first.teams.length, 1);
  const team = first.teams[0];
  assert.equal(team.name, 'Backchannel'); assert.equal(team.maxHops, 4);
  assert.equal(first.messages[0].fromKind, 'agent'); assert.equal(first.messages[0].by, null);
  const key = `${team.id}/oldbot`;
  assert.equal(first.inboxes.get(key)[0].id, 'm1');
  first.users.push({ id: 'u1', handle: 'owner', tokenHash: hashToken(newToken()) });
  first.saveUsers();
  first.persistMessage({ id: 'm2', teamId: team.id, text: 'new' });
  const restored = new Store(dir);
  assert.equal(restored.teams.length, 1); assert.equal(restored.setupInvite, undefined);
  assert.equal(restored.messages.length, 2); assert.equal(restored.agents.get(key).state, 'idle');
  assert.equal(restored.agents.get(key).lastSeen, 0);
  assert.equal(restored.inboxes.get(key)[0].id, 'm1');
  assert.ok(!fs.readdirSync(dir).some((name) => name.endsWith('.tmp')));
  const freshDir = path.join(dir, 'fresh');
  const fresh = new Store(freshDir);
  assert.equal(new Store(freshDir).setupInvite.code, fresh.setupInvite.code);
  assert.equal(fresh.findInvite(fresh.setupInvite.code).team.id, fresh.teams[0].id);
  fresh.setupInvite.expiresAt = Date.now() - 1;
  assert.equal(fresh.findInvite(fresh.setupInvite.code), null);
  fresh.setupInvite.expiresAt = Date.now() + 1000; fresh.setupInvite.usesLeft = 0;
  assert.equal(fresh.findInvite(fresh.setupInvite.code), null);
});

test('auth: hash lookup, optional invite authentication and SSE query tokens', () => {
  const token = newToken();
  assert.match(token, /^bc_[a-f0-9]{64}$/);
  const user = { id: 'u1', tokenHash: hashToken(token) };
  const url = new URL('http://localhost/api/me');
  assert.equal(authenticate({ headers: { authorization: `Bearer ${token}` } }, url, [user]), user);
  assert.equal(authenticate({ headers: {} }, url, [user], true), null);
  assert.throws(() => authenticate({ headers: {} }, url, [user]), { status: 401 });
  assert.throws(() => authenticate({ headers: { authorization: 'Bearer bad' } }, url, [user], true), { status: 401 });
  assert.throws(() => authenticate({ headers: {} }, new URL(`${url}?token=${token}`), [user]), { status: 401 });
  assert.equal(authenticate({ headers: {} }, new URL(`http://localhost/api/teams/a/events?token=${token}`), [user]), user);
  user.tokenHash = hashToken(newToken());
  assert.throws(() => authenticate({ headers: { authorization: `Bearer ${token}` } }, url, [user]), { status: 401 });
});

test('one-time sign-in links create revocable browser sessions', async (t) => {
  const h = await startHub(t);
  const owner = await h.bootstrap();
  assert.equal((await h.api('/api/me/login-link', null, 'POST')).status, 401);
  const link = await h.ok('/api/me/login-link', owner.token, 'POST');
  assert.match(link.url, /\/#login\/[a-f0-9]{40,}$/);
  const login = await h.ok(`/api/login/${link.code}`, null, 'POST', { label: 'test browser' });
  assert.match(login.token, /^bc_[a-f0-9]{64}$/);
  assert.notEqual(login.token, owner.token);
  assert.equal(login.user.handle, 'alice');
  assert.equal((await h.ok('/api/me', login.token)).user.handle, 'alice');
  assert.equal((await h.api(`/api/login/${link.code}`, null, 'POST')).status, 404, 'links are single-use');
  assert.equal((await h.api('/api/login/abcdef0123', null, 'POST')).status, 404);
  assert.ok(!JSON.stringify(await h.ok('/api/me', owner.token)).includes('sessions'), 'session hashes never leak');

  // Signing out revokes only that browser; the main token can't be "logged out".
  await h.ok('/api/me/logout', login.token, 'POST');
  assert.equal((await h.api('/api/me', login.token)).status, 401);
  assert.equal((await h.api('/api/me/logout', owner.token, 'POST')).status, 400);
  assert.equal((await h.ok('/api/me', owner.token)).user.handle, 'alice');

  // Rotating the main token signs out every browser, and sessions survive restarts until then.
  const second = await h.ok(`/api/login/${(await h.ok('/api/me/login-link', owner.token, 'POST')).code}`, null, 'POST');
  await h.restart();
  await h.ok('/api/me', second.token);
  await h.ok('/api/me/token', owner.token, 'POST');
  assert.equal((await h.api('/api/me', second.token)).status, 401);
});
