// Connects the coding agents on this computer (Claude Code, Codex) to Backchannel, and checks that they are.
//   backchannel setup     points their MCP config at this install's `backchannel mcp` (login and join do this too),
//                         adds the unread-messages hook to Claude Code and the Backchannel instructions to Codex
//   backchannel doctor    shows what each one would connect to, and what's wrong
// The MCP server reads the hub, token and handle from ~/.backchannel/config.json, so the configs we write carry no
// hub address or token. Settings that would pin a session to another hub (HUB_URL, HUB_TOKEN) are removed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOME = os.homedir();
const CLAUDE_JSON = path.join(HOME, '.claude.json');
const CODEX_TOML = path.join(process.env.CODEX_HOME || path.join(HOME, '.codex'), 'config.toml');
const BIN = fileURLToPath(new URL('./bin/backchannel.js', import.meta.url));

const which = (cmd) => {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.split('\n')[0].trim() : null;
};
// Absolute paths, because the Claude and Codex desktop apps start MCP servers without your shell's PATH.
// Prefer the `node` on PATH (a stable symlink with Homebrew) over this process's versioned binary.
const NODE = which('node') || process.execPath;
const MCP = { command: NODE, args: [BIN, 'mcp'] };

// ---------- Claude Code (~/.claude.json, written through the `claude` CLI) ----------

function readClaude() {
  try { return JSON.parse(fs.readFileSync(CLAUDE_JSON, 'utf8')); } catch { return null; }
}

function inspectClaude() {
  const cli = which('claude');
  const json = readClaude();
  if (!cli && !json) return { name: 'Claude Code', installed: false };
  const server = json?.mcpServers?.backchannel;
  // Local-scope entries win over the user-scope one inside that project.
  const shadows = Object.entries(json?.projects || {}).filter(([, p]) => p?.mcpServers?.backchannel).map(([dir]) => dir);
  return { name: 'Claude Code', installed: true, cli, server: server && { command: server.command, args: server.args || [], env: server.env || {} }, shadows };
}

function setupClaude(state, env, log) {
  const envArgs = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  if (!state.cli) return log(`  - Claude Code: the claude command isn't on your PATH. Add it by hand:\n      claude mcp add backchannel --scope user ${shellArgs([...envArgs, '--', MCP.command, ...MCP.args])}`);
  const run = (...args) => spawnSync(state.cli, args, { encoding: 'utf8' });
  if (state.server) run('mcp', 'remove', 'backchannel', '--scope', 'user');
  const r = run('mcp', 'add', 'backchannel', '--scope', 'user', ...envArgs, '--', MCP.command, ...MCP.args);
  if (r.status !== 0) return log(`  ✗ Claude Code: couldn't add the MCP server: ${(r.stderr || r.stdout).trim()}`);
  log(`  ✓ Claude Code: ${state.server ? 'updated' : 'added'} the backchannel MCP server (user scope)`);
  for (const dir of state.shadows) log(`    ! ${dir} has its own backchannel server that overrides this one. Remove it there: claude mcp remove backchannel --scope local`);
}

// ---------- Codex (~/.codex/config.toml, edited in place) ----------

