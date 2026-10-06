#!/usr/bin/env node
// Backchannel CLI: join a team, see who's there, ask agents, invite people.
//   node cli.js join <invite-link>          node cli.js ask @maya "how do refunds work?"
//   node cli.js whoami | teams | use <team> | agents | reply <messageId> "…" | invite [--role member] | rotate-token
// Settings live in ~/.backchannel/config.json; HUB_URL, HUB_TOKEN and HUB_TEAM override them.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { Hub, CONFIG_FILE as CONFIG, loadConfig } from './client.js';
function saveConfig(cfg) {
  fs.mkdirSync(path.dirname(CONFIG), { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

const { values: opt, positionals: [cmd, ...args] } = parseArgs({
  allowPositionals: true,
  options: {
    hub: { type: 'string' }, team: { type: 'string' }, handle: { type: 'string' }, name: { type: 'string' },
    as: { type: 'string' }, wait: { type: 'string', default: '300' }, 'show-token': { type: 'boolean', default: false },
    role: { type: 'string', default: 'member' }, uses: { type: 'string', default: '1' }, hours: { type: 'string', default: '168' },
    print: { type: 'boolean', default: false },
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
    saveConfig({ ...cfg, hub: base, token: res.token || joiner.token, team: res.team.id, handle: res.user.handle, name: res.user.name });
    console.log(`Joined "${res.team.name}" as @${res.user.handle}. Saved to ${CONFIG}.`);
    if (res.token) {
      // Tokens stay out of terminal output (and logs, transcripts) unless asked for.
      console.log(`Your personal token is saved there; connectors and MCP servers on this machine use it automatically.`);
      console.log(opt['show-token'] ? `\n  ${res.token}` : `For another machine, print it with: ${BIN} token`);
    }
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
    saveConfig({ ...cfg, hub: base, token: res.token, team, handle: me.user.handle, name: me.user.name });
    console.log(`Signed in as @${me.user.handle} on ${base}. Saved to ${CONFIG}.`);
    if (!team && me.teams.length > 1) console.log(`You're in several teams; pick one with: ${BIN} use <team>`);
    console.log(`Connectors and MCP servers on this computer now use it automatically.`);
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

  // Posts as you (or as one of your agents with --as) and waits for replies in the thread.
  async ask() {
    const to = (args[0] || '').replace(/^@/, '');
    const text = args.slice(1).join(' ');
    if (!to || !text) die(`usage: ${BIN} ask @agent "message" [--wait seconds] [--as your-agent]`);
    await hub.resolveTeam();
    const agents = await hub.agents();
    const target = agents.find((a) => a.id === to.toLowerCase());
    if (!target) die(`@${to} isn't an agent in this team. Agents: ${agents.map((a) => '@' + a.id).join(', ') || 'none yet'}`);
    if (!target.online) console.error(`@${to} is offline; the request will wait in its inbox.`);
    const sent = await hub.post({ ...(opt.as ? { from: opt.as } : {}), text: `@${to} ${text}` });
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
  connect --id <handle> --backend <claude-code|codex|openai|grok|echo> [--cwd dir] [--write] [--approve]
                              Make an agent reachable (runs until stopped)
  mcp                         MCP server for Claude Code / Codex (they start it themselves)
` : '';
  console.log(`Backchannel CLI

  join <invite-link>          Join a team (creates your account on first use; --show-token)
  login <sign-in-link>        Sign this computer in (create the link on the Connect page)
  whoami / teams              Show your account and teams
  use <team>                  Set your default team
  agents                      List agents in the team
  ask @agent "message"        Ask an agent and wait for the reply (--wait s, --as your-agent)
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
catch (err) { die(`${err.message}${err.cause?.code === 'ECONNREFUSED' || err.message === 'fetch failed' ? ` (is the hub running at ${hubUrl}?)` : ''}`); }
