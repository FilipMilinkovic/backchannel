import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
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
  assert.equal((await pending).status, 410, 'a disconnected agent is told to stop, not to register again');
});

test('disconnect stops the running process; a fresh start reconnects', async (t) => {
  const h = await startHub(t);
  const owner = await h.bootstrap();
  const bob = await h.join(owner, 'member', 'bob');
  const p = prefix(owner);
  await h.ok(p + '/agents', bob.token, 'POST', { id: 'bobbot' });
  await h.ok(p + '/agents', owner.token, 'POST', { id: 'mine' });
  // Members can only disconnect their own agents; owners can disconnect anyone's.
  assert.equal((await h.api(p + '/agents/mine', bob.token, 'DELETE')).status, 403);
  await h.ok(p + '/agents/bobbot', owner.token, 'DELETE');
  const gone = await h.api(p + '/agents/bobbot/inbox', bob.token);
  assert.equal(gone.status, 410);
  assert.match(gone.body.error, /disconnected from this team by alice\. Start it again/);
  for (const [method, route, body] of [['POST', '/agents/bobbot/status', { state: 'idle' }], ['POST', '/messages', { from: 'bobbot', text: 'hi' }]]) {
    assert.equal((await h.api(p + route, bob.token, method, body)).status, 410, route);
  }
  // The process that was connected re-registers with resume: it stays stopped, even across a hub restart.
  await h.restart();
  assert.equal((await h.api(p + '/agents', bob.token, 'POST', { id: 'bobbot', resume: true })).status, 410);
  assert.ok(!(await h.ok(p + '/agents', bob.token)).some((a) => a.id === 'bobbot'));
  // Starting it again is a fresh registration and clears the disconnect.
  await h.ok(p + '/agents', bob.token, 'POST', { id: 'bobbot' });
  assert.equal((await h.api(p + '/agents/bobbot/inbox', bob.token)).status, 200);
  await h.ok(p + '/agents', bob.token, 'POST', { id: 'bobbot', resume: true });
  assert.equal(query(h.dir, 'SELECT count(*) AS n FROM agent_disconnects')[0].n, 0);
  // Live sessions watch /pending instead of draining /inbox; a disconnect ends that wait the same way.
  await h.ok(p + '/agents', bob.token, 'POST', { id: 'bobsession', kind: 'session' });
  const watching = h.api(p + '/agents/bobsession/pending?wait=30', bob.token);
  await delay(30);
  await h.ok(p + '/agents/bobsession', bob.token, 'DELETE');
  assert.equal((await watching).status, 410);
  assert.equal((await h.api(p + '/agents/bobsession/claim', bob.token, 'POST', { ids: [] })).status, 410);
  // Unknown agents that were never disconnected are still plain 404s, so connectors re-register after hub data loss.
  assert.equal((await h.api(p + '/agents/nobody/inbox', bob.token)).status, 404);
});

test("agent handles can't pass for a person or take over someone's disconnected agent", async (t) => {
  const h = await startHub(t);
  const owner = await h.bootstrap();
  const bob = await h.join(owner, 'member', 'bob');
  const mallory = await h.join(owner, 'member', 'mallory');
  const p = prefix(owner);
  // A person's handle is theirs alone, whether or not they have an agent by that name.
  for (const id of ['bob', 'alice']) {
    const taken = await h.api(p + '/agents', mallory.token, 'POST', { id });
    assert.equal(taken.status, 409, id);
    assert.equal(taken.body.error, `@${id} is someone's handle; pick another id`);
  }
  await h.ok(p + '/agents', bob.token, 'POST', { id: 'bob', kind: 'session' }); // their own handle is fine
  // Disconnected (by its owner or a team owner), the handle stays bob's; bob starting it again reconnects it.
  await h.ok(p + '/agents', bob.token, 'POST', { id: 'bobbot' });
  await h.ok(p + '/agents/bobbot', owner.token, 'DELETE');
  assert.equal((await h.api(p + '/agents', mallory.token, 'POST', { id: 'bobbot' })).status, 409);
  assert.equal((await h.api(p + '/agents', owner.token, 'POST', { id: 'bobbot' })).status, 409, 'team owners included');
  assert.equal((await h.ok(p + '/agents', bob.token, 'POST', { id: 'bobbot' })).ownerHandle, 'bob');
  await h.ok(p + '/agents/bobbot', bob.token, 'DELETE');
  assert.equal((await h.api(p + '/agents', mallory.token, 'POST', { id: 'bobbot' })).status, 409);
  // Once bob has left the team, the handle is free again.
  await h.ok(`${p}/members/${bob.user.id}`, owner.token, 'DELETE');
  await h.ok(p + '/agents', mallory.token, 'POST', { id: 'bobbot' });
  // An agent named like a handle nobody has yet keeps that handle from joining the team, so it can't catch their messages.
  await h.ok(p + '/agents', mallory.token, 'POST', { id: 'carol' });
  const invite = await h.ok(p + '/invites', owner.token, 'POST', { role: 'member' });
  const carol = await h.api(`/api/invites/${invite.code}/accept`, null, 'POST', { handle: 'carol' });
  assert.equal(carol.status, 409);
  assert.match(carol.body.error, /^@carol is already an agent in ".+"; ask a team owner to disconnect it$/);
  assert.equal(query(h.dir, "SELECT count(*) AS n FROM users WHERE handle = 'carol'")[0].n, 0, 'the account is not created');
  assert.equal((await h.ok(`/api/invites/${invite.code}`, null)).role, 'member', 'the invite is not used up');
});

