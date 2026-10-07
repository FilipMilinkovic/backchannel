// `backchannel setup` / `doctor` against a throwaway home directory, with a fake `claude` CLI that edits ~/.claude.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'backchannel.js');

// Implements just `claude mcp add|remove backchannel --scope user [-e K=V]... -- cmd args...`.
const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const file = path.join(process.env.HOME, '.claude.json');
const json = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
const a = process.argv.slice(2);
json.mcpServers ||= {};
if (a[1] === 'remove') delete json.mcpServers[a[2]];
if (a[1] === 'add') {
  const env = {}; let i = 3;
  for (; a[i] !== '--'; i++) if (a[i] === '-e') { const [k, ...v] = a[++i].split('='); env[k] = v.join('='); }
  json.mcpServers[a[2]] = { type: 'stdio', command: a[i + 1], args: a.slice(i + 2), env };
}
fs.writeFileSync(file, JSON.stringify(json, null, 2));
`;

function home(t, { claude, codex }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-setup-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'bin'));
  fs.writeFileSync(path.join(dir, 'bin', 'claude'), FAKE_CLAUDE, { mode: 0o755 });
  fs.symlinkSync(process.execPath, path.join(dir, 'bin', 'node'));
  fs.mkdirSync(path.join(dir, '.backchannel'));
  fs.writeFileSync(path.join(dir, '.backchannel', 'config.json'), JSON.stringify({ hub: 'https://hub.example', token: 'bc_x', handle: 'maya' }));
  if (claude) fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify(claude));
  if (codex !== undefined) { fs.mkdirSync(path.join(dir, '.codex')); fs.writeFileSync(path.join(dir, '.codex', 'config.toml'), codex); }
  const env = { ...process.env, HOME: dir, PATH: `${path.join(dir, 'bin')}:/usr/bin:/bin`, CODEX_HOME: '' };
  delete env.HUB_URL; delete env.HUB_TOKEN; delete env.HUB_TEAM;
  const run = (code) => spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: ROOT, env, encoding: 'utf8' });
  return {
    dir, run,
    setup: () => run(`import { setupAgents } from './setup.js'; setupAgents({ hub: 'https://hub.example' });`),
    claude: () => JSON.parse(fs.readFileSync(path.join(dir, '.claude.json'), 'utf8')),
    codex: () => fs.readFileSync(path.join(dir, '.codex', 'config.toml'), 'utf8'),
  };
}

const LOCAL_CODEX = `model = "gpt-5"

[mcp_servers.other]
command = "x"

[mcp_servers.backchannel]
command = "node"
args = ["/old/clone/mcp.js"]
tool_timeout_sec = 600

[mcp_servers.backchannel.env]
AGENT_ID = "maya-codex"
HUB_URL = "http://127.0.0.1:7777"

[mcp_servers.backchannel.tools.list_agents]
approval_mode = "approve"

[projects."/code/app"]
trust_level = "trusted"
`;

test('setup repoints Claude Code and Codex that were pinned to another hub, and keeps unrelated config', (t) => {
  const h = home(t, {
    claude: { theme: 'dark', mcpServers: { backchannel: { command: 'node', args: ['/old/clone/mcp.js'], env: { HUB_URL: 'http://127.0.0.1:7777', AGENT_ID: 'maya' } } } },
    codex: LOCAL_CODEX,
  });
  const out = h.setup();
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /Claude Code: updated/);
  assert.match(out.stdout, /Codex: updated/);
  assert.match(out.stdout, /Restart any open/);

  const claude = h.claude();
  assert.equal(claude.theme, 'dark');
  assert.deepEqual(claude.mcpServers.backchannel.args, [BIN, 'mcp']);
  assert.deepEqual(claude.mcpServers.backchannel.env, {}, 'settings meant for the other hub are dropped');

  const codex = h.codex();
  assert.ok(codex.startsWith('model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "x"\n'));
  assert.ok(codex.includes(`args = ${JSON.stringify([BIN, 'mcp'])}`));
  assert.ok(codex.includes('[mcp_servers.backchannel.env]\nAGENT_KIND = "codex"\n'));
  assert.ok(!codex.includes('127.0.0.1') && !codex.includes('/old/clone'));
  assert.ok(codex.includes('[mcp_servers.backchannel.tools.list_agents]\napproval_mode = "approve"'), 'tool approvals are kept');
  assert.ok(codex.includes('[projects."/code/app"]\ntrust_level = "trusted"'));
  assert.equal(codex.match(/\[mcp_servers\.backchannel\]/g).length, 1);
  assert.equal(fs.readFileSync(path.join(h.dir, '.codex', 'config.toml.bak'), 'utf8'), LOCAL_CODEX);

  // Running it again changes nothing.
  const again = h.setup();
  assert.match(again.stdout, /Claude Code: already connected/);
  assert.match(again.stdout, /Codex: already connected/);
  assert.equal(h.codex(), codex);
});

test('setup keeps a chosen handle for the same hub, and adds Codex config when there is none', (t) => {
  const h = home(t, {
    claude: { mcpServers: { backchannel: { command: 'node', args: ['/old/clone/mcp.js'], env: { HUB_URL: 'https://hub.example/', AGENT_ID: 'maya-laptop', HUB_TOKEN: 'bc_y' } } } },
    codex: 'model = "gpt-5"\n',
  });
  assert.equal(h.setup().status, 0);
  assert.deepEqual(h.claude().mcpServers.backchannel.env, { AGENT_ID: 'maya-laptop' });
  assert.ok(h.codex().startsWith('model = "gpt-5"\n\n[mcp_servers.backchannel]\n'));
});

test('doctor names what is wrong and passes once set up', (t) => {
  const h = home(t, { claude: { mcpServers: { backchannel: { command: 'node', args: ['/old/clone/mcp.js'], env: { HUB_URL: 'http://127.0.0.1:7777' } } } }, codex: LOCAL_CODEX });
  // The hub address is unreachable on purpose; only the agent checks matter here.
  const doctor = () => h.run(`import { doctor } from './setup.js'; import { Hub } from './client.js';
    const cfg = { hub: 'http://127.0.0.1:9', token: 'bc_x' }; await doctor(new Hub(cfg.hub, cfg.token), cfg);`);
  const before = doctor().stdout;
  assert.match(before, /Claude Code: HUB_URL pins it to http:\/\/127\.0\.0\.1:7777, but you're signed in to http:\/\/127\.0\.0\.1:9/);
  assert.match(before, /Codex: .*not this install/);
  assert.match(before, /Run: backchannel setup/);
  h.setup();
  const after = doctor().stdout;
  assert.match(after, /✓ Claude Code: connected/);
  assert.match(after, /✓ Codex: connected/);
});
