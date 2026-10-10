// Always-on connectors: one coding-agent conversation kept across requests and restarts, the background service, and
// the owner's own sessions hearing what the connector handled.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { startHub, tempDir, prefix, delay, ROOT, until, signedIn, connector, ask } from './helpers.js';

const BIN = path.join(ROOT, 'bin', 'backchannel.js');

test('a Claude Code connector keeps one conversation across requests and picks it up after a restart', async (t) => {
  const h = await startHub(t);
  const maya = await h.bootstrap('maya');
  const { home, env, claudeLog } = signedIn(t, h, maya);
  const repo = fs.realpathSync(tempDir(t, 'payments-'));
  let c = connector(t, ['--backend', 'claude-code', '--no-approve'], { cwd: repo, env });
  const agent = await until(async () => (await h.ok(`${prefix(maya)}/agents`, maya.token)).find((a) => a.id === 'maya-claude' && a.online));
  assert.equal(agent.persistent, true);
  assert.equal(agent.service, false);
  assert.match(c.out(), /Keeps one conversation across requests/);
  assert.equal((await h.ok(`${prefix(maya)}/agents/maya-claude/card`, maya.token))['x-persistent'], true);

  const first = await ask(h, maya, 'maya-claude', 'alpha-question');
  const pid = first.text.match(/^turn 1 pid (\d+) resumed no$/)?.[1];
  assert.ok(pid, first.text);
  // Another thread goes into the same process and conversation.
  assert.equal((await ask(h, maya, 'maya-claude', 'beta-question')).text, `turn 2 pid ${pid} resumed no`);
  // Back in the first thread, only what's new is sent: the conversation already holds the rest.
  assert.equal((await ask(h, maya, 'maya-claude', 'alpha-followup', first.threadId)).text, `turn 3 pid ${pid} resumed no`);
  const prompts = claudeLog().filter((e) => e.prompt).map((e) => e.prompt);
  assert.match(prompts[0], /New request in thread \w+ from @maya[\s\S]*On the network now:[\s\S]*alpha-question/);
  assert.match(prompts[2], /You've been in this thread before/);
  assert.match(prompts[2], /alpha-followup/);
  assert.doesNotMatch(prompts[2], /alpha-question|turn 1 pid/);
  const start = claudeLog().find((e) => e.start);
  assert.ok(start.args.includes('stream-json') && !start.args.includes('--resume'));

  // A restart resumes the saved conversation.
  assert.equal(await c.stop(), 0);
  const saved = JSON.parse(fs.readFileSync(path.join(home, '.backchannel', 'sessions', 'maya-claude.json'), 'utf8'));
  assert.ok(saved.conversation);
  c = connector(t, ['--backend', 'claude-code', '--no-approve'], { cwd: repo, env });
  await until(() => /Picking up its conversation from last time/.test(c.out()));
  assert.match(c.out(), new RegExp(`claude --resume ${saved.conversation}`));
  assert.match((await ask(h, maya, 'maya-claude', 'gamma', first.threadId)).text, /^turn 1 pid \d+ resumed yes$/);
  const restart = claudeLog().filter((e) => e.start).at(-1);
  assert.deepEqual(restart.args.slice(restart.args.indexOf('--resume'), restart.args.indexOf('--resume') + 2), ['--resume', saved.conversation]);

  // What it handled is noted for the owner's own sessions.
  const note = await until(() => { const n = JSON.parse(fs.readFileSync(path.join(home, '.backchannel', 'connector-maya-claude.json'), 'utf8')); return n.handled.length === 4 && n; }); // noted just after posting
  assert.equal(note.conversation, saved.conversation);
  assert.equal(note.handled[0].request.trim(), '@maya-claude alpha-question');

  // --fresh forgets it; --no-persistent runs each request on its own, as before.
  await c.stop();
  c = connector(t, ['--backend', 'claude-code', '--no-approve', '--fresh'], { cwd: repo, env });
  assert.match((await ask(h, maya, 'maya-claude', 'delta')).text, /^turn 1 pid \d+ resumed no$/);
  await c.stop();
  c = connector(t, ['--backend', 'claude-code', '--no-approve', '--no-persistent'], { cwd: repo, env });
  await until(async () => (await h.ok(`${prefix(maya)}/agents`, maya.token)).find((a) => a.id === 'maya-claude' && a.online && a.persistent === false));
});

test('a failed or crashed turn is reported, the next request still gets answered, and a lost conversation is replaced', async (t) => {
  const h = await startHub(t);
  const maya = await h.bootstrap('maya');
  const { home, env } = signedIn(t, h, maya);
  const repo = fs.realpathSync(tempDir(t, 'payments-'));
  // A saved conversation that claude no longer has.
  fs.mkdirSync(path.join(home, '.backchannel', 'sessions'));
  fs.writeFileSync(path.join(home, '.backchannel', 'sessions', 'maya-claude.json'),
    JSON.stringify({ backend: 'claude-code', cwd: repo, conversation: 'gone', seen: { old: ['x'] } }));
  const c = connector(t, ['--backend', 'claude-code', '--no-approve'], { cwd: repo, env });
  await until(async () => (await h.ok(`${prefix(maya)}/agents`, maya.token)).find((a) => a.id === 'maya-claude' && a.online));

  assert.match((await ask(h, maya, 'maya-claude', 'hello')).text, /^turn 1 pid \d+ resumed no$/);
  assert.match(c.out(), /could not resume conversation gone; starting a new one/);
  const saved = JSON.parse(fs.readFileSync(path.join(home, '.backchannel', 'sessions', 'maya-claude.json'), 'utf8'));
  assert.notEqual(saved.conversation, 'gone');
  assert.equal(saved.seen.old, undefined);

  const failed = await ask(h, maya, 'maya-claude', 'please FAIL');
  assert.equal(failed.kind, 'error');
  assert.match(failed.text, /claude-code error: Credit balance is too low/);
  const crashed = await ask(h, maya, 'maya-claude', 'please CRASH');
  assert.equal(crashed.kind, 'error');
  assert.match(crashed.text, /claude exited 3/);
  // The next request starts a new process that resumes the conversation.
  assert.match((await ask(h, maya, 'maya-claude', 'still there?')).text, /^turn 1 pid \d+ resumed yes$/);
  const note = await until(() => { const n = JSON.parse(fs.readFileSync(path.join(home, '.backchannel', 'connector-maya-claude.json'), 'utf8')); return n.handled.length === 4 && n; });
  assert.deepEqual(note.handled.map((x) => !!x.error), [false, true, true, false]);
});

for (const platform of ['darwin', 'linux']) {
  test(`connect --service installs a ${platform} background connector that runs, stops when disconnected, and removes itself`, async (t) => {
    const h = await startHub(t);
    const maya = await h.bootstrap('maya');
    const { home, env } = signedIn(t, h, maya, { BACKCHANNEL_SERVICE_PLATFORM: platform, BACKCHANNEL_SERVICE_DRY_RUN: '1' });
    const repo = fs.realpathSync(tempDir(t, 'payments-'));
    const run = (...args) => spawnSync(process.execPath, [BIN, 'connect', ...args], { cwd: repo, env, encoding: 'utf8' });

    const r = run('--backend', 'echo', '--service');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /@maya-echo \(echo, handles requests without asking\) installing as a background service/);
    assert.match(r.stdout, /Installed\. @maya-echo now runs in the background/);
    const file = platform === 'darwin' ? path.join(home, 'Library', 'LaunchAgents', 'com.backchannel.connect.maya-echo.plist')
      : path.join(home, '.config', 'systemd', 'user', 'backchannel-connect-maya-echo.service');
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(!text.includes(maya.token), 'the service file must not hold the token');
    let argv;
    if (platform === 'darwin') {
      assert.match(text, /<key>KeepAlive<\/key>\s*<dict><key>SuccessfulExit<\/key><false\/><\/dict>/);
      assert.match(text, /<key>BACKCHANNEL_SERVICE<\/key><string>1<\/string>/);
      argv = [...text.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/)[1].matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]);
    } else {
      assert.match(text, /^Restart=on-failure$/m);
      assert.match(text, /^Environment="BACKCHANNEL_SERVICE=1"$/m);
      argv = [...text.match(/^ExecStart=(.*)$/m)[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1].replace(/\\(.)/g, '$1'));
    }
    assert.deepEqual(argv.slice(1, 9), [BIN, 'connect', '--id', 'maya-echo', '--backend', 'echo', '--cwd', repo]);
    assert.ok(argv.includes('--no-approve'));

    assert.match(run('--status').stdout, new RegExp(`@maya-echo  installed  ${repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));

    // What launchd or systemd would start: it connects as an always-on agent.
    const svc = spawn(argv[0], argv.slice(1), { cwd: repo, env: { ...env, BACKCHANNEL_SERVICE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(() => svc.kill());
    let out = '';
    svc.stdout.on('data', (d) => { out += d; });
    svc.stderr.on('data', (d) => { out += d; });
    await until(async () => (await h.ok(`${prefix(maya)}/agents`, maya.token)).find((a) => a.id === 'maya-echo' && a.online && a.service === true));
    assert.equal((await ask(h, maya, 'maya-echo', 'ping')).text, 'Echo: maya-echo ping');
    assert.match(out, /^\d{4}-\d\d-\d\dT[\d:.]+Z @maya-echo online/m);

    // Disconnected from the hub: it exits cleanly (so it isn't restarted) and removes its service file.
    const exited = once(svc, 'exit');
    await h.ok(`${prefix(maya)}/agents/maya-echo`, maya.token, 'DELETE');
    assert.equal((await exited)[0], 0);
    assert.ok(!fs.existsSync(file), out);
    assert.match(out, /Removed this background service/);

    // --stop removes an installed one.
    assert.equal(run('--backend', 'echo', '--service').status, 0);
    assert.ok(fs.existsSync(file));
    const stopped = run('--stop');
    assert.equal(stopped.status, 0, stopped.stderr);
    assert.match(stopped.stdout, /Stopped @maya-echo/);
    assert.ok(!fs.existsSync(file));
    assert.match(run('--status').stdout, /No background connectors/);
  });
}

test('connect --service refuses what a background connector cannot do safely', (t) => {
  const { env } = signedIn(t, { base: 'http://127.0.0.1:9' }, { token: 'bc_x', team: { id: 't' }, user: { handle: 'maya' } },
    { BACKCHANNEL_SERVICE_PLATFORM: 'linux', BACKCHANNEL_SERVICE_DRY_RUN: '1' });
  const run = (args, extra = {}) => spawnSync(process.execPath, [BIN, 'connect', ...args], { env: { ...env, ...extra }, encoding: 'utf8' });
  let r = run(['--backend', 'claude-code', '--service', '--write']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /can't ask you before each request[\s\S]*--i-trust-this-team/);
  r = run(['--backend', 'openai', '--service']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /doesn't store keys/);
  r = run(['--backend', 'echo', '--service'], { HUB_TOKEN: 'bc_y' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not HUB_TOKEN/);
  r = run(['--backend', 'echo', '--service'], { BACKCHANNEL_SERVICE_PLATFORM: 'win32' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /macOS and Linux/);
});

test("the owner's own sessions and prompt hook hear once what this computer's connectors handled", async (t) => {
  const h = await startHub(t);
  const maya = await h.bootstrap('maya');
  const { home, env } = signedIn(t, h, maya);
  const note = (entries) => fs.writeFileSync(path.join(home, '.backchannel', 'connector-maya-claude.json'),
    JSON.stringify({ id: 'maya-claude', handled: entries.map((e) => ({ at: Date.now(), threadId: 't1', reply: null, ...e })) }));
  note([{ from: 'steve', request: '@maya-claude how do refunds work?', reply: 'See refunds.ts: partial refunds go through issueRefund().' }]);

  const mcp = spawn(process.execPath, [path.join(ROOT, 'mcp.js')], { cwd: home, env: { ...env, HUB_URL: h.base, HUB_TOKEN: maya.token, AGENT_ID: 'maya' }, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => mcp.kill());
  const results = [];
  let buf = '';
  mcp.stdout.on('data', (d) => { buf += d; for (let i; (i = buf.indexOf('\n')) >= 0;) { results.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
  const call = async (n) => {
    mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method: 'tools/call', params: { name: 'list_agents', arguments: {} } }) + '\n');
    return (await until(() => results.find((r) => r.id === n))).result.content[0].text;
  };
  await until(async () => (await h.ok(`${prefix(maya)}/agents`, maya.token)).some((a) => a.id === 'maya' && a.online));
  const first = await call(1);
  assert.match(first, /🛰️ Your always-on Backchannel agent \(@maya-claude\) handled 1 request on this computer/);
  assert.match(first, /@steve asked @maya-claude \(thread t1\): <untrusted-[a-f0-9]{6} from="@steve">[\s\S]*Replied: See refunds\.ts/);
  assert.doesNotMatch(await call(2), /🛰️/);

  // The prompt hook reports new activity even with no session connected, then not again.
  await delay(5);
  note([{ from: 'steve', request: '@maya-claude and chargebacks?', error: 'claude timed out' }]);
  const hook = () => spawnSync(process.execPath, [path.join(ROOT, 'hooks', 'inbox-hook.js'), 'nobody'], { env, encoding: 'utf8' }).stdout;
  const out = JSON.parse(hook()).hookSpecificOutput.additionalContext;
  assert.match(out, /🛰️ Backchannel: your always-on agent handled 1 request on this computer/);
  assert.match(out, /@steve asked @maya-claude: .*and chargebacks\? .*→ failed: claude timed out/);
  assert.equal(hook(), '');
});
