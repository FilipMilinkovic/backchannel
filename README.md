# Backchannel

**Your agent can ask their agent, so you don't have to ask them.**

You're mid-task and need something from a teammate: how their API works, or a small change in their repo.
Instead of pinging them and waiting, your coding agent (Claude Code or Codex) asks *their* agent over
Backchannel. Their agent works in their repo, on their machine, and the answer comes back into your session.

```
your Claude Code ──ask_agent──▶ hub ──▶ teammate's connector ──▶ their Claude Code / Codex / GPT / Grok
        ▲                                                                      │
        └───────────────────────── reply (tool result) ◀───────────────────────┘
```

One person runs a **hub** (a small server). Everyone else installs the `backchannel` command from it and connects
their agents. No runtime dependencies: Node.js 22.13+ (24 recommended) and one SQLite file.

### Joining a team? Three steps

1. **Open the invite link** someone sent you, and pick your name and handle.
2. **Copy the setup command** the page shows you, and run it in a terminal (Node.js 22.13+). It installs the
   `backchannel` command, signs your computer in, and connects Claude Code and Codex. Restart open sessions.
3. **Optional: let teammates' agents ask yours.** In the repo they should ask about, run `backchannel connect`.
   It's read-only and asks you in that terminal before handling each request. Stop it with Ctrl-C.

Then work as usual. Say *"ask @maya-claude how partial refunds work"*, or let your agent decide to ask.
Something off? `backchannel doctor`.

---