// Splits TOML into [table] sections. Only the backchannel tables are touched; everything else is kept byte for byte.
function tomlSections(text) {
  const sections = [{ name: null, lines: [] }];
  for (const line of text.split('\n')) {
    const m = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/.exec(line);
    if (m) sections.push({ name: m[1].replace(/["']/g, '').replace(/\s*\.\s*/g, '.'), lines: [line] });
    else sections.at(-1).lines.push(line);
  }
  return sections;
}
const OURS = new Set(['mcp_servers.backchannel', 'mcp_servers.backchannel.env']);
const tomlValues = (lines) => Object.fromEntries(lines.map((l) => /^\s*([\w-]+)\s*=\s*(.+?)\s*$/.exec(l)).filter(Boolean)
  .map(([, k, v]) => { try { return [k, JSON.parse(v)]; } catch { return [k, v.replace(/^["']|["']$/g, '')]; } }));

function inspectCodex() {
  let text = null;
  try { text = fs.readFileSync(CODEX_TOML, 'utf8'); } catch {}
  if (text === null && !which('codex')) return { name: 'Codex', installed: false };
  const sections = text === null ? [] : tomlSections(text);
  const main = sections.find((s) => s.name === 'mcp_servers.backchannel');
  const env = sections.find((s) => s.name === 'mcp_servers.backchannel.env');
  const values = main && tomlValues(main.lines.slice(1));
  return { name: 'Codex', installed: true, text, sections,
    server: main && { command: values.command, args: Array.isArray(values.args) ? values.args : [], env: env ? tomlValues(env.lines.slice(1)) : {} } };
}

function setupCodex(state, env, log) {
  const block = ['[mcp_servers.backchannel]', `command = ${JSON.stringify(MCP.command)}`, `args = ${JSON.stringify(MCP.args)}`,
    'tool_timeout_sec = 600', '', '[mcp_servers.backchannel.env]',
    ...Object.entries({ AGENT_KIND: 'codex', ...env }).map(([k, v]) => `${k} = ${JSON.stringify(String(v))}`), ''];
  const kept = [];
  let at = -1;
  for (const s of state.sections) {
    if (OURS.has(s.name)) { if (at < 0) at = kept.length; continue; }
    kept.push(...s.lines);
  }
  if (at < 0) { while (kept.length && kept.at(-1) === '') kept.pop(); if (kept.length) kept.push(''); at = kept.length; }
  kept.splice(at, 0, ...block);
  const next = kept.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\n*$/, '\n');
  fs.mkdirSync(path.dirname(CODEX_TOML), { recursive: true });
  if (state.text !== null) fs.copyFileSync(CODEX_TOML, CODEX_TOML + '.bak');
  fs.writeFileSync(CODEX_TOML, next);
  log(`  ✓ Codex: ${state.server ? 'updated' : 'added'} [mcp_servers.backchannel] in ${tilde(CODEX_TOML)}${state.text !== null ? ` (previous version saved as ${path.basename(CODEX_TOML)}.bak)` : ''}`);
}

// ---------- shared ----------

const tilde = (p) => p.startsWith(HOME) ? '~' + p.slice(HOME.length) : p;
const shellArgs = (a) => a.map((s) => /^[\w@%+=:,./~-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`).join(' ');
const sameHub = (a, b) => String(a || '').replace(/\/$/, '') === String(b || '').replace(/\/$/, '');

// What's wrong with one tool's backchannel server, given the hub this computer is signed in to.
function problems(state, cfg) {
  const s = state.server;
  if (!s) return ['not set up'];
  const out = [];
  const env = s.env || {};
  if (env.HUB_URL && !sameHub(env.HUB_URL, cfg.hub)) out.push(`HUB_URL pins it to ${env.HUB_URL}${cfg.hub ? `, but you're signed in to ${cfg.hub}` : ''}`);
  if (env.HUB_TOKEN) out.push('it has its own HUB_TOKEN instead of your sign-in');
  const runs = [s.command, ...s.args].join(' ');
  if (!s.args.includes(BIN) && !/backchannel(\.js)?\s+mcp/.test(runs)) out.push(`it runs ${tilde(runs)}, not this install`);
  return out;
}

// ---------- nudges, so agents use Backchannel without being told ----------
// Claude Code gets the instructions from the MCP server itself; the hook adds a 📬 line to every prompt while
// messages are unread. Codex gets the instructions as a marked block in its global AGENTS.md.

const CLAUDE_SETTINGS = path.join(HOME, '.claude', 'settings.json');
const CODEX_AGENTS = path.join(path.dirname(CODEX_TOML), 'AGENTS.md');
const START = '<!-- backchannel:start -->', END = '<!-- backchannel:end -->';
// The hook reads the inbox of the handle the session runs as: your handle, unless setup kept an AGENT_ID.
const hookCommand = (id) => shellArgs([NODE, BIN, 'inbox-hook', ...(id ? [id] : [])]);
const isOurHook = (h) => /inbox-hook/.test(h?.command || '');

function inspectHook(id) {
  let json = {};
  try { json = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS, 'utf8')); }
  catch (err) { if (err.code !== 'ENOENT') return { unreadable: true, problem: `can't read ${tilde(CLAUDE_SETTINGS)} (${err.message})` }; }
  const want = hookCommand(id);
  const found = (json.hooks?.UserPromptSubmit || []).flatMap((g) => g.hooks || []).filter(isOurHook);
  const ok = found.length === 1 && found[0].command === want;
  return { json, want, found, ok, problem: ok ? null : found.length ? 'the unread-messages hook runs another install' : 'no unread-messages hook' };
}

function setupHook(state, log) {
  if (state.unreadable) return log(`  ! Claude Code: skipped the unread-messages hook: ${state.problem}`);
  const { json } = state;
  json.hooks ||= {};
  const groups = (json.hooks.UserPromptSubmit || [])
    .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !isOurHook(h)) }))
    .filter((g) => g.hooks.length);
  json.hooks.UserPromptSubmit = [...groups, { hooks: [{ type: 'command', command: state.want }] }];
  fs.mkdirSync(path.dirname(CLAUDE_SETTINGS), { recursive: true });
  if (fs.existsSync(CLAUDE_SETTINGS)) fs.copyFileSync(CLAUDE_SETTINGS, CLAUDE_SETTINGS + '.bak');
  fs.writeFileSync(CLAUDE_SETTINGS, JSON.stringify(json, null, 2) + '\n');
  log(`  ✓ Claude Code: ${state.found.length ? 'updated' : 'added'} the unread-messages hook in ${tilde(CLAUDE_SETTINGS)}`);
}

const instructions = () => fs.readFileSync(new URL('./AGENT_INSTRUCTIONS.md', import.meta.url), 'utf8').trim();

function inspectInstructions() {
  let text = '';
  try { text = fs.readFileSync(CODEX_AGENTS, 'utf8'); } catch {}
  const block = `${START}\n${instructions()}\n${END}`;
  const at = text.indexOf(START), end = text.indexOf(END);
  // Instructions someone pasted in by hand (no markers) are theirs to keep.
  const byHand = at < 0 && /check_inbox/.test(text) && /backchannel/i.test(text);
  const ok = byHand || (at >= 0 && text.slice(at, end + END.length) === block);
  return { text, block, at, end, ok, problem: ok ? null : at >= 0 ? `the Backchannel instructions in ${tilde(CODEX_AGENTS)} are out of date` : `no Backchannel instructions in ${tilde(CODEX_AGENTS)}` };
}

function setupInstructions(state, log) {
  const { text, block, at, end } = state;
  const next = at >= 0 && end > at
    ? text.slice(0, at) + block + text.slice(end + END.length)
    : (text.trim() ? text.replace(/\n*$/, '\n\n') : '') + block + '\n';
  fs.mkdirSync(path.dirname(CODEX_AGENTS), { recursive: true });
  fs.writeFileSync(CODEX_AGENTS, next);
  log(`  ✓ Codex: ${at >= 0 ? 'updated' : 'added'} the Backchannel instructions in ${tilde(CODEX_AGENTS)}`);
}

// [inspect MCP config, set it up, inspect the nudge, set it up]
const TOOLS = [
  [inspectClaude, setupClaude, (state, cfg) => inspectHook(keptEnv(state, cfg).AGENT_ID), setupHook],
  [inspectCodex, setupCodex, inspectInstructions, setupInstructions],
];

// Settings worth keeping from the old config: a chosen handle, name or team, unless they were meant for another hub.
function keptEnv(state, cfg) {
  const env = state.server?.env || {};
  if (env.HUB_URL && !sameHub(env.HUB_URL, cfg.hub)) return {};
  return Object.fromEntries(['AGENT_ID', 'AGENT_OWNER', 'HUB_TEAM'].filter((k) => env[k]).map((k) => [k, env[k]]));
}

// Points every installed coding agent at this install. Returns true if anything changed.
export function setupAgents(cfg, log = console.log) {
  let changed = false, found = false;
  for (const [inspect, setup, inspectNudge, setupNudge] of TOOLS) {
    const state = inspect();
    if (!state.installed) continue;
    found = true;
    if (!problems(state, cfg).length) log(`  ✓ ${state.name}: already connected`);
    else { setup(state, keptEnv(state, cfg), log); changed = true; }
    const nudge = inspectNudge(state, cfg);
    if (!nudge.ok) { setupNudge(nudge, log); changed = true; }
  }
  if (!found) log('  No Claude Code or Codex found on this computer. Install one, then run: backchannel setup');
  if (changed) log('\nRestart any open Claude Code and Codex sessions: they connect when they start.');
  return changed;
}

// Read-only health check: hub, sign-in, team, and each coding agent's config. Returns the number of problems.
export async function doctor(hub, cfg, log = console.log) {
  let bad = 0;
  const ok = (m) => log(`  ✓ ${m}`);
  const fail = (m, fix) => { bad++; log(`  ✗ ${m}${fix ? `\n      → ${fix}` : ''}`); };
  log(`Backchannel doctor (client in ${tilde(path.dirname(BIN).replace(/\/bin$/, ''))})\n`);

  if (!cfg.hub || !cfg.token) fail(`This computer isn't signed in${cfg.hub ? ` to ${cfg.hub}` : ' to a hub'}`, "On your hub's Connect page, click Create setup command and run it");
  else {
    // Any HTTP answer means it's reachable; hubs older than 0.2 have no /healthz.
    const up = await fetch(new URL('/healthz', cfg.hub))
      .then(async (r) => ({ ok: r.status < 500, version: (await r.json().catch(() => ({}))).version }))
      .catch((e) => ({ error: e.cause?.code || e.message }));
    if (!up.ok) fail(`Can't reach ${cfg.hub} (${up.error || 'not healthy'})`, sameHub(cfg.hub, 'http://127.0.0.1:7777') ? 'Start the local hub with node hub.js, or sign in to your team\'s hub' : 'Check the address and your network');
    else ok(`Hub ${cfg.hub} is reachable${up.version ? ` (v${up.version})` : ''}`);
    if (up.ok) {
      try {
        const me = await hub.resolveTeam();
        const team = me.teams.find((t) => t.id === hub.team);
        ok(`Signed in as @${me.user.handle}, team "${team.name}" (${team.role})`);
      } catch (err) {
        fail(err.message, err.status === 401 ? "Your sign-in no longer works. Create a new sign-in command on the hub's Connect page and run it" : null);
      }
    }
  }
  for (const [inspect, , inspectNudge] of TOOLS) {
    const state = inspect();
    if (!state.installed) { log(`  - ${state.name}: not installed`); continue; }
    const issues = problems(state, cfg);
    const nudge = inspectNudge(state, cfg);
    if (!nudge.ok) issues.push(nudge.problem);
    for (const dir of state.shadows || []) issues.push(`${tilde(dir)} overrides it with its own project-local server (claude mcp remove backchannel --scope local, in that folder)`);
    if (issues.length) fail(`${state.name}: ${issues.join('; ')}`, 'Run: backchannel setup');
    else ok(`${state.name}: connected through this install${state.server.env.AGENT_ID ? ` as @${state.server.env.AGENT_ID}` : ''}`);
  }
  log(bad ? `\n${bad} problem${bad > 1 ? 's' : ''}. After fixing, restart open Claude Code and Codex sessions.` : '\nAll good. Sessions started before a change need a restart to pick it up.');
  return bad;
}
