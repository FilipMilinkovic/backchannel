// Two live sessions (mcp.js) on one hub: delegation, live status, side conversations and file sharing.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { startHub, prefix, delay, tempDir, ROOT } from './helpers.js';

function session(t, h, account, id, home) {
  // Started from `home`, so relative attachment paths resolve there, like a session in its project folder.
  const child = spawn(process.execPath, [path.join(ROOT, 'mcp.js')], { cwd: home,
    env: { ...process.env, HOME: home, HUB_URL: h.base, HUB_TOKEN: account.token, AGENT_ID: id, HUB_TEAM: '' },
    stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  const waiting = new Map();
  let next = 1;
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    const msg = JSON.parse(line);
    waiting.get(msg.id)?.(msg); waiting.delete(msg.id);
  });
  return {
    async call(name, args = {}) {
      const rid = next++;
      const done = new Promise((resolve) => waiting.set(rid, resolve));
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: rid, method: 'tools/call', params: { name, arguments: args } }) + '\n');
      const res = await done;
      assert.ok(!res.result.isError, res.result.content[0].text);
      return res.result.content[0].text;
    },
  };
}

async function until(fn, ms = 5000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('timed out');
    await delay(50);
  }
}

test('mcp: sessions delegate, show as working, ignore side conversations and share files', async (t) => {
  const h = await startHub(t);
  const filip = await h.bootstrap('filip');
  const steve = await h.join(filip, 'member', 'steve');
  const p = prefix(filip);
  const homeA = tempDir(t), homeB = tempDir(t);
  fs.writeFileSync(path.join(homeA, 'spec.md'), '# Spec\nShip it.\n');
  const a = session(t, h, filip, 'filip', homeA);
  const b = session(t, h, steve, 'steve', homeB);
  await until(async () => (await h.ok(p + '/agents', filip.token)).filter((x) => x.online).length === 2);
  const state = async (id) => (await h.ok(p + '/agents', filip.token)).find((x) => x.id === id).state;

  const asking = a.call('ask_agent', { agent: 'steve', message: 'Please review the attached spec.', files: ['spec.md'], wait_seconds: 20 });
  const got = await b.call('check_inbox', { wait_seconds: 10 });
  assert.match(got, /Please review the attached spec\./);
  assert.match(got, /spec\.md \(\d+ B, text\/markdown\), file_id ([a-f0-9]+)/);
  const fileId = got.match(/file_id ([a-f0-9]+)/)[1];
  const threadId = got.match(/thread ([a-f0-9]+)\]/)[1];
  const messageId = got.match(/\[message ([a-f0-9]+)/)[1];
  await until(async () => (await state('steve')) === 'working');

  // get_file saves the file and shows small text inline.
  const saved = await b.call('get_file', { file_id: fileId, save_to: path.join(homeB, 'in') });
  assert.match(saved, /# Spec\nShip it\./);
  assert.equal(fs.readFileSync(path.join(homeB, 'in', 'spec.md'), 'utf8'), '# Spec\nShip it.\n');

  // A message in the thread that isn't addressed to the asker is not its answer.
  await h.ok(p + '/agents', steve.token, 'POST', { id: 'helper' });
  await h.ok(p + '/messages', steve.token, 'POST', { from: 'steve', threadId, text: '@helper side question' });
  await delay(4000); // longer than the asker's thread check interval
  fs.writeFileSync(path.join(homeB, 'notes.txt'), 'looks good');
  await b.call('reply', { message_id: messageId, text: 'Reviewed, notes attached.', files: [path.join(homeB, 'notes.txt')] });
  const answer = await asking;
  assert.doesNotMatch(answer, /side question/);
  assert.match(answer, /Reviewed, notes attached\.[\s\S]*notes\.txt/);
  await until(async () => (await state('steve')) === 'idle');
});

test('mcp: sessions sharing a handle leave messages for the one whose agent reads them', async (t) => {
  const h = await startHub(t);
  const filip = await h.bootstrap('filip');
  const steve = await h.join(filip, 'member', 'steve');
  const p = prefix(filip);
  // Steve has three windows open; only the last one is in use.
  const idle = [session(t, h, steve, 'steve', tempDir(t)), session(t, h, steve, 'steve', tempDir(t))];
  const used = session(t, h, steve, 'steve', tempDir(t));
  await h.ok(p + '/agents', filip.token, 'POST', { id: 'filip' });
  await until(async () => (await h.ok(p + '/agents', filip.token)).some((x) => x.id === 'steve' && x.online));
  await delay(500); // let every session's long poll start, so the hub could hand messages to any of them

  for (const n of [1, 2, 3]) await h.ok(p + '/messages', filip.token, 'POST', { from: 'filip', text: `@steve request ${n}` });
  // Every session hears about them; none takes them until its agent reads.
  for (const s of [...idle, used]) await until(async () => /📬 3 unread/.test(await s.call('list_agents')));
  const got = await used.call('check_inbox');
  for (const n of [1, 2, 3]) assert.match(got, new RegExp(`request ${n}`));
  // Read once: the other windows stop showing them and can't read them again.
  for (const s of idle) {
    await until(async () => !/unread/.test(await s.call('list_agents')));
    assert.equal(await s.call('check_inbox'), 'Inbox is empty.');
  }
});
