// Server fixes from the pre-release audit: body decoding, stream budgets, agent cards, scoped attachments, backups.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startHub, prefix, tempDir } from './helpers.js';
import { backupTo } from '../server/backup.js';

test('a large message keeps every multi-byte character, however the body arrives in chunks', async (t) => {
  const h = await startHub(t);
  const owner = await h.bootstrap();
  // ~285 KB with two- and three-byte characters: the body spans many socket reads, and some boundaries split a character.
  const text = 'Ćevapi € 日本 '.repeat(15_000).trim();
  const sent = await h.ok(prefix(owner) + '/messages', owner.token, 'POST', { text });
  assert.equal(sent.text.split('�').length - 1, 0, 'no replacement characters');
  assert.ok(sent.text === text, 'the text comes back exactly as sent');
});

test('live streams and long polls share one budget per person (MAX_STREAMS_PER_USER)', async (t) => {
  const h = await startHub(t, null, { MAX_STREAMS_PER_USER: '1' });
  const owner = await h.bootstrap();
  const p = prefix(owner);
  await h.ok(p + '/agents', owner.token, 'POST', { id: 'worker' });
  const stream = new AbortController();
  const res = await fetch(`${h.base}${p}/events?token=${owner.token}`, { signal: stream.signal });
  assert.equal(res.status, 200);
  t.after(() => stream.abort());
  const poll = await h.api(p + '/agents/worker/inbox?wait=2', owner.token);
  assert.equal(poll.status, 429, 'the open stream uses up the one connection');
  stream.abort();
});

test('agent card skills are stored as text fields only', async (t) => {
  const h = await startHub(t);
  const owner = await h.bootstrap();
  const agent = await h.ok(prefix(owner) + '/agents', owner.token, 'POST', { id: 'worker',
    skills: [{ id: 'refunds', name: 'Refunds', description: 'Partial refunds', blob: 'x'.repeat(100_000), tags: [1, 2] }, 'loose', null, { id: 'y'.repeat(500) }] });
  assert.deepEqual(agent.skills, [
    { id: 'refunds', name: 'Refunds', description: 'Partial refunds' },
    { id: 'y'.repeat(100), name: 'y'.repeat(100), description: '' },
  ]);
});

test("a scoped token can't attach a file from a thread it can't read", async (t) => {
  const h = await startHub(t);
  const steve = await h.bootstrap('steve');
  const p = prefix(steve);
  await h.ok(p + '/agents', steve.token, 'POST', { id: 'steve', kind: 'session' });
  const { token: cw } = await h.ok('/api/me/scoped-tokens', steve.token, 'POST', { team: steve.team.id, agents: 'cw-', postTo: ['steve'] });
  await h.ok(p + '/agents', cw, 'POST', { id: 'cw-a' });
  const upload = async (token) => (await fetch(`${h.base}${p}/files?name=x.txt`, { method: 'POST', body: 'secret',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'text/plain' } })).json();
  // A file in a thread the token doesn't take part in.
  const secret = await upload(steve.token);
  await h.ok(p + '/messages', steve.token, 'POST', { text: 'private notes', files: [secret.id] });
  assert.equal((await h.api(`${p}/files/${secret.id}`, cw)).status, 404);
  const sneak = await h.api(p + '/messages', cw, 'POST', { from: 'cw-a', text: '@steve see attached', files: [secret.id] });
  assert.equal(sneak.status, 404, JSON.stringify(sneak.body));
  assert.equal((await h.api(`${p}/files/${secret.id}`, cw)).status, 404);
  // Its own uploads, and files in threads it reads, attach as before.
  const mine = await upload(cw);
  const posted = await h.ok(p + '/messages', cw, 'POST', { from: 'cw-a', text: '@steve here', files: [mine.id] });
  await h.ok(p + '/messages', cw, 'POST', { from: 'cw-a', text: '@steve again', threadId: posted.threadId, files: [mine.id] });
  assert.equal((await fetch(`${h.base}${p}/files/${mine.id}`, { headers: { authorization: `Bearer ${cw}` } })).status, 200);
});

test('a backup that fails leaves no partial file behind', (t) => {
  const dir = tempDir(t);
  const db = new DatabaseSync(path.join(dir, 'source.db'));
  t.after(() => db.close());
  db.exec('CREATE TABLE x (v TEXT)');
  const target = path.join(dir, 'backchannel-copy.db');
  const exec = db.exec.bind(db);
  // Simulate a copy that gets partway (e.g. the disk fills up).
  db.exec = (sql) => { if (/^VACUUM INTO/.test(sql)) { fs.writeFileSync(target, 'partial'); throw new Error('disk I/O error'); } return exec(sql); };
  assert.throws(() => backupTo(db, target), /disk I\/O error/);
  assert.ok(!fs.existsSync(target));
  db.exec = exec;
  backupTo(db, target);
  assert.ok(fs.statSync(target).size > 0);
});

test('delegation titles keep issue and PR references, and drop Markdown only where a line starts', async () => {
  const { titleOf } = await import('../server/threads.js');
  assert.equal(titleOf('@x Please approve payments#482 at 1a2b3c4; CI is green.'), 'Please approve payments#482 at 1a2b3c4; CI is green');
  assert.equal(titleOf('@x ## Refund rounding drifts by a cent\nDetails below.'), 'Refund rounding drifts by a cent');
  assert.equal(titleOf('@x > Is the ledger_9 migration reversible?'), 'Is the ledger_9 migration reversible?');
});
