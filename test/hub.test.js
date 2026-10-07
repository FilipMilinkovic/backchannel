import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { openDb } from '../server/db.js';
import { createRepo } from '../server/repo.js';
import { authenticate, hashToken, newToken } from '../server/auth.js';
import { startHub, query, prefix, delay, tempDir } from './helpers.js';

test('messages persist one row each and validate optional titles', async (t) => {
  const h = await startHub(t);
  const owner = await h.bootstrap();
  const p = prefix(owner);
  const rows = () => query(h.dir, 'SELECT body FROM messages ORDER BY seq').map((r) => JSON.parse(r.body));
  const posted = [];
  for (const title of [undefined, '  Delegation title  ', 'x'.repeat(120), '   ']) {
    const message = await h.ok(p + '/messages', owner.token, 'POST', { text: 'hello\nworld', title });
    if (title === undefined) assert.ok(!Object.hasOwn(message, 'title'));
    else assert.equal(message.title, title.trim());
    posted.push(message);
    assert.deepEqual(rows(), posted);
  }
  for (const title of ['x'.repeat(121), null, 42, {}, []]) {
    assert.equal((await h.api(p + '/messages', owner.token, 'POST', { text: 'invalid', title })).status, 400);
    assert.equal(rows().length, posted.length);
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
  for (const file of fs.readdirSync(h.dir)) assert.ok(!fs.readFileSync(path.join(h.dir, file)).includes(owner.token), `token stored in ${file}`);
  assert.equal(query(h.dir, 'SELECT token_hash FROM users')[0].token_hash, hashToken(owner.token));
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


test('db: schema migrations, setup invite reuse and expiry', (t) => {
  const dir = tempDir(t);
  const db = openDb(dir);
  const repo = createRepo(db);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2);
  assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  const setup = repo.setupInvite();
  assert.equal(setup.role, 'owner'); assert.equal(setup.createdBy, null);
  assert.equal(repo.setupInvite().code, setup.code, 'reused until claimed');
  assert.equal(repo.findInvite(setup.code).team.name, 'Backchannel');
  db.prepare('UPDATE invites SET expires_at = ?').run(Date.now() - 1);
  assert.equal(repo.findInvite(setup.code), null);
  assert.notEqual(repo.setupInvite().code, setup.code, 'an expired setup invite is replaced');
  db.close();
  // Reopening is idempotent, and a database from a newer hub is refused.
  const again = openDb(dir);
  const repo2 = createRepo(again);
  assert.equal(repo2.activeInvites(repo2.firstTeam().id).length, 1);
  again.exec('PRAGMA user_version = 99'); again.close();
  assert.throws(() => openDb(dir), { code: 'DB_TOO_NEW' });
});

test('db: imports v2 JSON data once, including sessions, inboxes and invites', (t) => {
  const dir = tempDir(t);
  const token = newToken(), session = newToken();
  const team = { id: 'aaaa11112222', name: 'Payments', createdAt: 1, maxHops: 6,
    members: [{ userId: 'u1', role: 'owner', joinedAt: 2 }, { userId: 'u2', role: 'viewer', joinedAt: 3 }, { userId: 'ghost', role: 'member', joinedAt: 4 }],
    invites: [{ code: 'abcdef012345abcdef012345', role: 'member', createdBy: 'u1', createdAt: 5, expiresAt: Date.now() + 60_000, usesLeft: 2 }] };
  fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify([
    { id: 'u1', handle: 'maya', name: 'Maya', tokenHash: hashToken(token), createdAt: 1, sessions: [{ hash: hashToken(session), label: 'laptop', createdAt: Date.now() }] },
    { id: 'u2', handle: 'sam', name: 'Sam', tokenHash: hashToken(newToken()), createdAt: 2 }]));
  fs.writeFileSync(path.join(dir, 'teams.json'), JSON.stringify([team]));
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify({
    agents: [{ id: 'bot', teamId: team.id, ownerUserId: 'u1', name: 'Bot', backend: 'echo', skills: [], registeredAt: 7, lastSeen: 9, state: 'working' }],
    inboxes: { [`${team.id}/bot`]: ['m2', 'missing'] } }));
  const msgs = [
    { id: 'm1', teamId: team.id, threadId: 'm1', inReplyTo: null, from: 'maya', fromKind: 'user', by: 'u1', text: 'first', ts: 10, hop: 0, to: [] },
    { id: 'm2', teamId: team.id, threadId: 'm1', inReplyTo: 'm1', from: 'maya', fromKind: 'user', by: 'u1', text: '@bot hi', ts: 11, hop: 0, to: ['bot'], title: 'T' }];
  const lines = msgs.map((m) => JSON.stringify(m));
  // Damage in the middle of the log stops the import (and changes nothing)...
  fs.writeFileSync(path.join(dir, 'messages.jsonl'), [lines[0], '{not json', lines[1]].join('\n') + '\n');
  assert.throws(() => openDb(dir), /messages\.jsonl: line 2 is not valid JSON/);
  assert.ok(fs.existsSync(path.join(dir, 'users.json')));
  // ...but a torn last line from a crash mid-append is dropped.
  fs.writeFileSync(path.join(dir, 'messages.jsonl'), lines.join('\n') + '\n{"id":"torn');

  const repo = createRepo(openDb(dir));
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.imported')).sort(),
    ['agents.json.imported', 'messages.jsonl.imported', 'teams.json.imported', 'users.json.imported']);
  assert.equal(repo.userByTokenHash(hashToken(token)).handle, 'maya');
  assert.equal(repo.sessionByHash(hashToken(session)).label, 'laptop');
  assert.deepEqual(repo.members(team.id).map((m) => [m.handle, m.role]), [['maya', 'owner'], ['sam', 'viewer']]);
  assert.equal(repo.teamById(team.id).maxHops, 6);
  assert.equal(repo.findInvite(team.invites[0].code).invite.usesLeft, 2);
  const bot = repo.agent(team.id, 'bot');
  assert.equal(bot.name, 'Bot'); assert.equal(bot.ownerUserId, 'u1'); assert.equal(bot.registeredAt, 7);
  assert.ok(!('state' in bot) && !('lastSeen' in bot), 'presence is not persisted');
  assert.deepEqual(repo.recentMessages(team.id, 10), msgs);
  assert.deepEqual(repo.inbox(team.id, 'bot').map((m) => m.id), ['m2']);

  // A second start doesn't import again, even if old files reappear.
  fs.writeFileSync(path.join(dir, 'users.json'), '[]');
  const reopened = createRepo(openDb(dir));
  assert.equal(reopened.countUsers(), 2);
  assert.ok(fs.existsSync(path.join(dir, 'users.json')), 'files next to a non-empty database are left alone');

  // A crash after the import committed but before the renames: the next start only finishes the renames.
  fs.rmSync(path.join(dir, 'users.json'));
  fs.renameSync(path.join(dir, 'teams.json.imported'), path.join(dir, 'teams.json'));
  const finished = createRepo(openDb(dir));
  assert.equal(finished.countUsers(), 2);
  assert.ok(!fs.existsSync(path.join(dir, 'teams.json')) && fs.existsSync(path.join(dir, 'teams.json.imported')));
});

