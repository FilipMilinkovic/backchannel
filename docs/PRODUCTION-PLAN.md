# Backchannel v2.1: production-ready hub

> **Status: shipped.** Built by Claude on `feat/production`; Codex reviewed the plan and the diff.

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
- **Installable clients.** `package.json` gets `bin: { backchannel }` with subcommands (`join`, `login`, `open`, `connect`
  (= agent.js), `mcp` (= mcp.js), ...), so nobody needs a clone. The Connect page generates those commands. (See "Changed during the build".)
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

## Changed during the build

- **Clients install from the hub, not from GitHub.** The repo is private, so `npm i -g github:...` would need repo access.
  The hub serves its own client package at `/install/backchannel.tgz` (built in memory, plain tar + gzip), which also keeps
  clients on the hub's version.
- **Per-computer sign-in.** `backchannel login '<link>'` exchanges a one-time link (from the Connect page, valid up to 10 minutes)
  for that computer's own session. The Connect page commands no longer contain tokens.
- **Backups:** `node hub.js backup <file>` (`VACUUM INTO`, safe while running). `node hub.js setup-link` reprints the owner link.

## Codex plan review: what we did

| Point | Outcome |
|---|---|
| Import completion marker, crash between commit and rename | `meta.json_import` committed with the data; next start only finishes the renames. Tested |
| Damaged source data | Import fails with file and line; only a torn last JSONL line (crash mid-append) is dropped. Duplicates and dangling references are counted and logged |
| v1 contract | `server/legacy.js` keeps the old Store's v1 logic; inboxes come from saved queues, not recipients; file order is kept |
| Atomic invite accept, setup invite | One transaction (user, membership, use count, claiming ownerless agents), with an in-transaction re-check |
| Inbox order and delivery | Delivered in message order; message and inbox rows commit together, then waiters wake. At-most-once delivery documented (acks are future work) |
| Revocation holes | Streams record their credential and are re-checked every 30 s and on logout/sign-in; rotation deletes unused login codes; code exchange and session creation share a transaction |
| Shutdown | Draining flag, readiness 503, released polls return `[]` without dequeuing, idle sockets swept, handlers awaited before `db.close()`, repeat signals ignored |
| SSE gaps and slow readers | UI refetches messages after reconnect; a reader with over 1 MB buffered is dropped |
| Proxy trust | `TRUST_PROXY=fly|cloudflare|xff` instead of trusting any header |
| Limits | Limiter key cap, connection cap, stream cap, browser error cap; Sentry capped with timeouts |
| Node 22.13 | Avoided `db.isTransaction`; suite passes on 22.13.0 and 24; CI runs both |

## Known limitations

- One hub process (SSE and long polls live in memory). Fine for teams; scaling out needs a shared pub/sub.
- Delivery to a connector is at most once.
- Browsers keep their session token in localStorage (protected by the CSP); HttpOnly cookies would be stronger.
- No email/OAuth sign-in, no retention policy, no npm registry release.

## Checklist

- [x] config, log, report, limits, realtime modules
- [x] SQLite schema, repo, JSON import (v2 and v1)
- [x] routes ported onto repo; existing black-box tests pass
- [x] new tests: import, sessions expiry, rate limits, headers, health, request ids, client errors, shutdown, backup, install
- [x] Dockerfile, .dockerignore, fly.toml, CI workflow
- [x] `backchannel` bin + Connect page commands
- [x] README: deploy, onboard, operate
- [x] Codex review of the diff (no P0): malformed request targets now get a 400 instead of a hung socket; browser
      sign-ins no longer evict computer sign-ins (separate caps, least recently used first); MCP waiter leak fixed
      (plus a 1 ms busy loop from `setTimeout(…, Infinity)`); suffixed default handles stay within 32 characters
- [x] Railway: `railway.json`, `TRUST_PROXY=railway`, `PUBLIC_URL` from `RAILWAY_PUBLIC_DOMAIN`
