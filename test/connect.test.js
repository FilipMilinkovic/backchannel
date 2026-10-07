// `backchannel connect` defaults: handle from your sign-in plus the backend, the current folder, asking before each request.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { startHub, tempDir, prefix, delay, ROOT } from './helpers.js';

const BIN = path.join(ROOT, 'bin', 'backchannel.js');

function signedIn(t, h, account) {
  const home = tempDir(t, 'bc-connect-');
  fs.mkdirSync(path.join(home, '.backchannel'));
  fs.writeFileSync(path.join(home, '.backchannel', 'config.json'),
    JSON.stringify({ hub: h.base, token: account.token, team: account.team.id, handle: account.user.handle }));
  const env = { ...process.env, HOME: home };
  delete env.HUB_URL; delete env.HUB_TOKEN; delete env.HUB_TEAM;
  return { home, env };
}

test('connect registers @<you>-<backend> for the signed-in user without any flags but the backend', async (t) => {
  const h = await startHub(t);
  const maya = await h.bootstrap('maya');
  const { env } = signedIn(t, h, maya);
  const repo = tempDir(t, 'payments-');
  const child = spawn(process.execPath, [BIN, 'connect', '--backend', 'echo', '--no-approve'], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });

  let agent;
  for (let i = 0; i < 100 && !agent; i++) {
    await delay(50);
    agent = (await h.ok(`${prefix(maya)}/agents`, maya.token)).find((a) => a.id === 'maya-echo');
  }
  assert.ok(agent, `agent never registered: ${out}`);
  assert.equal(agent.owner, 'maya');
  assert.match(out, /@maya-echo \(echo, handles requests without asking\) connecting to/);
});

test('connect asks before each request by default, so it refuses to run without a terminal', (t) => {
  const { env } = signedIn(t, { base: 'http://127.0.0.1:9' }, { token: 'bc_x', team: { id: 't' }, user: { handle: 'maya' } });
  const r = spawnSync(process.execPath, [BIN, 'connect', '--backend', 'echo'], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--no-approve/);
});

test('connect refuses --write --no-approve unless the owner says they trust the team', (t) => {
  const { env } = signedIn(t, { base: 'http://127.0.0.1:9' }, { token: 'bc_x', team: { id: 't' }, user: { handle: 'maya' } });
  const r = spawnSync(process.execPath, [BIN, 'connect', '--backend', 'claude-code', '--write', '--no-approve'], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--i-trust-this-team/);
});
