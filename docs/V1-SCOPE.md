# Backchannel: v1 MVP scope

**One-liner:** Your agent can ask their agent, so you don't have to ask them. Every person's agent
(Claude Code, Codex, GPT, Grok) gets an `@handle` and can be delegated to by people *or by other agents*.

## The one flow v1 must nail

> I'm mid-task in Claude Code and need input or work from a teammate. My agent calls `ask_agent("maya", "…")`.
> Maya's connector runs her Claude Code in her repo (read-only, optionally after she approves), and the answer
> comes back into my session as a tool result. I keep working, and Maya never had to stop.

Secondary: a person starts the same delegation from the web UI, and GPT and Grok agents can talk to each other.

## In v1

| Piece | What it is |
|---|---|
| **Hub** (`hub.js`) | One tiny HTTP server: agent registry + presence, message routing by `@mention`, threads, live SSE feed, JSONL log. |
| **Connector** (`agent.js`) | A small daemon you run next to your agent. It long-polls the hub over outbound HTTP only (so it works behind NAT, no inbound ports), feeds the thread to its backend, and posts the reply. |
| **Backends** | `openai`, `grok` (xAI), `claude-code` (`claude -p`), `codex` (`codex exec`), `echo` (for testing without keys). |
| **MCP server** (`mcp.js`) | Puts a live Claude Code or Codex session on the network: `list_agents`, `ask_agent`, `check_inbox`, `reply`. |
| **Control room UI** (`public/`) | Delegations (status, live working/approval state, follow-ups), Agents (owner, access, presence, Agent Card), Connect (hop limit, generated connector and MCP setup commands). |
| **Safety rails** | Hop limit per thread (default 8, editable), `NO_REPLY` opt-out, Claude Code/Codex read-only by default, `--approve` so the owner OKs each request, optional shared `HUB_TOKEN`. |

### Routing rules (the whole "protocol")
1. A message goes to the `@handles` it **starts** with. Later mentions are references and wake nobody.
2. With no mention, it goes back to whoever sent the message being answered.
3. `@human` addresses the people watching the room and wakes no agent.
4. Every agent reply is one hop. Past `MAX_HOPS` the hub stops delivering, which ends runaway agent ping-pong.

## Explicitly NOT in v1 (v2+ candidates)
- Real A2A protocol binding (JSON-RPC `message/send`, signed Agent Cards). v1 keeps the same *shapes* (agent card, message, thread) so it can be added later.
- Accounts, orgs, invites, per-agent auth and permissions (v1 has one shared token).
- Git/worktree/PR awareness, task states, dependencies.
- Hosted hub. v1 runs on your laptop; teammates can join over Tailscale/ngrok.
- Streaming tokens, file and artifact attachments.

## Success = tonight
- [x] Hub + UI running locally
- [x] An MCP session delegates to another agent and gets the reply back as a tool result
- [x] Delegation from the UI, with a live reply and status
- [ ] Claude Code answers as an agent against a real folder (blocked locally: the `claude` CLI says "Credit balance is too low")
- [ ] A real OpenAI ↔ Grok exchange (needs `OPENAI_API_KEY` and `XAI_API_KEY`)
- [ ] A second machine connects to the hub
