import test from 'node:test';
import assert from 'node:assert/strict';
import { startHub, query, prefix } from './helpers.js';

const upload = async (h, account, name, data, type = 'text/plain') => {
  const res = await fetch(`${h.base}${prefix(account)}/files?name=${encodeURIComponent(name)}`, {
    method: 'POST', body: data, headers: { authorization: `Bearer ${account.token}`, 'content-type': type } });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const download = (h, account, id, team = account.team.id) =>
  fetch(`${h.base}/api/teams/${team}/files/${id}`, { headers: { authorization: `Bearer ${account.token}` } });

test('files: upload, download, attach to messages, team isolation and roles', async (t) => {
  const h = await startHub(t);
  const owner = await h.bootstrap();
  const p = prefix(owner);
  const bytes = Buffer.from([0, 1, 2, 255, 10, 13]);
  const up = await upload(h, owner, '../../etc/report "final".bin', bytes, 'application/octet-stream; charset=x');
  assert.equal(up.status, 200, JSON.stringify(up.body));
  assert.equal(up.body.name, 'report final.bin', 'folders and quotes are stripped');
  assert.equal(up.body.type, 'application/octet-stream');
  assert.equal(up.body.size, bytes.length);

  const res = await download(h, owner, up.body.id);
  assert.equal(res.status, 200);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), bytes);
  assert.match(res.headers.get('content-disposition'), /^attachment; filename="report final\.bin"/);
  assert.match(res.headers.get('content-security-policy'), /sandbox/);
  assert.equal((await h.ok(`${p}/files/${up.body.id}/info`, owner.token)).name, 'report final.bin');

  // Attached to a message: the message carries the file's details, and they survive a restart.
  await h.ok(p + '/agents', owner.token, 'POST', { id: 'worker' });
  const msg = await h.ok(p + '/messages', owner.token, 'POST', { text: '@worker see attached', files: [up.body.id, up.body.id] });
  assert.deepEqual(msg.files, [{ id: up.body.id, name: 'report final.bin', type: 'application/octet-stream', size: bytes.length }]);
  assert.deepEqual((await h.ok(p + '/agents/worker/inbox', owner.token))[0].files, msg.files);
  assert.equal((await h.api(p + '/messages', owner.token, 'POST', { text: 'x', files: ['abc123'] })).status, 404);
  assert.equal((await h.api(p + '/messages', owner.token, 'POST', { text: 'x', files: 'abc' })).status, 400);
  assert.equal((await h.api(p + '/messages', owner.token, 'POST', { text: 'x', files: Array(21).fill('a') })).status, 400);

  // Viewers can download but not upload; other teams see nothing.
  const viewer = await h.join(owner, 'viewer', 'vic');
  assert.equal((await download(h, viewer, up.body.id)).status, 200);
  assert.equal((await upload(h, viewer, 'a.txt', 'hi')).status, 403);
  const other = await h.ok('/api/teams', owner.token, 'POST', { name: 'Other' });
  assert.equal((await download(h, owner, up.body.id, other.team.id)).status, 404);
  const stranger = await h.join({ ...owner, team: other.team }, 'member', 'sam');
  assert.equal((await download(h, stranger, up.body.id, owner.team.id)).status, 404);
  assert.equal((await h.api(`/api/teams/${other.team.id}/messages`, owner.token, 'POST', { text: 'x', files: [up.body.id] })).status, 404);

  assert.equal((await upload(h, owner, 'empty.txt', '')).status, 400);
  assert.equal((await download(h, owner, 'ffff')).status, 404);
  await h.restart();
  assert.deepEqual(Buffer.from(await (await download(h, owner, up.body.id)).arrayBuffer()), bytes);
  assert.equal(query(h.dir, 'SELECT count(*) AS n FROM files')[0].n, 1);
});

test('files: size limit and team storage quota', async (t) => {
  const h = await startHub(t, null, { MAX_FILE_MB: '1', TEAM_FILES_MB: '2' });
  const owner = await h.bootstrap();
  const mb = Buffer.alloc(1_048_576, 7);
  assert.equal((await upload(h, owner, 'big.bin', Buffer.concat([mb, Buffer.from('x')]))).status, 413);
  assert.equal((await upload(h, owner, 'one.bin', mb)).status, 200);
  assert.equal((await upload(h, owner, 'two.bin', mb)).status, 200);
  const full = await upload(h, owner, 'three.bin', Buffer.from('x'));
  assert.equal(full.status, 507); assert.match(full.body.error, /storage is full/);
});

test('messages record whether they answer a specific message', async (t) => {
  const h = await startHub(t);
  const owner = await h.bootstrap();
  const p = prefix(owner);
  for (const id of ['asker', 'worker']) await h.ok(p + '/agents', owner.token, 'POST', { id });
  const ask = await h.ok(p + '/messages', owner.token, 'POST', { from: 'asker', text: '@worker what is X?' });
  assert.equal(ask.reply, false);
  const answer = await h.ok(p + '/messages', owner.token, 'POST', { from: 'worker', inReplyTo: ask.id, text: 'X is 1' });
  assert.equal(answer.reply, true); assert.deepEqual(answer.to, ['asker']);
  // A follow-up in the thread gets an inferred parent, but it's still a new request.
  const follow = await h.ok(p + '/messages', owner.token, 'POST', { from: 'asker', threadId: ask.threadId, text: '@worker and Y?' });
  assert.equal(follow.inReplyTo, answer.id); assert.equal(follow.reply, false);
});