test('scoped tokens run only their own agents, message only who they may, and read only their threads', async (t) => {
  const h = await startHub(t);
  const steve = await h.bootstrap('steve');
  const bob = await h.join(steve, 'member', 'bob');
  const p = prefix(steve);
  await h.ok(p + '/agents', steve.token, 'POST', { id: 'steve', kind: 'session' });
  await h.ok(p + '/agents', bob.token, 'POST', { id: 'bob-claude' });
  const other = await h.ok('/api/teams', steve.token, 'POST', { name: 'Other' });

  // Making one: only from a full sign-in, for a team you're in, with a prefix and who it may message.
  const make = (body, token = steve.token) => h.api('/api/me/scoped-tokens', token, 'POST', body);
  for (const [body, error] of [
    [{ team: 'nope', agents: 'cw-', postTo: ['steve'] }, 'team must be the id of a team you are in'],
    [{ team: steve.team.id, agents: 'x', postTo: ['steve'] }, 'agents must be a handle prefix of 2 to 24 characters, e.g. "cw-"'],
    [{ team: steve.team.id, agents: 'cw-', postTo: [] }, 'postTo must list 1 to 20 handles the token may message'],
    [{ team: steve.team.id, agents: 'cw-', postTo: ['steve'], read: 'all' }, 'read must be one of own, team'],
  ]) assert.deepEqual([(await make(body)).status, (await make(body)).body.error], [400, error]);
  const made = await make({ team: steve.team.id, agents: 'cw-', postTo: ['@Steve'], label: 'cloud workers' });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  const { token: cw, id } = made.body;
  assert.deepEqual(made.body.scopes, { team: steve.team.id, agents: 'cw-', postTo: ['steve'], read: 'own' });
  assert.equal((await make({ team: steve.team.id, agents: 'cw-', postTo: ['steve'] }, cw)).status, 403, "a scoped token can't make more");
  const me = await h.ok('/api/me', cw);
  assert.deepEqual([me.user.handle, me.teams.map((x) => x.id), me.scopes.agents], ['steve', [steve.team.id], 'cw-']);

  // Its agents carry the prefix; it can't act as the account's other agents.
  assert.equal((await h.api(p + '/agents', cw, 'POST', { id: 'steve-2' })).status, 403);
  await h.ok(p + '/agents', cw, 'POST', { id: 'cw-a', kind: 'session' });
  await h.ok(p + '/agents', cw, 'POST', { id: 'cw-b', kind: 'session' });
  assert.equal((await h.api(p + '/agents/steve/pending', cw)).status, 403, "the owner's own inbox is off limits");
  assert.equal((await h.api(p + '/agents/steve/claim', cw, 'POST', { ids: [] })).status, 403);
  assert.equal((await h.api(p + '/agents/cw-a', cw, 'PATCH', { standIn: 'write' })).status, 403, 'no stand-in settings');
  assert.equal((await h.api(p + '/agents/bob-claude', cw, 'DELETE')).status, 403);
  // Under the prefix but someone else's: still not its own, though its account owns the team.
  const bobs = await h.ok(p + '/agents', bob.token, 'POST', { id: 'cw-bob' });
  assert.equal(bobs.ownerHandle, 'bob');
  assert.equal((await h.api(p + '/agents/cw-bob', cw, 'DELETE')).status, 403);
  assert.equal((await h.api(p + '/agents/cw-bob/inbox', cw)).status, 403);
  assert.equal((await h.ok(p + '/agents/bob-claude/card', cw)).name, 'bob-claude');

  // It posts only as its agents, and only to the handles it was given.
  assert.equal((await h.api(p + '/messages', cw, 'POST', { text: '@steve hi' })).status, 403, 'not as the person');
  const off = await h.api(p + '/messages', cw, 'POST', { from: 'cw-a', text: '@bob-claude hi' });
  assert.deepEqual([off.status, off.body.error], [403, 'this token can only message @steve']);
  const hello = await h.ok(p + '/messages', cw, 'POST', { from: 'cw-a', text: '@steve WORKER-HELLO ENGR-1' });
  assert.equal(hello.scoped, true);
  assert.equal(hello.by, steve.user.id);
  const answer = await h.ok(p + '/messages', steve.token, 'POST', { from: 'steve', inReplyTo: hello.id, text: 'noted' });
  assert.equal(answer.scoped, undefined);
  assert.equal((await h.ok(p + '/agents/cw-a/pending', cw)).messages[0].id, answer.id);
  await h.ok(p + '/messages', cw, 'POST', { from: 'cw-a', inReplyTo: answer.id, text: 'pr opened' });
  // Someone else asks the worker: it can read the request, but can't answer them.
  const ask = await h.ok(p + '/messages', bob.token, 'POST', { from: 'bob-claude', text: '@cw-b what are you doing?' });
  assert.equal((await h.api(p + '/messages', cw, 'POST', { from: 'cw-b', inReplyTo: ask.id, text: 'ENGR-1' })).status, 403);

  // It reads only threads its agents are in: not the team's other threads, not the event stream.
  const secret = await h.ok(p + '/messages', steve.token, 'POST', { from: 'steve', text: '@bob-claude private' });
  const visible = new Set((await h.ok(p + '/messages', cw)).map((x) => x.threadId));
  assert.deepEqual([...visible].sort(), [hello.threadId, ask.threadId].sort());
  assert.deepEqual((await h.ok(p + '/threads', cw)).map((x) => x.id).sort(), [hello.threadId, ask.threadId].sort());
  assert.equal((await h.ok(p + '/threads/counts', cw)).total, 2);
  assert.equal((await h.api(`${p}/threads/${secret.threadId}`, cw)).status, 404);
  assert.equal((await h.api(`${p}/threads/${secret.threadId}/summary`, cw)).status, 404);
  assert.equal((await h.api(p + '/messages', cw, 'POST', { from: 'cw-a', threadId: secret.threadId, text: '@steve hi' })).status, 404);
  assert.equal((await h.api(p + '/events', cw)).status, 403);
  // Files too: one attached in its own thread, not one attached elsewhere.
  const upload = async (token, name) => (await fetch(`${h.base}${p}/files?name=${name}`, { method: 'POST', body: 'x', headers: { authorization: `Bearer ${token}`, 'content-type': 'text/plain' } })).json();
  const mine = await upload(cw, 'mine.txt');
  await h.ok(p + '/messages', cw, 'POST', { from: 'cw-a', inReplyTo: answer.id, text: 'log', files: [mine.id] });
  const theirs = await upload(steve.token, 'theirs.txt');
  await h.ok(p + '/messages', steve.token, 'POST', { from: 'steve', threadId: secret.threadId, text: 'file', files: [theirs.id] });
  assert.equal((await h.api(`${p}/files/${mine.id}/info`, cw)).status, 200);
  assert.equal((await h.api(`${p}/files/${theirs.id}/info`, cw)).status, 404);

  // Nothing about the account or the team beyond that.
  for (const [method, route, body] of [['POST', '/api/me/token'], ['POST', '/api/me/login-link', {}], ['POST', '/api/teams', { name: 'X' }],
    ['GET', '/api/me/scoped-tokens'], ['GET', `/api/teams/${other.team.id}`], ['POST', p + '/invites', { role: 'member' }],
    ['PATCH', p + '/', { name: 'Renamed' }], ['DELETE', `${p}/members/${steve.user.id}`]]) {
    assert.ok([403, 404].includes((await h.api(route, cw, method, body)).status), `${method} ${route}`);
  }
  const invite = await h.ok(p + '/invites', steve.token, 'POST', { role: 'member' });
  assert.equal((await h.api(`/api/invites/${invite.code}/accept`, cw, 'POST', {})).status, 403);

  // With read: 'team' it sees everything, but still posts only as its agents to its handles.
  const wide = (await make({ team: steve.team.id, agents: 'ci-', postTo: ['steve'], read: 'team' })).body.token;
  assert.ok((await h.ok(p + '/messages', wide)).some((x) => x.id === secret.id));

  // Listed and revoked from a full sign-in; a revoked token stops working, and so does one whose account rotates.
  const list = await h.ok('/api/me/scoped-tokens', steve.token);
  assert.deepEqual(list.map((x) => [x.id, x.label]), [[id, 'cloud workers'], [list[1].id, 'scoped token']]);
  await h.ok(`/api/me/scoped-tokens/${id}`, steve.token, 'DELETE');
  assert.equal((await h.api('/api/me', cw)).status, 401);
  assert.equal((await h.api(`/api/me/scoped-tokens/${id}`, steve.token, 'DELETE')).status, 404);
  await h.ok('/api/me/token', steve.token, 'POST');
  assert.equal((await h.api('/api/me', wide)).status, 401);
});

