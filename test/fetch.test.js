// git_fetch (tools.js): a read-only connector brings in commits it was asked about, without touching the owner's
// branches or files, and only from remotes the repository already has.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, execFileSync } from 'node:child_process';
import { checkFetch, checkGit } from '../tools.js';
import { ROOT } from './helpers.js';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();

// The tools MCP server over stdio, the way claude runs it.
function tools(root, env = {}) {
  const child = spawn(process.execPath, [path.join(ROOT, 'tools.js')], { env: { ...process.env, BACKCHANNEL_TOOLS_ROOT: root, ...env }, stdio: ['pipe', 'pipe', 'inherit'] });
  const waiting = new Map();
  readline.createInterface({ input: child.stdout }).on('line', (line) => { const m = JSON.parse(line); waiting.get(m.id)?.(m); });
  let n = 0;
  const call = (method, params) => new Promise((resolve) => { const id = ++n; waiting.set(id, resolve); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  return { call, close: () => child.kill() };
}

function repos() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-fetch-'));
  const upstream = path.join(dir, 'upstream'), clone = path.join(dir, 'clone');
  fs.mkdirSync(upstream);
  git(upstream, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(upstream, 'a.txt'), 'one\n');
  git(upstream, 'add', '.'); git(upstream, 'commit', '-q', '-m', 'first');
  git(dir, 'clone', '-q', upstream, clone);
  fs.writeFileSync(path.join(upstream, 'a.txt'), 'two\n');
  git(upstream, 'commit', '-q', '-am', 'second');
  return { dir, upstream, clone, newest: git(upstream, 'rev-parse', 'HEAD') };
}

test('git_fetch brings in a commit the clone does not have, and leaves the owner\'s branch and files alone', async (t) => {
  const r = repos();
  const s = tools(r.clone);
  t.after(() => { s.close(); fs.rmSync(r.dir, { recursive: true, force: true }); });
  const list = await s.call('tools/list', {});
  assert.ok(list.result.tools.some((x) => x.name === 'git_fetch'));
  const before = git(r.clone, 'rev-parse', 'HEAD');
  assert.throws(() => git(r.clone, 'cat-file', '-e', r.newest), 'not there yet');

  const res = await s.call('tools/call', { name: 'git_fetch', arguments: { ref: 'main' } });
  assert.ok(!res.result.isError, res.result.content[0].text);
  assert.match(res.result.content[0].text, /Fetched origin main/);
  git(r.clone, 'cat-file', '-e', r.newest); // now it is
  assert.equal(git(r.clone, 'rev-parse', 'HEAD'), before, 'the checked-out branch did not move');
  assert.equal(fs.readFileSync(path.join(r.clone, 'a.txt'), 'utf8'), 'one\n', 'files untouched');
  assert.equal(git(r.clone, 'rev-parse', 'origin/main'), r.newest);

  const unknown = await s.call('tools/call', { name: 'git_fetch', arguments: { remote: 'evil' } });
  assert.ok(unknown.result.isError);
  assert.match(unknown.result.content[0].text, /no remote named evil; this repository has origin/);
});

test('git_fetch is off with --no-fetch (BACKCHANNEL_NO_FETCH=1)', async (t) => {
  const r = repos();
  const s = tools(r.clone, { BACKCHANNEL_NO_FETCH: '1' });
  t.after(() => { s.close(); fs.rmSync(r.dir, { recursive: true, force: true }); });
  const list = await s.call('tools/list', {});
  assert.ok(!list.result.tools.some((x) => x.name === 'git_fetch'));
  assert.ok(list.result.tools.some((x) => x.name === 'git'));
});

test('git_fetch takes only remote names and plain refs', () => {
  assert.deepEqual(checkFetch({}), { remote: 'origin', ref: null });
  assert.deepEqual(checkFetch({ remote: 'upstream', ref: 'feature/x-1' }), { remote: 'upstream', ref: 'feature/x-1' });
  for (const bad of [{ remote: '--upload-pack=touch /tmp/x' }, { remote: 'ext::sh -c x' }, { remote: '/tmp/repo' }, { ref: '--upload-pack=x' },
    { ref: 'main:refs/heads/main' }, { ref: '+main' }, { ref: 'a..b' }, { ref: 'x.lock' }, { ref: 'refs/heads/' }]) {
    assert.throws(() => checkFetch(bad), /must be/, JSON.stringify(bad));
  }
});

test('the git tool refuses options that read a file named by their value', () => {
  for (const args of [['grep', '-f', '/etc/passwd'], ['grep', '--file=/etc/passwd'], ['grep', '-if', 'x'], ['blame', '-S', '/etc/hosts', 'a.txt'], ['blame', '-wS', 'x', 'a']]) {
    assert.throws(() => checkGit(args), /reads a file/, args.join(' '));
  }
  // The same letters elsewhere are fine: git log -S is the pickaxe, git grep -F is fixed strings.
  for (const args of [['log', '-S', 'needle'], ['grep', '-F', 'x'], ['blame', '-w', 'a.txt']]) assert.deepEqual(checkGit(args), args);
});
