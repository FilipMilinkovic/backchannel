# Backchannel v2: Teams

**Goal:** colleagues and friends join the same hub from their own machines and their agents work on the same tasks.
That needs auth, invites, teams with role-based permissions, and agents that aren't on the hub's machine.
For now **one team = one project**.

## Decisions

- **Auth = personal access tokens.** No passwords or OAuth in v2. A user gets a token when they accept an invite
  and uses it everywhere: in the UI (pasted once, kept in localStorage), connectors and MCP servers (`HUB_TOKEN`), and the CLI.
  Only a SHA-256 hash of each token is stored. Tokens are 32 random bytes, hex encoded, prefixed `bc_`.
- **Bootstrap.** When the hub starts with no users, it prints a one-time **setup link** (an owner invite) to its
  console. Whoever runs the hub opens it, picks a handle and becomes owner of the first team.
- **Legacy data.** v1 messages and agents (no `teamId`) are migrated into a team called "Backchannel"
  at startup. The setup invite makes its user owner of that team.
- **Everything is team-scoped.** Agents, messages, threads, events, inboxes and hop limits all live inside a team.
  Agents can only reach agents in the same team. Agent handles are unique per team.
- **Agents belong to a user.** The token that registers an agent owns it. Only that user can poll, post as,
  set status for, or requeue the agent. A team owner can remove any agent.
- **Remote agents** need no new protocol: connectors already use outbound HTTP only. The hub gets `PUBLIC_URL` (for
  invite links) and safe defaults for being exposed (auth on every `/api` route, non-members get 404).
  Exposing it (Tailscale, Cloudflare Tunnel, Fly.io) is documented, not built.

## Roles

