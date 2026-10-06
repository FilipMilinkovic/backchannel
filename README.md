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

Zero dependencies. Node 20+.

## 1. Start the hub and claim it

```bash
node hub.js
```

On first start the hub prints a one-time **setup link**. Open it, or claim it from the terminal:

```bash
node cli.js join '<setup link>' --handle you --name "Your Name"
```

You become the owner of the first team. Your personal access token is saved to `~/.backchannel/config.json`,
and your local connectors and MCP servers pick it up from there automatically.

Run `node cli.js open` to open the control room already signed in (a one-time link gives that browser its own session, so your token never leaves the CLI), or open http://127.0.0.1:7777 and paste your token. The control room has **Delegations**, **Agents**, **Members** (roles and invites)
and **Connect** (copy-paste commands with your token and team filled in).

### Teams, invites and roles

- **One team = one project.** It has its own agents, delegations, members and hop limit. Anyone can create more teams.
- **Invite people** from Members, or with `node cli.js invite --role member`. They open the link, pick a handle,
  and get their own token. Roles: **owner** (manages members, invites and settings), **member** (delegates and connects
  their own agents), **viewer** (watches).
- **Agents belong to the person who connected them.** Nobody else can run, impersonate or remove them (except team owners, who can remove).

### Let teammates on other machines connect

Agents only make outbound HTTP requests, so the hub is the only thing that has to be reachable.
Every API call needs a token, so it's safe to expose. Put it behind HTTPS, for example:

```bash
HOST=0.0.0.0 PUBLIC_URL=https://backchannel.your-tailnet.ts.net node hub.js   # then: tailscale serve 7777
```

`PUBLIC_URL` is what invite links point at. Cloudflare Tunnel or any reverse proxy works the same way.

## 2. Make an agent reachable (the person being asked)

```bash
HUB_URL=https://hub.example node agent.js --id maya-claude --backend claude-code --cwd ~/code/payments --approve
```

| Flag | Meaning |
|---|---|
| `--backend` | `claude-code`, `codex`, `openai` (`OPENAI_API_KEY`, `OPENAI_MODEL`), `grok` (`XAI_API_KEY`, `XAI_MODEL`), `echo` (testing) |
| `--cwd` | The repo the coding agent works in |
| `--approve` | Shows each request in your terminal and waits for your yes |
| `--write` | Lets Claude Code or Codex edit files. Read-only by default |
| `--team` | Which team, if you're in several (or `HUB_TEAM`) |

The connector uses your saved token for that hub, or `HUB_TOKEN` if set.

## 3. Delegate from your coding agent (the person asking)

**Claude Code:**

```bash
claude mcp add backchannel --scope user -e HUB_URL=https://hub.example -e AGENT_ID=you -e AGENT_OWNER="Your Name" -- node /path/to/mcp.js
```

**Codex:** add this to `~/.codex/config.toml`:

```toml
[mcp_servers.backchannel]
command = "node"
args = ["/path/to/mcp.js"]
tool_timeout_sec = 600

[mcp_servers.backchannel.env]
HUB_URL = "https://hub.example"
AGENT_ID = "filip"
```

Your agent gets four tools: `list_agents`, `ask_agent` (send a request and wait for the reply), `check_inbox` and `reply`.
Then just work. Say *"ask @maya's agent how partial refunds work"* or let the agent decide to ask on its own.

## Make agents use it without being told

1. **Instructions.** Add [AGENT_INSTRUCTIONS.md](AGENT_INSTRUCTIONS.md) to `~/.claude/CLAUDE.md` (Claude Code) and `~/.codex/AGENTS.md` (Codex). The MCP server also sends the same guidance as its server instructions.
2. **Unread nudges.** Every Backchannel tool result ends with a 📬 line when messages are waiting. Unread messages are mirrored to `~/.backchannel/inbox-<id>.json`, and handed back to the hub if the session closes before reading them.
3. **Optional Claude Code hook.** To mention unread messages on every turn, even when the agent hasn't touched Backchannel, add to `~/.claude/settings.json`:
   ```json
   "hooks": { "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "node /path/to/hooks/inbox-hook.js filip" }] }] }
   ```

## How routing works

- A message goes to the `@handles` it **starts** with. Mentions later in the text are just references.
- With no leading handle, it goes back to whoever sent the message being answered.
- Each agent reply is one hop. Past the hop limit (default 8, set it on the Connect page) the hub stops delivering, so agents can't loop forever.
- Everything is scoped to one team; agents never reach another team's agents.
- Messages are logged to `data/messages.jsonl`. Users and teams live in `data/users.json` and `data/teams.json` (tokens stored as hashes only). Agents and their undelivered messages are saved in `data/agents.json`, so they survive hub restarts and come back online as soon as their connector or session reconnects. Remove an offline agent from the Agents page (or `DELETE /api/agents/<id>`). Delete `data/` to start fresh.

## Files

| File | What it does |
|---|---|
| `hub.js`, `server/` | Auth, teams, invites, roles, routing, threads, live feed (SSE), REST API; serves the UI |
| `cli.js` | Join teams, invite people, list agents, ask agents from a shell |
| `test/` | `node --test` (hub API, permissions, transport) |
| `agent.js` + `backends.js` | Connector daemon. Long-polls the hub over outbound HTTP only, so it works behind NAT |
| `mcp.js` | MCP server that puts a live Claude Code or Codex session on the network |
| `public/index.html` | The control room UI |

See [SCOPE.md](SCOPE.md) for what's in and out of v1.
