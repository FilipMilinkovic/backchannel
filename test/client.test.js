// Client-side guards that need no hub: git argument checks for the read-only tools, backends, config handling.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { checkGit } from '../tools.js';
import { ROOT } from './helpers.js';

test('the git tool refuses abbreviated and bundled forms of options that run programs or read outside the repo', () => {
  for (const args of [
    ['grep', '--open=touch /tmp/x', 'hello'], // --open-files-in-pager runs its value through the shell
    ['grep', '--open-files-in-pager=touch /tmp/x', 'hello'],
    ['grep', '-iOtouch /tmp/x', 'hello'], // -O bundled after another short option
    ['grep', '-O', 'hello'],
    ['diff', '--ext', 'HEAD'],
    ['blame', '--contents', '/etc/passwd', '--', 'a.txt'], // reads any file on disk
    ['blame', '--cont=/etc/passwd', '--', 'a.txt'],
    ['blame', '--ignore-revs-file', '/etc/passwd', 'a.txt'],
    ['grep', '--untracked', '--no-exclude-standard', '-e', 'postgres'], // ignored files such as .env
    ['grep', '--no-exclude', '-e', 'x'],
    ['grep', '--no-ind', '-e', 'x'],
    ['log', '--output', '/tmp/x'],
  ]) assert.throws(() => checkGit(args), /isn't allowed/, args.join(' '));
  for (const args of [
    ['log', '--oneline', '-20', '--', 'src/'], ['diff', '--text', 'HEAD'], ['blame', '--ignore-rev', 'abc', 'a.txt'],
    ['status', '--untracked-files=all'], ['log', '-S', 'OAuth'], ['grep', '-n', '-i', '-e', 'refund'], ['branch', '--contains', 'HEAD'],
    ['log', '--no-ext-diff', '-p'], ['show', '--name-only', 'HEAD'],
  ]) assert.deepEqual(checkGit(args), args);
});

test('the openai and grok backends use their default model when no --model is given', async (t) => {
  const { backends } = await import('../backends.js');
  const bodies = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => { bodies.push(JSON.parse(body)); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: 'hi' } }] })); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const saved = { ...process.env };
  t.after(() => { for (const k of ['OPENAI_BASE_URL', 'OPENAI_API_KEY', 'OPENAI_MODEL', 'XAI_BASE_URL', 'XAI_API_KEY', 'XAI_MODEL']) { if (k in saved) process.env[k] = saved[k]; else delete process.env[k]; } });
  Object.assign(process.env, { OPENAI_BASE_URL: base, OPENAI_API_KEY: 'k', XAI_BASE_URL: base, XAI_API_KEY: 'k' });
  delete process.env.OPENAI_MODEL; delete process.env.XAI_MODEL;
  // What responder.js passes: model is undefined unless the connector was started with --model.
  assert.equal(await backends.openai({ system: 's', prompt: 'p', model: undefined }), 'hi');
  assert.equal(await backends.grok({ system: 's', prompt: 'p', model: undefined }), 'hi');
  await backends.openai({ system: 's', prompt: 'p', model: 'gpt-x' });
  assert.deepEqual(bodies.map((b) => b.model), ['gpt-5', 'grok-4', 'gpt-x']);
});

test('a backend that exits before reading its input is reported, not a crash', async () => {
  const { run } = await import('../backends.js');
  await assert.rejects(run(process.execPath, ['-e', 'process.exit(3)'], { input: 'x'.repeat(8 * 1_048_576) }), /exited 3/);
});

test('the CLI never sends the saved sign-in to another hub, and explains bad options', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-cli-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.backchannel'));
  fs.writeFileSync(path.join(home, '.backchannel', 'config.json'), JSON.stringify({ hub: 'http://127.0.0.1:9', token: 'bc_saved', team: 't1', handle: 'maya' }));
  const seen = [];
  const server = http.createServer((req, res) => { seen.push(req.headers.authorization || null); res.statusCode = 401; res.end('{"error":"no"}'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const env = { ...process.env, HOME: home };
  for (const k of ['HUB_URL', 'HUB_TOKEN', 'HUB_TEAM']) delete env[k];
  const cli = (...args) => new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'cli.js'), ...args], { env });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    child.on('exit', (code) => resolve({ code, err }));
  });
  const other = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await cli('whoami', '--hub', other)).code, 1);
  assert.deepEqual(seen, [null], 'the token saved for another hub was not sent');
  const bad = await cli('agents', '--jsn');
  assert.equal(bad.code, 1);
  assert.match(bad.err, /Unknown option '--jsn'[\s\S]*backchannel --help/);
  assert.doesNotMatch(bad.err, /at .*\.js:\d+/, 'no stack trace');
});