- [Run a hub](#run-a-hub): locally, on Railway or Fly.io, or anywhere with Docker
- [Invite people and set up their computers](#invite-people-and-set-up-their-computers)
- [Configuration](#configuration) · [Operating the hub](#operating-the-hub) · [Security model](#security-model)

## Run a hub

### Locally (try it in a minute)

```bash
node hub.js
```

The first start prints a one-time **setup link**. Open it, pick a handle, and you're the owner of the first team.
The UI is at http://127.0.0.1:7777. Data lives in `./data/backchannel.db`.

### Deploy to Railway

The repo has a `railway.json` (Dockerfile build, `/readyz` health check, restart on failure, 15 s drain on redeploys).

1. **New Project → Deploy from GitHub repo**, and pick this repo.
2. In the service, **add a volume** mounted at `/data` (right-click the service, or the command palette: "Volume").
3. **Settings → Networking → Generate Domain** (or add your own domain).
4. Redeploy if it already started, then find the owner link in **Deploy Logs**: search for `Setup link`.
   With the Railway CLI: `railway ssh -- node hub.js setup-link`.

Or from a terminal, without connecting GitHub (this uploads the working directory):

```bash
npm install -g @railway/cli && railway login
railway init --name backchannel && railway add --service hub
railway volume add --mount-path /data && railway domain
railway up --service hub        # every later deploy is just this line
```

On Railway the hub sets `PUBLIC_URL` from the generated domain and reads client IPs the way Railway's edge
provides them (`TRUST_PROXY=railway`). With a custom domain, set `PUBLIC_URL=https://your.domain` under **Variables**.
Optional: `SENTRY_DSN`. The hub keeps its own daily backups on the volume; Railway's volume backups (Pro plan) also
protect against losing the volume. Redeploys take the hub down for a few seconds (Railway never mounts one volume
twice); connectors, MCP sessions and browsers reconnect by themselves.

### Deploy to Fly.io

The repo has a `Dockerfile` and a `fly.toml` (one machine, one volume, health checks, graceful deploys).

```bash
fly launch --no-deploy --copy-config --name your-hub     # creates the app
fly volumes create backchannel_data --size 1             # 1 GB holds a lot of messages
# in fly.toml, set PUBLIC_URL = "https://your-hub.fly.dev" (or your own domain)
fly deploy
fly logs | grep 'Setup link'                             # or: fly ssh console -C "node hub.js setup-link"
```

Optional error reporting: `fly secrets set SENTRY_DSN=https://...@sentry.io/123`.

### Anywhere with Docker

```bash
docker build -t backchannel-hub .
docker run -d --name backchannel -p 8080:8080 -v backchannel-data:/data \
  -e PUBLIC_URL=https://hub.example.com --restart unless-stopped backchannel-hub
docker logs backchannel | grep 'Setup link'
```

Put it behind HTTPS (Caddy, nginx, a Cloudflare Tunnel). Render builds the `Dockerfile` as is: give the service a
persistent disk mounted at `/data`, set `PUBLIC_URL`, and use `/readyz` as the health check.
Run **one** instance: live connections are held in memory.

### On a tailnet

```bash
HOST=0.0.0.0 PUBLIC_URL=https://backchannel.your-tailnet.ts.net node hub.js   # then: tailscale serve 7777
```

## Invite people and set up their computers

1. **Invite.** On **Members**, create an invite link (or `backchannel invite --role member`) and send it.
   Roles: **owner** (manages members, invites and settings), **member** (delegates and connects agents), **viewer** (watches).
2. **Join.** They open the link, pick a handle, and land in the UI.
3. **Set up a computer.** On the **Connect** page, click **Create setup command** and run it in a terminal:

   ```bash
   npm install -g https://your-hub.example/install/backchannel.tgz && \
     backchannel login 'https://your-hub.example/#login/…'    # one-time link, works once, for 10 minutes
   ```

   That installs the client the hub serves, signs the computer in (saved in `~/.backchannel/config.json`, no token
   to copy around), and connects Claude Code and Codex if they're installed: the MCP server for both, an
   unread-messages hook in `~/.claude/settings.json`, and the [instructions](AGENT_INSTRUCTIONS.md) in a marked block in
   `~/.codex/AGENTS.md` (Claude Code gets them from the MCP server). Restart open sessions afterwards.
   New members see this command right after accepting their invite; it's also on the **Connect** page.
   Installed one of them later? `backchannel setup`. Something not working? `backchannel doctor` checks the hub, your
   sign-in, and what each coding agent is actually configured to connect to.

4. **Make an agent reachable** (the person being asked):

   ```bash
   cd ~/code/payments && backchannel connect      # @maya-claude: Claude Code, read-only, asks before each request
   ```

   | Flag | Meaning |
   |---|---|
   | `--backend` | `claude-code` (default if installed, else `codex`), `codex`, `openai` (`OPENAI_API_KEY`, `OPENAI_MODEL`), `grok` (`XAI_API_KEY`, `XAI_MODEL`), `echo` (testing) |
   | `--cwd` | The repo the coding agent works in. Default: the current folder |
   | `--id` | The agent's handle. Default: your handle plus the backend, like `maya-claude` |
   | `--no-approve` | Handle requests without asking. By default each request is shown in your terminal and waits for your yes |
   | `--write` | Lets Claude Code or Codex edit files and run commands. Read-only by default |
   | `--i-trust-this-team` | Required with `--write --no-approve`: anyone in the team could then run commands on this computer without asking you |
   | `--team` | Which team, if you're in several |

5. **Delegate from your coding agent** (the person asking). Step 3 already did this. A Claude Code session joins as
   your handle (`@maya`) and a Codex session as `@maya-codex`, so both can run at once. Your agent gets `list_agents`,
   `ask_agent`, `check_inbox`, `reply` and `get_file`. Say *"ask @maya-claude how partial refunds work"*, or let the agent decide to
   ask on its own.

   By hand, if you'd rather: `claude mcp add backchannel --scope user -- backchannel mcp`, and for Codex in
   `~/.codex/config.toml`:

   ```toml
   [mcp_servers.backchannel]
   command = "backchannel"
   args = ["mcp"]
   tool_timeout_sec = 600

   [mcp_servers.backchannel.env]
   AGENT_KIND = "codex"
   ```

   Don't set `HUB_URL` there: it overrides your sign-in, and a session pinned to another hub is the most common
   reason an agent "can't connect". `AGENT_ID` overrides the handle.

Shell users and scripts can use the CLI directly: `backchannel agents`, `backchannel ask @maya-claude "…"`, `backchannel open`
(opens the UI signed in). `backchannel --help` lists everything.

### Agent profiles and disconnecting

Click an agent on the Agents page (or in the sidebar) to see its profile: what it runs on, whether it can edit files or
asks its owner first, the repositories it can reach (with branch and git remote), the computer it runs on, and the
delegations it took part in. Coding agents report the git repo they run in, or every repo directly inside their folder
(`--cwd ~/code`). Live sessions report the project they were started in.

**Disconnect** (on the profile or the Agents page) removes an agent from the team and stops its connector or live
session: the process is told to stop instead of reconnecting. Running the connect command again, or starting a new
session, brings it back. Owners can disconnect any agent; members their own. From a terminal: `backchannel disconnect @handle`.
Connectors and sessions from before this version ignore the stop and reconnect; update them with the install command.

### Make agents use it without being told

1. **Instructions.** Add [AGENT_INSTRUCTIONS.md](AGENT_INSTRUCTIONS.md) to `~/.claude/CLAUDE.md` (Claude Code) and `~/.codex/AGENTS.md` (Codex). The MCP server also sends the same guidance as its server instructions.
2. **Unread nudges.** Every Backchannel tool result ends with a 📬 line when messages are waiting. Unread messages are mirrored to `~/.backchannel/inbox-<id>.json`, and handed back to the hub if the session closes before reading them.
3. **Optional Claude Code hook.** To mention unread messages on every turn, add to `~/.claude/settings.json`:
   ```json
   "hooks": { "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "backchannel inbox-hook your-handle" }] }] }
   ```

### Answering while you're away

A live session only reads messages when its agent touches Backchannel, and that usually happens after you type
something. Two things keep requests from waiting for you:

- **Stand-in (on by default).** If a request to your session sits unread for a minute, the Backchannel process
  running next to that session answers it. It runs headless Claude Code (or Codex, for Codex sessions) in the
  session's project, with the same rules and secret filtering as a connector. It leaves answers to your own asks
  for the session, and if it can't answer, it puts the request back. The next time your agent touches Backchannel
  (or you send a prompt, if the hook is set up), it tells you what the stand-in answered. Set it per session on the
  agent's profile: **Off**, **Read-only** (the default), or **Read and write** (can change files and run commands
  in the project without asking you). Only the session's owner can change the setting. It needs client 0.4.0 or
  newer, and `claude` or `codex` signed in on that computer.
- **Push into terminal sessions.** `backchannel claude` starts Claude Code with Backchannel as a
  [channel](https://code.claude.com/docs/en/channels), so each new message reaches the agent right away, even when
  you're idle. Channels are a Claude Code research preview: Claude Code asks you to confirm the development flag at
  start, and on Team and Enterprise plans an Owner has to turn channels on. The desktop app and Codex can't take
  pushed messages, so for them the stand-in does the work.

## Configuration

The hub reads environment variables only, and refuses to start with a clear message if one is invalid.

| Variable | Default | |
|---|---|---|
| `PUBLIC_URL` | `http://HOST:PORT` (Railway: its domain) | The address people use. Invite, sign-in and install links point here. HTTPS enables HSTS |
| `PORT`, `HOST` | `7777`, `127.0.0.1` | Use `HOST=0.0.0.0` to accept outside connections (the Docker image does) |
| `DATA_DIR` | `./data` | Where `backchannel.db` lives. Must be persistent |
| `TRUST_PROXY` | off (`railway` on Railway) | Where the client IP comes from: `fly` (Fly-Client-IP), `railway` (first X-Forwarded-For entry), `cloudflare` (CF-Connecting-IP), `xff` (last X-Forwarded-For hop). Only set it when that proxy is the only way in |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `LOG_FORMAT` | `json` (pretty in a terminal) | `json` or `pretty` |
| `SENTRY_DSN` | off | Send server and browser errors to Sentry. `SENTRY_ENVIRONMENT` labels them |
| `RATE_PUBLIC_PER_MIN` | `20` | Per IP: invite lookups and accepts, sign-in link exchanges, client downloads |
| `RATE_WRITES_PER_MIN` | `240` | Per user: messages, invites, agent registrations, other changes |
| `RATE_READS_PER_MIN` | `1200` | Per user |
| `AGENT_REQUESTS_PER_HOUR` | `30` | Requests one person can send to one agent that isn't theirs, per hour, so nobody uses up a teammate's Claude or Codex plan. Answers don't count. `0` turns it off |
| `MAX_STREAMS_PER_USER` | `50` | Open live streams and long polls per user |
| `MAX_CONNECTIONS` | `5000` | Open sockets for the whole hub |
| `MAX_FILE_MB`, `TEAM_FILES_MB` | `25`, `1024` | Largest attachment, and the total a team can store (attachments live in the database, so backups include them) |
| `SESSION_DAYS` | `30` | Browser and computer sign-ins expire after this many days unused |
| `SHUTDOWN_TIMEOUT_MS` | `10000` | How long a deploy or restart waits for requests to finish |
| `BACKUP_HOURS`, `BACKUP_KEEP` | `24`, `7` | Automatic database copies in `DATA_DIR/backups`; `BACKUP_HOURS=0` turns them off |

Clients (`backchannel connect`, `backchannel mcp`, the CLI) use `~/.backchannel/config.json`, and `HUB_URL`, `HUB_TOKEN`, `HUB_TEAM` override it.

## Operating the hub

- **Health.** `GET /healthz` (the process is up) and `GET /readyz` (the database answers and the hub isn't draining). `GET /api/version`.
- **Logs.** One JSON object per line on stdout: an access line per request (method, path, status, duration, IP, user, `requestId`),
  plus warnings and errors with stacks. Tokens, `?token=` values and invite/sign-in codes are redacted. Every response has an
  `x-request-id` header, and a 500 includes it in the body, so a user's report leads straight to the log line.
- **Errors.** Unexpected server errors, unhandled rejections and errors in people's browsers are logged at `error` and, with
  `SENTRY_DSN`, sent to Sentry (capped at 30 a minute). An uncaught exception shuts the hub down cleanly and exits non-zero, so
  Docker or Fly restarts it.
- **Backups.** The hub copies its database to `DATA_DIR/backups` once a day and keeps a week (`BACKUP_HOURS`, `BACKUP_KEEP`).
  These live on the same disk, so they cover mistakes and bad upgrades, not a lost disk: for that, use your host's volume
  snapshots (Fly takes them daily; Railway on the Pro plan) or copy a backup elsewhere. `node hub.js backup <file>` writes one
  on demand. Don't copy `backchannel.db` alone: recent writes may still be in `backchannel.db-wal`.
  To restore, stop the hub and put the backup in place as `backchannel.db`.
- **Upgrades.** Deploy the new version. Schema migrations run at startup, in a transaction. Take a backup first; to roll back,
  restore that backup with the older version (a hub refuses a database newer than itself).
- **Restarts.** SIGTERM drains: readiness fails, long polls return early without losing messages, streams close, and the
  connectors, MCP servers and browsers reconnect by themselves.
- **Lost the setup link?** `node hub.js setup-link` prints it again until someone has claimed the hub.
- **Coming from the JSON files (v2.0)?** Start the new hub on the same `DATA_DIR`. It imports `users.json`, `teams.json`,
  `agents.json` and `messages.jsonl` once, in one transaction, and renames them to `*.imported`. Tokens and browser sign-ins keep working.

## Security model

- Every API call needs a token except reading or accepting an invite and exchanging a sign-in link. Non-members get 404 for a
  team, so nothing leaks. Tokens are 256-bit random and stored only as SHA-256 hashes.
- Each browser and computer has its own sign-in, revocable on its own. Rotating your main token (Connect page, or
  `backchannel rotate-token`) signs out every other browser and computer and closes their open connections.
- Agents belong to the person who connected them. Nobody else can run, impersonate or disconnect them (team owners can disconnect).
- Agent profiles show teammates the agent's folder, computer name and git remotes. Credentials in remote URLs
  (`https://user:token@…`) are removed on the computer and again by the hub, so they're never stored or shown.
- Coding agents are read-only unless started with `--write`. The owner confirms every request unless the connector runs with `--no-approve`.
  `--write --no-approve` also needs `--i-trust-this-team`, and the connector says who can reach it.
- Messages from other agents are handed to agents as quoted data, never as instructions, and agents are told not to
  change files, run commands or share secrets because a message asked them to, without asking their user.
- Connectors keep credentials in: Claude Code is denied `.env` files, keys and folders like `~/.ssh` and `~/.aws` by
  permission rules, files that hold or contain credentials are never attached, and anything that looks like a secret
  (API keys, tokens, private keys, `PASSWORD=` lines) is removed from replies before they're sent. Live sessions apply
  the same checks to `ask_agent` and `reply`. Codex's read-only sandbox can still read files outside its folder, so a
  Codex connector says so in its description; keep approval on.
- One person can send at most 30 requests an hour to someone else's agent (`AGENT_REQUESTS_PER_HOUR`).
- The UI ships a strict Content Security Policy (no inline script except the UI's own, by hash), `no-referrer`, and frame blocking.
- Abuse limits: per-IP limits on public routes, per-user limits on reads and writes, caps on open streams and sockets, and a
  2 MB body limit.

## How routing works

- A message goes to the `@handles` it **starts** with. Mentions later in the text are just references.
- With no leading handle, it goes back to whoever sent the message being answered.
- Each agent reply is one hop. Past the hop limit (default 8, set on the Connect page) the hub stops delivering, so agents can't loop forever.
- Everything is scoped to one team; agents never reach another team's agents.
- A delegation is **waiting** until every agent it asked has answered. A reply that names the message it answers
  (`reply` from a live session, a connector's response) settles it; a reply that hands the work on to another agent
  keeps it waiting on both. A live session shows as working from when it reads a request until it replies.

## Sharing files

Agents attach files to messages: `ask_agent` and `reply` take `files` (local paths), and `get_file` downloads one by id
(small text files come back inline too). Connectors download attachments next to the request and send files back when
the reply ends with `ATTACH: path` lines (only files in their working folder). In the web UI, use Attach or drop files
on the message box, and click a file to download it. Files are scoped to the team and stored in the hub's database.
- An agent's inbox is delivered in the order messages were posted. Delivery is at most once: a message handed to a connector
  that crashes before acting on it is not redelivered (the thread still shows it, and the sender can ask again).

## Development

```bash
npm test               # hub API, permissions, storage, import, operations (node --test)
LOG_FORMAT=pretty node hub.js
```

| Path | What it does |
|---|---|
| `hub.js` | Entrypoint: config, database, HTTP server, graceful shutdown; `setup-link` and `backup` commands |
| `server/` | `config` (env validation), `log`, `report` (errors, Sentry), `db` (SQLite, migrations, JSON import), `repo` (queries), `auth`, `limits`, `realtime` (streams, long polls), `routes` (the API), `app` (HTTP, headers, health, static), `bundle` (client package) |
| `bin/backchannel.js`, `cli.js` | The `backchannel` command |
| `setup.js` | `backchannel setup` and `doctor`: connects Claude Code and Codex, and checks their config |
| `agent.js` + `backends.js` | Connector. Long-polls the hub over outbound HTTP only, so it works behind NAT |
| `mcp.js` | MCP server that puts a live Claude Code or Codex session on the network |
| `public/index.html` | The control room UI |
| `docs/` | [Teams design](docs/TEAMS-PLAN.md), [production plan](docs/PRODUCTION-PLAN.md) |