test('db: inbox take and restore, session cap and login codes', (t) => {
  const repo = createRepo(openDb(tempDir(t)));
  const user = repo.createUser({ handle: 'a', name: 'A', tokenHash: hashToken(newToken()) });
  const team = repo.createTeam('T', user.id);
  repo.saveAgent({ teamId: team.id, id: 'bot', ownerUserId: user.id, name: 'bot', registeredAt: 1 });
  for (const id of ['x1', 'x2', 'x3']) repo.insertMessage({ id, teamId: team.id, threadId: 'x1', text: id, ts: 1 });
  repo.enqueue(team.id, 'bot', 'x3'); repo.enqueue(team.id, 'bot', 'x1');
  assert.deepEqual(repo.takeInbox(team.id, 'bot').map((m) => m.id), ['x1', 'x3'], 'inbox is in message order');
  assert.deepEqual(repo.takeInbox(team.id, 'bot'), []);
  repo.enqueue(team.id, 'bot', 'x2'); repo.enqueue(team.id, 'bot', 'x1');
  assert.deepEqual(repo.inbox(team.id, 'bot').map((m) => m.id), ['x1', 'x2'], 'restored messages go back in front');
  repo.deleteAgent(team.id, 'bot');
  assert.deepEqual(repo.inbox(team.id, 'bot'), [], 'removing an agent clears its inbox');

  repo.createSession(user.id, 'computer', 'cli on laptop', 'cli');
  repo.createSession(user.id, 'old-browser', 'b');
  repo.touchSession('old-browser', Date.now() + 60_000); // recently used, so it outlives newer idle ones
  for (let i = 0; i < 25; i++) repo.createSession(user.id, `h${i}`, 'b');
  assert.equal(repo.db.prepare("SELECT count(*) AS n FROM sessions WHERE kind = 'browser'").get().n, 20);
  assert.equal(repo.sessionByHash('h0'), null); assert.ok(repo.sessionByHash('h24'));
  assert.ok(repo.sessionByHash('old-browser'), 'least recently used goes first');
  assert.ok(repo.sessionByHash('computer'), 'browsers never evict a computer sign-in');
  repo.setToken(user.id, hashToken(newToken()));
  assert.equal(repo.sessionByHash('h24'), null, 'rotating the token ends sessions');

  repo.createLoginCode('c1', user.id, Date.now() + 1000);
  repo.createLoginCode('c2', user.id, Date.now() - 1);
  assert.equal(repo.takeLoginCode('c1'), user.id);
  assert.equal(repo.takeLoginCode('c1'), null, 'single use');
  assert.equal(repo.takeLoginCode('c2'), null, 'expired');
});