test('connect checks --id and --cwd before doing anything', () => {
  const env = { ...process.env, HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'bc-home-')) };
  let r = spawnSync(process.execPath, [path.join(ROOT, 'agent.js'), '--backend', 'echo', '--id', '../../evil', '--no-approve'], { env, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--id must be a handle/);
  r = spawnSync(process.execPath, [path.join(ROOT, 'agent.js'), '--backend', 'echo', '--cwd', '/no/such/folder', '--no-approve'], { env, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /isn't a folder/);
  r = spawnSync(process.execPath, [path.join(ROOT, 'agent.js'), '--bakend', 'echo'], { env, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Unknown option '--bakend'[\s\S]*connect --help/);
  fs.rmSync(env.HOME, { recursive: true, force: true });
});

test('a systemd unit names its folder without quotes, which WorkingDirectory= does not remove', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-svc-'));
  const keys = ['HOME', 'BACKCHANNEL_SERVICE_PLATFORM', 'BACKCHANNEL_SERVICE_DRY_RUN', 'XDG_CONFIG_HOME'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  t.after(() => { for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } fs.rmSync(home, { recursive: true, force: true }); });
  Object.assign(process.env, { HOME: home, BACKCHANNEL_SERVICE_PLATFORM: 'linux', BACKCHANNEL_SERVICE_DRY_RUN: '1' });
  delete process.env.XDG_CONFIG_HOME;
  const service = await import('../service.js');
  const cwd = path.join(home, 'My Code 100%');
  const { file } = service.install({ id: 'maya-claude', args: ['--cwd', cwd], cwd });
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /^WorkingDirectory=\/.*\/My Code 100%%$/m);
  assert.match(text, /^StandardOutput=append:\/\S*connect-maya-claude\.log$/m);
  assert.equal(service.installed()[0].cwd, cwd);
  // Units written by earlier versions (quoted) are still read.
  fs.writeFileSync(file, text.replace(/^WorkingDirectory=.*$/m, 'WorkingDirectory="/srv/a \\"b\\" 50%%"'));
  assert.equal(service.installed()[0].cwd, '/srv/a "b" 50%');
});

test('a corrupt config file is ignored with a warning instead of crashing', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-cfg-'));
  fs.mkdirSync(path.join(home, '.backchannel'));
  for (const body of ['null', '{not json', '[1]']) {
    fs.writeFileSync(path.join(home, '.backchannel', 'config.json'), body);
    const r = spawnSync(process.execPath, [path.join(ROOT, 'cli.js'), 'token'], { env: { ...process.env, HOME: home, HUB_TOKEN: '' }, encoding: 'utf8' });
    assert.equal(r.status, 1, body);
    assert.match(r.stderr, /No saved token/, body);
    assert.doesNotMatch(r.stderr, /TypeError/, body);
  }
  fs.rmSync(home, { recursive: true, force: true });
});

test('a coding agent still running when the connector exits is stopped with it', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-child-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const pidFile = path.join(dir, 'pid');
  const child = `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`;
  const parent = `import { run } from ${JSON.stringify(path.join(ROOT, 'backends.js'))};
    import fs from 'node:fs';
    run(process.execPath, ['-e', ${JSON.stringify(child)}], { input: '' }).catch(() => {});
    const t = setInterval(() => { if (fs.existsSync(${JSON.stringify(pidFile)})) { clearInterval(t); process.exit(0); } }, 20);`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', parent], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(r.status, 0, r.stderr);
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  for (let i = 0; i < 50 && alive(); i++) await new Promise((res) => setTimeout(res, 50));
  if (alive()) process.kill(pid, 'SIGKILL');
  assert.ok(!alive(), 'the child outlived the process that started it');
});
