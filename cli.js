#!/usr/bin/env node
// Backchannel CLI: join a team, see who's there, ask agents, invite people.
//   node cli.js join <invite-link>          node cli.js ask @maya "how do refunds work?"
//   node cli.js whoami | teams | use <team> | agents | disconnect @agent | reply <messageId> "…" | invite [--role member] | rotate-token
// Settings live in ~/.backchannel/config.json; HUB_URL, HUB_TOKEN and HUB_TEAM override them.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { Hub, CONFIG_FILE as CONFIG, loadConfig } from './client.js';
import { setupAgents, doctor } from './setup.js';
function saveConfig(cfg) {
  fs.mkdirSync(path.dirname(CONFIG), { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

const { values: opt, positionals: [cmd, ...args] } = parseArgs({
  allowPositionals: true,
  options: {
    hub: { type: 'string' }, team: { type: 'string' }, handle: { type: 'string' }, name: { type: 'string' },
    as: { type: 'string' }, repo: { type: 'string' }, wait: { type: 'string', default: '300' }, 'show-token': { type: 'boolean', default: false },
    role: { type: 'string', default: 'member' }, uses: { type: 'string', default: '1' }, hours: { type: 'string', default: '168' },
    print: { type: 'boolean', default: false }, 'skip-agents': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h' },
  },
});

const cfg = loadConfig();
const hubUrl = opt.hub || process.env.HUB_URL || cfg.hub || 'http://127.0.0.1:7777';
const hub = new Hub(hubUrl, process.env.HUB_TOKEN || cfg.token, opt.team || process.env.HUB_TEAM || cfg.team);
// "backchannel" when installed, "node cli.js" in a clone; used in help and hints.
const BIN = /backchannel(\.js)?$/.test(process.argv[1] || '') ? 'backchannel' : 'node cli.js';
const die = (msg) => { console.error(msg); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connectAgents(saved, force = false) {
  if (opt['skip-agents'] && !force) return console.log(`Skipped Claude Code and Codex. Connect them later with: ${BIN} setup`);
  console.log('\nConnecting your coding agents:');
  setupAgents(saved);
  console.log(`\nTo let teammates' agents ask yours, run this in the repo they should ask about:\n  cd ~/code/your-repo && ${BIN} connect`);
}

const commands = {
  async join() {
    const link = args[0] || die(`usage: ${BIN} join <invite-link> [--handle you] [--name "Your Name"]`);
    // Accept a full link (http://host/#join/<code>), even inside pasted text, or a bare code.
    const m = link.match(/(https?:\/\/[^#\s'"]+?)\/?#join\/([a-f0-9]+)/);
    const base = m ? m[1] : hubUrl;
    const code = m ? m[2] : link.trim();
    if (!/^[a-f0-9]+$/.test(code)) die(`That doesn't look like an invite link: ${link}`);
    const joiner = new Hub(base, base === cfg.hub ? cfg.token : undefined);
    const info = await joiner.req('GET', `/api/invites/${code}`);
    console.log(`Invite to "${info.teamName}" as ${info.role}${info.invitedBy ? `, from ${info.invitedBy}` : ''}.`);
    const body = joiner.token ? {} : {
      handle: (opt.handle || os.userInfo().username).toLowerCase().replace(/[^a-z0-9_-]/g, ''),
      name: opt.name || opt.handle || os.userInfo().username,
    };
    const res = await joiner.req('POST', `/api/invites/${code}/accept`, body);
    const saved = { ...cfg, hub: base, token: res.token || joiner.token, team: res.team.id, handle: res.user.handle, name: res.user.name };
    saveConfig(saved);
    console.log(`Joined "${res.team.name}" as @${res.user.handle}. Saved to ${CONFIG}.`);
    if (res.token) {
      // Tokens stay out of terminal output (and logs, transcripts) unless asked for.
      console.log(`Your personal token is saved there; connectors and MCP servers on this machine use it automatically.`);
      console.log(opt['show-token'] ? `\n  ${res.token}` : `For another machine, print it with: ${BIN} token`);
    }
    connectAgents(saved);
  },

  // Signs this computer in with a one-time link from the Connect page. It gets its own credential,
  // which can be revoked without touching other computers.
  async login() {
    const link = args[0] || die(`usage: ${BIN} login '<sign-in link>'   (create one on the Connect page of your hub)`);
    const m = link.match(/(https?:\/\/[^#\s'"]+?)\/?#login\/([a-f0-9]+)/);
    if (!m) die(`That doesn't look like a sign-in link: ${link}`);
    const [, base, code] = m;
    const res = await new Hub(base).req('POST', `/api/login/${code}`, { label: `cli on ${os.hostname()}`.slice(0, 60), kind: 'cli' });
    const me = await new Hub(base, res.token).req('GET', '/api/me');
    const keepTeam = cfg.hub === base && me.teams.some((t) => t.id === cfg.team);
    const team = keepTeam ? cfg.team : me.teams.length === 1 ? me.teams[0].id : undefined;
    const saved = { ...cfg, hub: base, token: res.token, team, handle: me.user.handle, name: me.user.name };
    saveConfig(saved);
    console.log(`Signed in as @${me.user.handle} on ${base}. Saved to ${CONFIG}.`);
    if (!team && me.teams.length > 1) console.log(`You're in several teams; pick one with: ${BIN} use <team>`);
    connectAgents(saved);
  },

  // Points Claude Code and Codex at this hub (login and join do this too). Run it after installing one of them.
  async setup() {
    if (!cfg.token) die(`This computer isn't signed in yet. Create a sign-in command on your hub's Connect page and run it.`);
    const me = await hub.req('GET', '/api/me');
    console.log(`Signed in as @${me.user.handle} on ${hub.url}.`);
    connectAgents(cfg, true);
  },

  async doctor() {
    process.exitCode = (await doctor(hub, { ...cfg, hub: opt.hub || process.env.HUB_URL || cfg.hub, token: hub.token })) ? 1 : 0;
  },

  async whoami() {
    const me = await hub.req('GET', '/api/me');
    console.log(`@${me.user.handle} (${me.user.name}) on ${hub.url}`);
    for (const t of me.teams) console.log(`  ${t.id === (hub.team || cfg.team) ? '*' : ' '} ${t.name} (${t.id}): ${t.role}`);
  },

  async teams() { return commands.whoami(); },

  async use() {
    const want = args[0] || die(`usage: ${BIN} use <team id or name>`);
    hub.team = want;
    await hub.resolveTeam();
    saveConfig({ ...cfg, team: hub.team });
    console.log(`Default team set to ${hub.team}.`);
  },

  async agents() {
    await hub.resolveTeam();
    const list = await hub.agents();
    if (!list.length) return console.log('No agents in this team yet.');
    for (const a of list) {
      console.log(`@${a.id.padEnd(16)} ${a.online ? (a.state !== 'idle' ? 'busy   ' : 'online ') : 'offline'} ${a.backend}${a.ownerHandle ? ` · @${a.ownerHandle}` : ''}${a.access === 'write' ? ' · can edit' : ''}`);
      if (a.description) console.log(`  ${a.description}`);
    }
  },

  // Removes an agent and stops its connector or live session. Your own agents, or any agent if you own the team.
  async disconnect() {
    const id = (args[0] || die(`usage: ${BIN} disconnect @agent`)).replace(/^@/, '').toLowerCase();
    await hub.resolveTeam();
    await hub.req('DELETE', hub.t(`/agents/${encodeURIComponent(id)}`));
    console.log(`Disconnected @${id}. Its connector or session stops at its next check-in; starting it again reconnects it.`);
  },

  // Posts as you (or as one of your agents with --as) and waits for replies in the thread.
  async ask() {
    // `ask --repo payments "…"` picks an agent that works in that repo: online ones first, connectors before sessions.
    const byRepo = opt.repo && !String(args[0] || '').startsWith('@');
    let to = byRepo ? '' : (args[0] || '').replace(/^@/, '');
    const text = args.slice(byRepo ? 0 : 1).join(' ');
    if ((!to && !byRepo) || !text) die(`usage: ${BIN} ask @agent "message" [--repo name] [--wait seconds] [--as your-agent]\n       ${BIN} ask --repo name "message"`);
    await hub.resolveTeam();
    const agents = await hub.agents();
    if (byRepo) {
      const want = opt.repo.toLowerCase();
      const found = agents.filter((a) => (a.repos || []).some((r) => r.name?.toLowerCase() === want) || a.repo?.toLowerCase() === want)
        .sort((x, y) => (y.online - x.online) || ((y.kind !== 'session') - (x.kind !== 'session')) || (!!y.service - !!x.service));
      if (!found.length) die(`No agent works in ${opt.repo}. Repositories agents work in: ${[...new Set(agents.flatMap((a) => (a.repos || []).map((r) => r.name)))].sort().join(', ') || 'none reported'}`);
      to = found[0].id;
      console.error(`Asking @${to}, which works in ${opt.repo}.`);
    }
    const target = agents.find((a) => a.id === to.toLowerCase());
    if (!target) die(`@${to} isn't an agent in this team. Agents: ${agents.map((a) => '@' + a.id).join(', ') || 'none yet'}`);
    if (!target.online) console.error(`@${to} is offline; the request will wait in its inbox.`);
    const sent = await hub.post({ ...(opt.as ? { from: opt.as } : {}), text: `@${to} ${text}`, ...(opt.repo ? { repo: opt.repo } : {}) });
    if (sent.note) die(`Not delivered: ${sent.note}`);
    console.error(`Sent to @${to} (thread ${sent.threadId}). Waiting up to ${opt.wait}s…`);
    const seen = new Set([sent.id]);
    const deadline = Date.now() + Number(opt.wait) * 1000;
    while (Date.now() < deadline) {
      await sleep(2000);
      const replies = (await hub.thread(sent.threadId)).filter((m) => !seen.has(m.id) && m.ts >= sent.ts);
      if (replies.length) {
        for (const m of replies) console.log(`\n@${m.from}${m.kind ? ` (${m.kind})` : ''} [${m.id}]:\n${m.text}`);
        return;
      }
    }
    die(`No reply yet. Check the thread later in the UI (thread ${sent.threadId}).`);
  },

  async reply() {
    const [id, ...rest] = args;
    if (!id || !rest.length) die(`usage: ${BIN} reply <messageId> "text" [--as your-agent]`);
    await hub.resolveTeam();
    const sent = await hub.post({ ...(opt.as ? { from: opt.as } : {}), inReplyTo: id, text: rest.join(' ') });
    console.log(`Sent to ${sent.to.map((t) => '@' + t).join(', ') || 'the thread'}.`);
  },

  async invite() {
    await hub.resolveTeam();
    const inv = await hub.req('POST', hub.t('/invites'), { role: opt.role, uses: Number(opt.uses), expiresInHours: Number(opt.hours) });
    console.log(`Invite link (${inv.role}, ${inv.usesLeft} use${inv.usesLeft === 1 ? '' : 's'}, expires ${new Date(inv.expiresAt).toLocaleString()}):\n  ${inv.url}`);
    console.log(`\nThey can open it in a browser, or run: ${BIN} join '${inv.url}'`);
  },

  async 'rotate-token'() {
    const { token } = await hub.req('POST', '/api/me/token');
    saveConfig({ ...cfg, token });
    console.log(`New token saved to ${CONFIG}. The old one no longer works.`);
    console.log('Restart running connectors and MCP sessions; ones that read the saved token need no other change.');
    if (opt['show-token']) console.log(`\n  ${token}`);
  },

  // Opens the UI already signed in, through a one-time link (60 seconds, single use).
  // The browser gets its own session; your main token never leaves this machine.
  async open() {
    if (!hub.token) die(`No saved token for this hub. Join a team first: ${BIN} join <invite-link>`);
    const me = await hub.req('GET', '/api/me');
    const { url, expiresInSeconds } = await hub.req('POST', '/api/me/login-link');
    const view = args[0] ? `&view=${encodeURIComponent(args[0])}` : '';
    const link = url + view;
    if (opt.print) return console.log(`Sign-in link for @${me.user.handle} (works once, for ${expiresInSeconds}s):\n  ${link}`);
    const [cmd, ...argv] = process.platform === 'darwin' ? ['open', link]
      : process.platform === 'win32' ? ['cmd', '/c', 'start', '', link] : ['xdg-open', link];
    await new Promise((resolve) => {
      const child = spawn(cmd, argv, { stdio: 'ignore', detached: true });
      child.on('error', () => { console.log(`Couldn't open a browser. Open this within ${expiresInSeconds}s:\n  ${link}`); resolve(); });
      child.on('spawn', () => { child.unref(); console.log(`Opened Backchannel in your browser, signed in as @${me.user.handle}.`); resolve(); });
    });
  },

  // Explicit way to see the token, e.g. to set HUB_TOKEN on another machine.
  async token() {
    if (!hub.token) die('No saved token. Join a team first.');
    console.log(hub.token);
  },
};

if (!cmd || opt.help || !commands[cmd]) {
  const agentCommands = BIN === 'backchannel' ? `
  connect                     Make your agent reachable from this folder; runs until stopped
                              (--backend, --id, --write, --no-approve)
  mcp                         MCP server for Claude Code / Codex (they start it themselves)
  claude [options]            Start Claude Code with messages from other agents pushed in as they arrive
` : '';
  console.log(`Backchannel CLI

  join <invite-link>          Join a team and connect your coding agents (--show-token, --skip-agents)
  login <sign-in-link>        Sign this computer in and connect Claude Code and Codex to the hub
                              (create the link on the Connect page; --skip-agents to only sign in)
  setup                       Connect Claude Code and Codex to the hub you're signed in to (MCP, inbox hook, instructions)
  doctor                      Check the hub, your sign-in, and Claude Code and Codex
  whoami / teams              Show your account and teams
  use <team>                  Set your default team
  agents                      List agents in the team
  disconnect @agent           Remove an agent and stop its connector or session (yours, or any as owner)
  ask @agent "message"        Ask an agent and wait for the reply (--wait s, --as your-agent, --repo name)
  ask --repo name "message"   Ask whichever agent works in that repository
  reply <messageId> "text"    Reply to a message
  invite [--role member]      Create an invite link (owners; --uses n, --hours h)
  open [view]                 Open the UI signed in (one-time link; --print to show it instead)
  rotate-token                Replace your personal token and sign out browsers (--show-token)
  token                       Print your saved token (for HUB_TOKEN on another machine)
${agentCommands}
Config: ${CONFIG} (HUB_URL, HUB_TOKEN, HUB_TEAM override it)`);
  process.exit(cmd && !commands[cmd] ? 1 : 0);
}

try { await commands[cmd](); }
catch (err) {
  const unreachable = err.cause?.code === 'ECONNREFUSED' || err.message === 'fetch failed';
  die(`${err.message}${unreachable ? ` (is the hub running at ${hubUrl}?)` : ''}${err.status === 401 ? `\nYour sign-in for ${hubUrl} doesn't work. Create a new sign-in command on its Connect page and run it.` : ''}`);
}