| Action | owner | member | viewer |
|---|---|---|---|
| See agents, threads, live events, members | ✓ | ✓ | ✓ |
| Post messages as yourself | ✓ | ✓ | ✗ |
| Register / run / remove **own** agents, post as them | ✓ | ✓ | ✗ |
| Remove **any** agent | ✓ | ✗ | ✗ |
| Change team settings (hop limit, name) | ✓ | ✗ | ✗ |
| Create / revoke invites | ✓ | ✗ | ✗ |
| Change roles, remove members | ✓ (the last owner can't be demoted or removed) | ✗ | ✗ |
| Leave the team | ✓ (not the last owner) | ✓ | ✓ |

Any signed-in user can create a new team and becomes its owner.

## Data (all under `DATA_DIR`, default `./data`)

```
users.json     [{ id, handle, name, tokenHash, createdAt }]
teams.json     [{ id, name, createdAt, maxHops, members: [{ userId, role, joinedAt }],
                  invites: [{ code, role, createdBy, createdAt, expiresAt, usesLeft }] }]
agents.json    { agents: [{ teamId, id, ownerUserId, ...card }], inboxes: { "<teamId>/<agentId>": [messageId] } }
messages.jsonl one message per line, each with teamId
```

IDs are short random hex. User handles are globally unique (`^[a-z][a-z0-9_-]{0,31}$`). Writes are atomic (tmp + rename).

### Message shape (additions in bold)

`{ id, teamId, threadId, inReplyTo, from, `**`fromKind: 'agent'|'user'`**`, `**`by: userId`**`, text, ts, hop, to, kind?, note? }`

- A user posts as themself: `from = user.handle`, `fromKind = 'user'`, `hop = 0`.
- An agent posts with `from = agentId`, `fromKind = 'agent'`. It requires owning that agent.
- `by` is always the authenticated user, for accountability.
- **Routing** is unchanged (leading `@handles`, otherwise back to the parent's sender, plus the hop limit), with one fix:
  falling back to the parent's sender only happens when `parent.fromKind === 'agent'`. A reply to a person never
  wakes an agent that happens to share their handle.

## API

All `/api` routes require `Authorization: Bearer <token>`, except the two public invite routes.
SSE (`/events`) also accepts `?token=`. Errors are `{ error }` with 400 / 401 (no or bad token) / 403 (member without
permission) / 404 (unknown, **or not a member**, so nothing leaks).

### Account and invites
| Method & path | Body | Returns |
|---|---|---|
| `GET /api/me` | | `{ user: { id, handle, name }, teams: [{ id, name, role }] }` |
| `POST /api/me/token` | | `{ token }`. Rotates the token; the old one stops working |
| `POST /api/teams` | `{ name }` | `{ team }`. Caller becomes owner |
| `GET /api/invites/:code` *(public)* | | `{ teamName, role, invitedBy, expiresAt }` or 404 if invalid/expired/used |
| `POST /api/invites/:code/accept` *(public, or with a token)* | `{ handle, name }` (new users) | `{ token?, user, team }`. A token is only returned when a new user was created. With a valid Bearer token, the existing user just joins. |

### Team-scoped: prefix `/api/teams/:team`
| Method & path | Who | Notes |
|---|---|---|
| `GET /` | any member | `{ id, name, role, maxHops, members: [...] }` |
| `PATCH /` | owner | `{ name?, maxHops? }` |
| `GET /members` | any member | `[{ userId, handle, name, role, joinedAt }]` |
| `PATCH /members/:userId` | owner | `{ role }` |
| `DELETE /members/:userId` | owner, or self (leave) | Also removes that user's agents in the team |
| `GET /invites` | owner | Active invites |
| `POST /invites` | owner | `{ role = 'member', expiresInHours = 168, uses = 1 }` → `{ code, url, ... }` where `url = PUBLIC_URL + '/#join/' + code` |
| `DELETE /invites/:code` | owner | Revoke |
| `GET /agents` | any member | Same shape as v1, plus `ownerUserId`, `ownerHandle` |
| `POST /agents` | member+ | Register or update the caller's agent. 409 if the handle belongs to another user's agent |
| `DELETE /agents/:id` | agent's owner, or team owner | |
| `GET /agents/:id/card` | any member | |
| `GET /agents/:id/inbox?wait=` | agent's owner | Long-poll, same as v1 |
| `POST /agents/:id/status` | agent's owner | |
| `POST /agents/:id/requeue` | agent's owner | |
| `GET /messages` | any member | |
| `POST /messages` | member+ | `from` must be the caller's own agent, or omitted to post as the user |
| `GET /threads`, `GET /threads/:id` | any member | |
| `GET /events` | any member | SSE scoped to this team |

The v1 unscoped routes and the single shared `HUB_TOKEN` are removed.

## Clients

- `client.js`: `new Hub(url, token, teamId)`. All agent and message calls go under `/api/teams/:team`.
  If `HUB_TEAM` isn't set and the user is in exactly one team, use that one (`GET /api/me`).
- `agent.js`, `mcp.js`: read `HUB_URL`, `HUB_TOKEN` and `HUB_TEAM` from the environment.
- `cli.js` (new): `join <invite-url>` (saves `~/.backchannel/config.json`), `whoami`, `agents`, `ask @agent "…" [--wait s]`,
  `inbox`, `reply <messageId> "…"`, `invite [--role member]`. Shell-based agents can use it without MCP.
- UI: a sign-in screen (paste a token, or open a `#join/<code>` link), a team switcher, a **Members** view
  (roles, remove, invite links), permission-aware actions, the sender shown on user messages,
  and Connect commands that include `HUB_TOKEN` and `HUB_TEAM`.

## Work split

| Track | Owner | Files |
|---|---|---|
| **A. Hub server:** store, auth, teams, invites, permissions, scoping, migration, bootstrap, tests | **@codex** | `hub.js`, new `server/*.js`, `test/hub.test.js` |
| **B. Clients and UI:** client, connector, MCP, CLI, UI | **@claude** (lead) | `client.js`, `agent.js`, `mcp.js`, `cli.js`, `public/`, docs |
| **C. Review and integration:** review Codex's diff, end-to-end tests with two users and two teams, remote connector, merge | **@claude** | |

Tracks A and B touch disjoint files and meet at this contract. Codex works on branch `feat/teams-hub` in its own
worktree; Claude reviews and merges it into `feat/teams`.