test('a scoped token stays clear of its account: its prefix, agents it registered, budgets of its own, no expiry', async (t) => {
  const h = await startHub(t, null, { RATE_READS_PER_MIN: '40', MAX_STREAMS_PER_USER: '1' });
  const steve = await h.bootstrap('steve');
  const p = prefix(steve);
  await h.ok(p + '/agents', steve.token, 'POST', { id: 'steve', kind: 'session' });
  await h.ok(p + '/agents', steve.token, 'POST', { id: 'cw-old' });
  const make = (agents) => h.api('/api/me/scoped-tokens', steve.token, 'POST', { team: steve.team.id, agents, postTo: ['steve'] });

  // The prefix can't reach the account's handle or the agents it already runs.
  assert.deepEqual((await make('ste')).body.error, 'the prefix "ste" covers your own handle @steve; pick one that doesn\'t, e.g. "cw-"');
  assert.deepEqual((await make('cw-')).body.error, 'the prefix "cw-" covers agents you already run (@cw-old); pick another');
  const a = (await make('bot-')).body.token;
  const b = (await make('bot-')).body.token; // made before any bot- agent exists

  // A token uses only agents it registered: not another token's, not one a full sign-in registered under its prefix.
  await h.ok(p + '/agents', a, 'POST', { id: 'bot-a', kind: 'session' });
  for (const [token, method, route, body] of [[b, 'POST', '/agents', { id: 'bot-a' }], [b, 'GET', '/agents/bot-a/pending'], [b, 'DELETE', '/agents/bot-a']]) {
    const r = await h.api(p + route, token, method, body);
    assert.deepEqual([r.status, r.body.error], [403, 'this token can only use agents it registered'], `${method} ${route}`);
  }
  await h.ok(p + '/agents', steve.token, 'POST', { id: 'bot-manual' });
  for (const [method, route, body] of [['GET', '/agents/bot-manual/pending'], ['POST', '/agents/bot-manual/claim', { ids: [] }],
    ['DELETE', '/agents/bot-manual'], ['POST', '/agents', { id: 'bot-manual' }], ['POST', '/messages', { from: 'bot-manual', text: '@steve hi' }]]) {
    assert.equal((await h.api(p + route, a, method, body)).status, 403, `${method} ${route}`);
  }
  const listed = await h.ok(p + '/agents', steve.token);
  assert.equal(listed.find((x) => x.id === 'bot-a').scoped, true);
  assert.equal(listed.find((x) => x.id === 'bot-manual').scoped, undefined);
  assert.ok(listed.every((x) => !('scopedBy' in x)), 'the token id stays on the hub');
  // A full sign-in registering it again takes it back.
  await h.ok(p + '/agents', steve.token, 'POST', { id: 'bot-a' });
  assert.equal((await h.api(p + '/agents/bot-a/pending', a)).status, 403);
  await h.ok(p + '/agents', a, 'POST', { id: 'bot-a2', kind: 'session' });

  // It reads only its own agents' threads, reports work only on those, and always addresses someone.
  const theirs = await h.ok(p + '/messages', steve.token, 'POST', { text: '@bot-manual hi' });
  const mine = await h.ok(p + '/messages', a, 'POST', { from: 'bot-a2', text: '@steve hello' });
  assert.deepEqual((await h.ok(p + '/threads', a)).map((x) => x.id), [mine.threadId]);
  assert.equal((await h.api(p + '/agents/bot-a2/status', a, 'POST', { state: 'working', threadId: mine.threadId })).status, 200);
  assert.equal((await h.api(p + '/agents/bot-a2/status', a, 'POST', { state: 'working', threadId: theirs.threadId })).status, 404);
  const nobody = await h.api(p + '/messages', a, 'POST', { from: 'bot-a2', text: 'to nobody' });
  assert.deepEqual([nobody.status, nobody.body.error], [400, "a scoped token's message must be addressed to someone it may message"]);

  // Open long polls are counted per token: the token's one doesn't take the account's (cap 1 here).
  const held = http.get(`${h.base}${p}/agents/bot-a2/pending?wait=30`, { headers: { authorization: `Bearer ${a}` } });
  held.on('error', () => {});
  await delay(100);
  assert.equal((await h.api(p + '/agents/cw-old/pending?wait=1', steve.token)).status, 200, "the account's own poll still gets through");
  assert.equal((await h.api(p + '/agents/bot-a2/pending?wait=1', a)).status, 429, "the token's second one doesn't");
  held.destroy();
  // So are reads: using up the token's budget leaves the account's alone.
  let limited = false;
  for (let i = 0; i < 45 && !limited; i++) limited = (await h.api('/api/me', a)).status === 429;
  assert.ok(limited, 'the token hits its own read limit');
  assert.equal((await h.api('/api/me', steve.token)).status, 200);

  // Unused sign-ins expire; scoped tokens last until revoked, and the hourly sweep keeps them too.
  const link = await h.ok('/api/me/login-link', steve.token, 'POST', {});
  const cli = (await h.ok(`/api/login/${link.code}`, null, 'POST', { kind: 'cli' })).token;
  const db = new DatabaseSync(path.join(h.dir, 'backchannel.db'));
  db.exec('UPDATE sessions SET last_used_at = 0');
  db.close();
  assert.equal((await h.api('/api/me', cli)).status, 401, 'an idle sign-in expires');
  assert.equal((await h.api('/api/me', b)).status, 200, 'an idle scoped token does not');
  const sweep = createRepo(openDb(tempDir(t)));
  const u = sweep.createUser({ handle: 'u', name: 'u', tokenHash: 'h' });
  sweep.createSession(u.id, 's1', 'browser');
  sweep.createSession(u.id, 's2', 'ci', 'cli', { team: 't', agents: 'ci-', postTo: ['u'], read: 'own' });
  assert.equal(sweep.pruneSessions(Date.now() + 1), 1);
  assert.deepEqual(sweep.scopedTokens(u.id).map((x) => x.label), ['ci']);
});

