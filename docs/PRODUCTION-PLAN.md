# Backchannel v2.1: production-ready hub

> **Status: in progress** on branch `feat/production`. Claude builds; Codex reviews the plan and the diff.

**Goal:** one person can deploy a hub in a few minutes, send invite links to people on other machines,
and keep it running: data survives restarts and deploys, errors are visible, abuse is bounded.
No new product features. The HTTP API stays the same, so the clients, the UI and the black-box tests keep working.

## Decisions

- **Still zero runtime dependencies.** Node 22.13+ (Docker image uses Node 24). Storage uses the built-in `node:sqlite`.
- **SQLite replaces the JSON files.** One file, `DATA_DIR/backchannel.db`, in WAL mode. Schema is versioned with
  `PRAGMA user_version` and forward-only migrations in `server/db.js`. Messages are no longer all held in memory;
  threads, lists and inboxes are queried.
- **One instance.** SSE clients and long-poll waiters stay in memory, so the hub runs as a single process.
  That's fine for teams of people; scaling out is a later problem (it would need a shared pub/sub). Deploy configs pin one machine.
- **Automatic import.** If the database is empty and `DATA_DIR` has v2 JSON files (or v1 files), they're imported
  in one transaction at startup and renamed to `*.imported`. Nothing is deleted.
- **Login codes and sessions move into the database.** Login codes are stored hashed (60 s, single use).
  Browser sessions get `lastUsedAt` and expire after 30 days of no use.
- **Structured logs.** JSON lines on stdout (`LOG_FORMAT=pretty` for local dev), with levels, a request id per request
  (`x-request-id` in, out and in every 5xx body), an access log line per request, and tokens redacted everywhere (including `?token=`).
- **Error reporting.** Unhandled errors are logged with the stack and request context. If `SENTRY_DSN` is set,
  they're also sent to Sentry over its HTTP envelope API (no SDK). Browser errors from the UI are posted to
  `POST /api/client-errors` (rate-limited, size-capped) and logged the same way.
- **Abuse limits.** In-memory token buckets: per IP for the public routes (invite lookup and accept, login code
  exchange), per user for writes (messages, invites, agent registration), and a cap on open SSE streams and long polls per user.
  `TRUST_PROXY=1` makes the hub read the client IP from `x-forwarded-for` (set it behind Fly, Render, Cloudflare).
- **Security headers** on every response: CSP (the inline UI script is allowed by its SHA-256 hash, computed at startup),
  `x-content-type-options`, `referrer-policy: no-referrer` (so `#join` and `#login` links never leak), `x-frame-options: DENY`,
  HSTS when `PUBLIC_URL` is https.
- **Health and lifecycle.** `GET /healthz` (process up) and `GET /readyz` (database answers). On SIGTERM: stop accepting connections,
  end SSE streams, answer pending long polls with an empty inbox (connectors just reconnect), close the database, exit within 10 s.
- **Config is validated at startup.** Bad env (port, URL, numbers) fails fast with one clear message.
- **Installable clients.** `package.json` gets `bin: { backchannel }` with subcommands (`join`, `open`, `connect`
  (= agent.js), `mcp` (= mcp.js), `hub`, ...). People install with `npm i -g github:FilipMilinkovic/backchannel`
  or run `npx -y github:FilipMilinkovic/backchannel ...`, so nobody needs a clone. The Connect page generates those commands.
- **Deploy targets.** `Dockerfile` (non-root, `/data` volume, healthcheck), `fly.toml` (one machine, a volume, health checks),
  and docs for Docker, Fly and Render/Railway. GitHub Actions runs the tests on Node 22 and 24 and builds the image.

## Module layout

```
hub.js                 entrypoint: config -> db -> http server -> graceful shutdown
server/config.js       env parsing + validation
server/log.js          JSON/pretty logger, redaction, request ids
server/report.js       error reporting (log + optional Sentry envelope), process-level handlers
server/db.js           node:sqlite connection, schema + migrations, JSON import
server/repo.js         queries: users, sessions, login codes, teams, members, invites, agents, messages, inboxes
server/auth.js         tokens, hashing, authenticate (main token or session), roles
server/limits.js       token-bucket rate limiter + concurrent-stream caps
server/realtime.js     SSE clients and long-poll waiters (in memory)
server/http.js         request handling: ids, headers, body parsing, access log, errors, static files, health
server/routes.js       the API routes (same paths and shapes as docs/TEAMS-PLAN.md)
```

## Schema (v1)

```sql
users(id PK, handle UNIQUE, name, token_hash UNIQUE, created_at)
sessions(hash PK, user_id -> users, label, created_at, last_used_at)
login_codes(code_hash PK, user_id -> users, expires_at)
teams(id PK, name, max_hops, created_at)
members(team_id -> teams, user_id -> users, role, joined_at, PK(team_id, user_id))
invites(code PK, team_id -> teams, role, created_by NULL, created_at, expires_at, uses_left)
agents(team_id, id, owner_user_id NULL, card JSON, registered_at, PK(team_id, id))
messages(seq INTEGER PK, id UNIQUE, team_id, thread_id, in_reply_to, from_id, from_kind, by_user, text, title, kind, note,
         hop, to_json, ts)  -- indexes (team_id, seq), (team_id, thread_id, seq)
inbox(team_id, agent_id, message_id, seq, PK(team_id, agent_id, message_id))
```

Agent presence (`lastSeen`, `state`, `stateThread`) stays in memory, as today (it resets on restart anyway).

## Out of scope (next)

Multiple hub instances, email/OAuth sign-in, HttpOnly cookie sessions instead of bearer tokens in localStorage,
message retention policies, an npm registry release (needs Filip), a hosted multi-tenant service.

## Checklist

- [ ] config, log, report, limits, realtime modules
- [ ] SQLite schema, repo, JSON import (v2 and v1)
- [ ] routes ported onto repo; existing black-box tests pass unchanged
- [ ] new tests: import, sessions expiry, rate limits, headers, health, request ids, client errors, shutdown
- [ ] Dockerfile, .dockerignore, fly.toml, CI workflow
- [ ] `backchannel` bin + Connect page commands
- [ ] README: deploy in 5 minutes, operate (logs, backup, upgrade)
- [ ] Codex review of the diff; fixes