test('auth: main tokens, sessions with expiry, optional auth and SSE query tokens', (t) => {
  const repo = createRepo(openDb(tempDir(t)));
  const token = newToken();
  assert.match(token, /^bc_[a-f0-9]{64}$/);
  const user = repo.createUser({ handle: 'u', name: 'U', tokenHash: hashToken(token) });
  const url = new URL('http://localhost/api/me');
  const bearer = (tok) => ({ headers: { authorization: `Bearer ${tok}` } });
  assert.equal(authenticate(bearer(token), url, repo).user.id, user.id);
  assert.equal(authenticate(bearer(token), url, repo).sessionHash, null);
  assert.equal(authenticate({ headers: {} }, url, repo, { optional: true }), null);
  assert.throws(() => authenticate({ headers: {} }, url, repo), { status: 401 });
  assert.throws(() => authenticate(bearer('bad'), url, repo, { optional: true }), { status: 401 });
  assert.throws(() => authenticate({ headers: {} }, new URL(`${url}?token=${token}`), repo), { status: 401 });
  assert.equal(authenticate({ headers: {} }, new URL(`http://localhost/api/teams/a/events?token=${token}`), repo).user.id, user.id);

  const session = newToken();
  repo.createSession(user.id, hashToken(session), 'browser');
  assert.equal(authenticate(bearer(session), url, repo).sessionHash, hashToken(session));
  repo.db.prepare('UPDATE sessions SET last_used_at = ?').run(Date.now() - 31 * 86_400_000);
  assert.throws(() => authenticate(bearer(session), url, repo, { sessionDays: 30 }), { status: 401 });
  assert.equal(repo.sessionByHash(hashToken(session)), null, 'expired sessions are deleted');

  repo.setToken(user.id, hashToken(newToken()));
  assert.throws(() => authenticate(bearer(token), url, repo), { status: 401 });
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