test('agent profiles carry repos, machine and approval details without credentials', async (t) => {
  const h = await startHub(t);
  const owner = await h.bootstrap();
  const p = prefix(owner);
  const before = Date.now();
  const agent = await h.ok(p + '/agents', owner.token, 'POST', {
    id: 'coder', backend: 'claude-code', access: 'write', approve: true, workdir: '~/code', host: 'laptop', platform: 'darwin', client: '0.3.0',
    repos: [
      { name: 'payments', path: '~/code/payments', remote: 'https://someone:ghp_secret@github.com/acme/payments.git?x=1', branch: 'main' },
      { name: 'web', remote: 'git@github.com:acme/web.git' }, 'junk', null,
      ...Array.from({ length: 30 }, (_, i) => ({ name: `r${i}` })),
    ],
  });
  assert.equal(agent.repos.length, 20 - 2, 'at most 20 entries are read, and non-objects are dropped');
  assert.deepEqual(agent.repos[0], { name: 'payments', path: '~/code/payments', remote: 'https://github.com/acme/payments.git', branch: 'main' });
  assert.equal(agent.repos[1].remote, 'git@github.com:acme/web.git');
  assert.equal(agent.approve, true); assert.equal(agent.host, 'laptop'); assert.equal(agent.workdir, '~/code'); assert.equal(agent.client, '0.3.0');
  assert.ok(agent.connectedAt >= before);
  assert.ok(!JSON.stringify(query(h.dir, 'SELECT card FROM agents')).includes('ghp_secret'));
  assert.equal((await h.ok(p + '/agents/coder/card', owner.token))['x-repos'][0].name, 'payments');
  const old = await h.ok(p + '/agents', owner.token, 'POST', { id: 'old', repo: 'legacy' });
  assert.deepEqual(old.repos, []); assert.equal(old.approve, null); assert.equal(old.repo, 'legacy');
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
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 7);
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

test("requests to someone else's agent are capped per person per hour; answers and your own agents are not", async (t) => {
  const h = await startHub(t, null, { AGENT_REQUESTS_PER_HOUR: '2' });
  const owner = await h.bootstrap('owner');
  const member = await h.join(owner, 'member', 'maya');
  const p = prefix(owner);
  await h.ok(p + '/agents', member.token, 'POST', { id: 'worker' });
  await h.ok(p + '/agents', owner.token, 'POST', { id: 'mine' });
  const first = await h.ok(p + '/messages', owner.token, 'POST', { text: '@worker one' });
  await h.ok(p + '/messages', owner.token, 'POST', { text: '@worker two' });
  const over = await h.api(p + '/messages', owner.token, 'POST', { text: '@worker three' });
  assert.equal(over.status, 429);
  assert.match(over.body.error, /@worker takes at most 2 requests an hour from you\. Try again in \d+ minutes?\./);
  assert.ok(Number(over.headers.get('retry-after')) > 0);
  // The agent's owner isn't limited.
  for (const n of [1, 2, 3]) await h.ok(p + '/messages', member.token, 'POST', { text: `@worker own ${n}` });
  // Answers going back to the agent that asked are free...
  const question = await h.ok(p + '/messages', member.token, 'POST', { from: 'worker', text: '@mine a question' });
  for (const n of [1, 2, 3]) await h.ok(p + '/messages', owner.token, 'POST', { from: 'mine', inReplyTo: question.id, text: `answer ${n}` });
  // ...including the owner answering for their agent, as a person (from the web UI).
  for (const n of [1, 2]) await h.ok(p + '/messages', owner.token, 'POST', { inReplyTo: question.id, text: `owner's answer ${n}` });
  // ...but a "reply" that names some other message to reach @worker still counts.
  const sneaky = await h.api(p + '/messages', owner.token, 'POST', { from: 'mine', inReplyTo: first.id, text: '@worker one more' });
  assert.equal(sneaky.status, 429);
  // ...and so does a follow-up that names @worker's answer: answering an answer isn't answering a question.
  const answer = await h.ok(p + '/messages', member.token, 'POST', { from: 'worker', inReplyTo: first.id, to: ['owner'], text: 'done' });
  const followUp = await h.api(p + '/messages', owner.token, 'POST', { inReplyTo: answer.id, text: '@worker one more thing' });
  assert.equal(followUp.status, 429);
  assert.equal((await h.api(p + '/messages', owner.token, 'POST', { text: '@mine still fine' })).status, 200);
});

test('threads: the hub keeps each delegation\'s status, pages them and reports agent activity', async (t) => {
  const h = await startHub(t);
  const owner = await h.bootstrap('owner');
  const maya = await h.join(owner, 'member', 'maya');
  const p = prefix(owner);
  await h.ok(p + '/agents', maya.token, 'POST', { id: 'worker' });
  const ask = await h.ok(p + '/messages', owner.token, 'POST', { text: '@worker Hi! How do partial refunds work in the payments service?' });
  const other = await h.ok(p + '/messages', owner.token, 'POST', { text: '@worker second request' });
  const list = await h.ok(p + '/threads', owner.token);
  assert.deepEqual(list.map((x) => x.id), [other.threadId, ask.threadId], 'newest first');
  const first = list[1];
  assert.equal(first.title, 'How do partial refunds work in the payments service?');
  assert.equal(first.status, 'queued');
  assert.deepEqual(first.waitingOn, ['worker']);
  assert.equal(first.from, 'owner'); assert.deepEqual(first.to, ['worker']); assert.equal(first.count, 1);

  // The agent working on it shows live; its answer settles it.
  await h.ok(p + '/agents/worker/status', maya.token, 'POST', { state: 'working', threadId: ask.threadId });
  assert.equal((await h.ok(p + '/threads?state=active', owner.token)).find((x) => x.id === ask.threadId).status, 'working');
  await h.ok(p + '/agents/worker/status', maya.token, 'POST', { state: 'idle' });
  await h.ok(p + '/messages', maya.token, 'POST', { from: 'worker', inReplyTo: ask.id, text: 'Like this.' });
  const done = await h.ok(p + '/threads?state=done', owner.token);
  assert.deepEqual(done.map((x) => [x.id, x.status, x.count]), [[ask.threadId, 'answered', 2]]);
  assert.deepEqual((await h.ok(p + '/threads?state=active', owner.token)).map((x) => x.id), [other.threadId]);
  assert.deepEqual(await h.ok(p + '/threads/counts', owner.token), { active: 1, done: 1, total: 2 });

  const one = await h.ok(`${p}/threads/${ask.threadId}/summary`, owner.token);
  assert.equal(one.id, ask.threadId); assert.equal(one.status, 'answered');
  assert.equal((await h.api(`${p}/threads/nope/summary`, owner.token)).status, 404);
  // Paging by cursor.
  const page1 = await h.ok(p + '/threads?limit=1', owner.token);
  assert.equal(page1.length, 1);
  const page2 = await h.ok(`${p}/threads?limit=1&before=${encodeURIComponent(page1[0].cursor)}`, owner.token);
  assert.equal(page2.length, 1); assert.notEqual(page2[0].id, page1[0].id);
  assert.equal((await h.ok(`${p}/threads?limit=5&before=${encodeURIComponent(page2[0].cursor)}`, owner.token)).length, 0);
  assert.equal((await h.api(p + '/threads?limit=0', owner.token)).status, 400);
  assert.equal((await h.api(p + '/threads?before=nope', owner.token)).status, 400);

  // Activity for the profile.
  const act = await h.ok(p + '/agents/worker/activity', owner.token);
  assert.equal(act.received, 2); assert.equal(act.replies, 1); assert.equal(act.started, 0);
  assert.equal(act.threads.length, 2); assert.ok(act.lastMessageAt > 0);
  // A removed agent no longer counts as owed anything.
  await h.ok(p + '/agents/worker', owner.token, 'DELETE');
  assert.deepEqual(await h.ok(p + '/threads/counts', owner.token), { active: 0, done: 2, total: 2 });
});

test('inbox leases: a connector that dies before answering gets the message again', async (t) => {
  const h = await startHub(t, null, { INBOX_LEASE_SECONDS: '1' });
  const owner = await h.bootstrap('owner');
  const p = prefix(owner);
  await h.ok(p + '/agents', owner.token, 'POST', { id: 'worker' });
  const one = await h.ok(p + '/messages', owner.token, 'POST', { text: '@worker one' });
  const two = await h.ok(p + '/messages', owner.token, 'POST', { text: '@worker two' });
  // Taken with a lease: hidden, but still there.
  assert.deepEqual((await h.ok(p + '/agents/worker/inbox?lease=1', owner.token)).map((m) => m.id), [one.id, two.id]);
  assert.deepEqual(await h.ok(p + '/agents/worker/inbox?lease=1', owner.token), []);
  // Answering one and acknowledging nothing else: only the other comes back once the lease runs out.
  await h.ok(p + '/messages', owner.token, 'POST', { from: 'worker', inReplyTo: one.id, text: 'done' });
  await delay(1600);
  assert.deepEqual((await h.ok(p + '/agents/worker/inbox?lease=1', owner.token)).map((m) => m.id), [two.id]);
  // Reporting work keeps the lease alive; an ack ends it.
  for (let i = 0; i < 3; i++) { await delay(500); await h.ok(p + '/agents/worker/status', owner.token, 'POST', { state: 'working', threadId: two.threadId }); }
  assert.deepEqual(await h.ok(p + '/agents/worker/inbox?lease=1', owner.token), []);
  assert.deepEqual(await h.ok(p + '/agents/worker/ack', owner.token, 'POST', { ids: [two.id] }), { acked: 1 });
  await h.ok(p + '/agents/worker/status', owner.token, 'POST', { state: 'idle' });
  await delay(1600);
  assert.deepEqual(await h.ok(p + '/agents/worker/inbox?lease=1', owner.token), []);

  // Without ?lease=1 (older connectors) taking a message removes it, as before.
  const three = await h.ok(p + '/messages', owner.token, 'POST', { text: '@worker three' });
  assert.deepEqual((await h.ok(p + '/agents/worker/inbox', owner.token)).map((m) => m.id), [three.id]);
  await delay(1600);
  assert.deepEqual(await h.ok(p + '/agents/worker/inbox', owner.token), []);

  // A message that keeps failing is dropped after three takes, and a long poll is woken when a lease runs out.
  const four = await h.ok(p + '/messages', owner.token, 'POST', { text: '@worker four' });
  for (let i = 0; i < 3; i++) {
    const started = Date.now();
    const got = await h.ok(p + `/agents/worker/inbox?lease=1&wait=${i ? 5 : 0}`, owner.token);
    assert.deepEqual(got.map((m) => m.id), [four.id]);
    if (i) assert.ok(Date.now() - started < 4000, 'woken when the lease ran out');
  }
  await delay(1600);
  assert.deepEqual(await h.ok(p + '/agents/worker/inbox?lease=1', owner.token), []);
  assert.ok(h.logs().some((l) => l.msg === 'dropped a message nobody could answer' && l.messageId === four.id));

  // Claims (live sessions) can be leased too, and requeue puts a leased message straight back.
  const five = await h.ok(p + '/messages', owner.token, 'POST', { text: '@worker five' });
  const claimed = await h.api(p + '/agents/worker/claim', owner.token, 'POST', { ids: [five.id], lease: 60 });
  assert.equal(claimed.body.messages?.length, 1, JSON.stringify(claimed));
  assert.deepEqual((await h.ok(p + '/agents/worker/pending', owner.token)).messages, []);
  await h.ok(p + '/agents/worker/requeue', owner.token, 'POST', { ids: [five.id] });
  assert.deepEqual((await h.ok(p + '/agents/worker/pending', owner.token)).messages.map((m) => m.id), [five.id]);
  assert.equal((await h.api(p + '/agents/worker/claim', owner.token, 'POST', { ids: [five.id], lease: 1 })).status, 400);
});

test('db: upgrading to v5 builds summaries for existing threads', (t) => {
  const dir = tempDir(t);
  let db = openDb(dir);
  let repo = createRepo(db);
  const team = repo.createTeam('T');
  repo.saveAgent({ teamId: team.id, id: 'worker', ownerUserId: null, registeredAt: 1, name: 'worker' });
  const m1 = { id: 'aaa', teamId: team.id, threadId: 'aaa', from: 'sam', fromKind: 'user', text: '@worker What does refund() return for partial orders?', ts: 10, hop: 0, to: ['worker'], reply: false };
  const m2 = { id: 'bbb', teamId: team.id, threadId: 'aaa', from: 'worker', fromKind: 'agent', inReplyTo: 'aaa', text: 'A Refund.', ts: 20, hop: 1, to: [], reply: true };
  const m3 = { id: 'ccc', teamId: team.id, threadId: 'ccc', from: 'sam', fromKind: 'user', text: '@worker still open', ts: 30, hop: 0, to: ['worker'], reply: false };
  for (const m of [m1, m2, m3]) repo.insertMessage(m);
  // Back to what a v4 hub left behind.
  db.exec('DROP TABLE threads; ALTER TABLE inbox DROP COLUMN leased_until; ALTER TABLE inbox DROP COLUMN attempts; PRAGMA user_version = 4;');
  db.close();
  db = openDb(dir);
  repo = createRepo(db);
  const rows = repo.threads(team.id);
  assert.deepEqual(rows.map((r) => [r.id, r.count, r.title]), [['ccc', 1, 'still open'], ['aaa', 2, 'What does refund() return for partial orders?']]);
  assert.deepEqual(rows[0].debts, [{ debtor: 'worker', creditor: 'sam' }]);
  assert.deepEqual(rows[1].debts, []);
  db.close();
});
