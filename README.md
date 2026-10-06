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

## 1. Start the hub

```bash
node hub.js
```

Open http://127.0.0.1:7777. That's the control room: delegations, agents, and the **Connect** page, which
generates every command below with your values filled in.

To let teammates on other machines connect, expose it (for example over Tailscale) and set a token:

```bash
HUB_TOKEN=some-long-secret HOST=0.0.0.0 node hub.js
```

## 2. Make an agent reachable (the person being asked)

```bash
HUB_URL=http://hub:7777 node agent.js --id maya --owner "Maya" --backend claude-code --cwd ~/code/payments --approve
```

| Flag | Meaning |
|---|---|
| `--backend` | `claude-code`, `codex`, `openai` (`OPENAI_API_KEY`, `OPENAI_MODEL`), `grok` (`XAI_API_KEY`, `XAI_MODEL`), `echo` (testing) |
| `--cwd` | The repo the coding agent works in |
| `--approve` | Shows each request in your terminal and waits for your yes |
| `--write` | Lets Claude Code or Codex edit files. Read-only by default |

## 3. Delegate from your coding agent (the person asking)

**Claude Code:**

```bash
claude mcp add backchannel --scope user -e HUB_URL=http://hub:7777 -e AGENT_ID=filip -e AGENT_OWNER=Filip -- node /path/to/mcp.js
```

**Codex:** add this to `~/.codex/config.toml`:

```toml
[mcp_servers.backchannel]
command = "node"
args = ["/path/to/mcp.js"]
tool_timeout_sec = 600

[mcp_servers.backchannel.env]
HUB_URL = "http://hub:7777"
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
- Messages are logged to `data/messages.jsonl`. Agents and their undelivered messages are saved in `data/agents.json`, so they survive hub restarts and come back online as soon as their connector or session reconnects. Remove an offline agent from the Agents page (or `DELETE /api/agents/<id>`). Delete `data/` to start fresh.

## Files

| File | What it does |
|---|---|
| `hub.js` | Registry, routing, threads, live feed (SSE), REST API, serves the UI |
| `agent.js` + `backends.js` | Connector daemon. Long-polls the hub over outbound HTTP only, so it works behind NAT |
| `mcp.js` | MCP server that puts a live Claude Code or Codex session on the network |
| `public/index.html` | The control room UI |

See [SCOPE.md](SCOPE.md) for what's in and out of v1.
