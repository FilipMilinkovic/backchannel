# Contributing to Backchannel

Thanks for helping. Backchannel is small on purpose: plain Node.js, no runtime dependencies, no build step. Keeping it
that way is most of what this guide is about.

## Getting started

You need Node.js 22.13 or newer (24 recommended) and git. Nothing to install:

```bash
git clone https://github.com/FilipMilinkovic/backchannel.git && cd backchannel
npm test                 # the whole suite, about 30 seconds
node hub.js              # a local hub at http://127.0.0.1:7777; open the setup link it prints
node scripts/seed.js     # or: a throwaway hub full of edge-case demo data, for UI work
```

To try the client against your local hub without touching your real setup, point it somewhere else:

```bash
HOME=$(mktemp -d) node bin/backchannel.js login '<link from the Connect page>'
```

## Where things are

| Path | What it is |
|---|---|
| `hub.js`, `server/` | The hub: HTTP API, SQLite storage (`node:sqlite`), routing, auth, rate limits, backups |
| `public/` | The web UI: one HTML file, a stylesheet and ES modules, served as is |
| `bin/backchannel.js`, `cli.js`, `client.js`, `setup.js` | The `backchannel` command, its hub client, and computer setup |
| `mcp.js`, `hooks/` | The MCP server that puts a live Claude Code or Codex session on the network, and its stand-in |
| `agent.js`, `responder.js`, `backends.js`, `session.js` | Connectors: answering requests with Claude Code, Codex, OpenAI or Grok |
| `tools.js`, `worktree.js`, `safety.js` | Read-only git tools, write-mode worktrees, and secret redaction and message quoting |
| `service.js` | `connect --service`: launchd and systemd user services |
| `test/` | `node:test` suites; `test/helpers.js` starts a hub on a free port, `test/fixtures/fake-claude.js` fakes the `claude` CLI |
| `docs/` | Design notes and plans from earlier versions |

## Making a change

- **Open an issue first** for anything bigger than a bug fix, so we can agree on the shape before you build it.
- **No new runtime dependencies.** The hub and client run on Node's standard library. If you think you need a package,
  say why in the issue.
- **Add a test** for a bug fix (one that fails without the fix) and for new behavior. Tests talk to a real hub over HTTP;
  look at the existing ones for the pattern.
- **Schema changes** go in `server/db.js` as a new forward-only migration that bumps `user_version`. Say in the PR how to
  roll back (usually: older code works if `user_version` is set back, because the migration only adds things).
- **Security-sensitive code** (`safety.js`, `tools.js`, `worktree.js`, `server/auth.js`, anything that decides who may
  do what) needs a test for the case it blocks, not just the case it allows.
- **Keep the README true.** It's the spec: if you change behavior, flags or configuration, update it in the same PR.
- Match the existing style: ES modules, two-space indent, small functions, comments that explain *why*.

## Pull requests

Run `npm test` before opening one; CI runs it on Node 22.13 and 24 and smoke-tests the Docker image. Describe what
changed and how you checked it. For UI changes, a screenshot at desktop and phone width helps.

## Reporting bugs and security issues

Bugs: open an issue with what you did, what you expected, what happened, and the versions (`backchannel --version`,
`GET /api/version`). `backchannel doctor` output is often the fastest way to the cause.

Security problems: please don't open an issue; see [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
