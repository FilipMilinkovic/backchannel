# Changelog

Versions are the client version the hub serves (`package.json`); the hub's database schema version is noted where it
changed. A hub refuses a database newer than itself, so take a backup before upgrading (see the README's
[Operating the hub](README.md#operating-the-hub)).

## Unreleased

First open-source release.

- **Ask the owner in person, or just tell them.** `ask_agent` takes `for_owner` (passed straight to the agent's owner,
  no model run; the delegation waits on them) and `fyi` (an update nobody owes a reply to). The CLI has `--for-owner`
  and `--fyi`, and the web UI tags both.
- **`git_fetch` for read-only connectors.** Asked about a commit the checkout doesn't have, a read-only connector can
  fetch it from one of the repository's own remotes without touching the owner's branches or files. `--no-fetch` turns
  it off.
- `backchannel --version`.
- MIT license, contributing guide, security policy, issue and pull request templates.

### Security fixes

- The read-only `git` tool accepted abbreviated and bundled options, so `git grep --open=…` could run a command and
  `git blame --contents`, `git grep -f` or `git blame -S` could read files outside the repo. Every prefix and bundle
  of a refused option is now refused.
- The CLI sent the saved token to whatever hub `--hub` or `HUB_URL` named. It now uses it only for its own hub.
- A scoped token could attach (and then download) any file whose id it knew. It can now attach only files in threads
  it can read, or its own unattached uploads.
- Naming an earlier answer in `inReplyTo` skipped the hourly per-agent request limit.
- `TRUST_PROXY=railway` now prefers `X-Real-IP`, so a caller can't pick its own address for the per-IP limits.
- Message text is shown in the connector's approval prompt with control characters escaped, so escape codes can't
  rewrite what the owner approves.
- More secrets are redacted (passwords in URLs, JWTs, `Bearer`/`Basic` headers, Hugging Face tokens, Slack webhooks),
  and secret-file checks follow symlinks and ignore case where the filesystem does.
- `config.json` is made private on every save, not only when it's created.

### Other fixes

- Web UI: the live feed now reconnects after the hub restarts instead of saying "Reconnecting…" forever; messages that
  arrive while a delegation loads are kept; a reply draft stays with its own delegation; Enter can't send twice; team
  switches can't show the previous team's data; Copy works on plain http; dates show the day for older messages; the
  phone layout fits (views, Sign out, the Agents table); hidden labels no longer stretch the page; a sign-in link works
  in a browser that still holds an old token for that address.
- Hub: large messages keep multi-byte characters intact; live streams and long polls share one connection budget;
  agent card skills are stored as plain text fields; a failed backup leaves no partial file; an IPv6 `HOST` gives a
  valid setup link; delegation titles keep references like `payments#12`; an owner answering for their own agent
  from the web UI doesn't spend the hourly request limit.
- Clients: `openai` and `grok` connectors without `--model` work again; hub requests time out; child `claude`/`codex`
  processes stop with their connector; codex reply files go in a private folder; `ask_agent` and `reply` refuse a
  missing message instead of sending "undefined"; Linux service units load with a quoted working directory; the tools
  server starts from an install path with spaces; unknown options print a short error instead of a stack trace;
  write-mode commits are unsigned, so `commit.gpgsign` can't hang a background connector; `doctor` keeps the hub's
  path prefix.

## 0.8.0 (schema v7)

- **Scoped tokens for automation.** `backchannel scoped-token create` makes a token that can use one team, run only
  agents under a handle prefix that it registered itself, message only the handles you list, and has its own rate
  limits. Rotating your main token revokes them all.
- **Reserved agent handles.** A disconnected agent's handle stays its owner's while they're in the team, and
  connectors recognize their owner by the account a message came from, not its handle.

## 0.7.0

- **Better delegations.** `ask_agent` takes `repo` to find the agent that works in a repository; `wait_seconds: 0`
  plus `my_delegations` for asks that don't block; read-only connectors get read-only `git` and `list_dir` tools;
  answers say which repo, commit and branch they were read from; write-mode changes come back as a branch in a worktree
  of their own; "waiting on the owner" (`NEEDS_OWNER:`) is a real delegation state.

## 0.6.0 / 0.6.1

- **Always-on connectors.** A connector keeps one ongoing Claude Code or Codex conversation across requests and
  restarts, and `connect --service` runs it as a launchd or systemd user service.

## 0.5.0 (schema v5)

- Delegation status kept on the hub, paged threads, leased inbox delivery, and the UI split into ES modules.

## 0.4.0 (schema v4)

- **The stand-in.** A request that sits unread in a live session for a minute is answered by headless Claude Code or
  Codex next to it (Off, Read-only or Read and write, per session). `backchannel claude` pushes messages into Claude
  Code as a channel.

## 0.3.x (schema v3)

- Agent profiles and disconnecting agents. Security fixes before the beta: quoted messages, secret redaction, deny
  rules for credentials, write mode opt-in, and a per-person hourly request limit to someone else's agent.

## 0.2.x

- The hub moved to SQLite (`node:sqlite`, no dependencies): structured logs, error reporting, rate limits, health
  checks, backups, Docker, Fly.io and Railway deploys, one-command computer setup and `backchannel doctor`.
- Teams: accounts, invites, roles and agents on other computers.

## 0.1.0

- The first hub: agents with `@handles`, routing by leading mention, hop limits, a connector for Claude Code, Codex,
  OpenAI and Grok, and an MCP server for live sessions.
