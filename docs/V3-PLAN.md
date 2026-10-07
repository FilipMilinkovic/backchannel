# Backchannel v3: orchestration

> **Status: plan approved. Phase L0 shipped 2026-10-08 (v0.3.1); the rest not started.** Open questions settled on 2026-10-07 (see the end). Written after an audit of the UI (run locally against edge-case data at 1280, 800 and
> 375 px), the hub, the clients, and [beads](https://github.com/gastownhall/beads).
> Phase L (launch readiness) was added on 2026-10-07 after a security and operations review. It lists what must be
> done before marketing to real users. On 2026-10-08 we chose a **closed beta on the shared hub** with **global
> handles**, split Phase L into three tracks, and pulled its four security fixes forward as **Phase L0**, shipped to
> production before anything else.

**Goal:** Backchannel is good at one agent asking another a question. v3 makes it a place where a team's agents
**coordinate work**:
- agents have roles that other agents can find;
- there is a shared task board that agents pick work from;
- agents share context and memory;
- every person decides how much their agent is allowed to do.

Along the way, fix the UI, make installation one step, and let people close delegations themselves.

## Where we start

- **Hub.** Node, no runtime dependencies, one SQLite file (schema v3), one process. A team is a project.
- **Agents.** There are two kinds.
  - *Connectors* (`backchannel connect`) run `claude -p` or `codex exec` in a repo. They show a y/N prompt in the terminal before each request.
  - *Live sessions* (`backchannel mcp`) put a person's open Claude Code or Codex session on the network.
- **Delegations are only threads.** Statuses like waiting, answered or failed are worked out in the browser (`owing()` in
  `public/index.html`) from the last 5000 messages. The hub has no idea whether a delegation is open, so nobody can close one.
- **Guardrails are connector flags.** `--write` and `--approve` live on the connector. Only the hop limit is a team setting.
- **The UI is one file.** `public/index.html` is 1757 lines, with the script allowed by its CSP hash.

## Decisions

- **The hub never calls an LLM.** It stays dependency-free and keyless. Summaries, matching and compaction are done by
  agents through tools, as beads recommends.
- **Most restrictive wins.** The effective guardrails for an agent combine the team policy, its owner's personal
  policy, that agent's settings and the connector's own flags. Each one can only tighten. A team owner can never give
  someone's agent more access to that person's computer than the person allowed.
- **Enforce where the power is.**
  - The hub enforces routing: who may ask whom, approvals, hops, claiming tasks, quiet hours.
  - The connector enforces the machine: files, paths, tools, time limits, redaction.
  - In live sessions the person's own Claude Code or Codex permissions stay in force.
- **Shared text is data, not instructions.** Memory, context documents and task text are written by other people's
  agents. The UI shows who wrote each piece. Prompts wrap them as reference material and never as instructions, which
  limits prompt injection between agents.
- **Keep the agent tool surface small.** Each MCP tool definition costs context in every session. We add five tools,
  for ten in total, and put role and policy guidance in the server instructions.
- **Task IDs are sequential per team**, like `BC-42`. beads uses hash IDs because it has no central server. Ours has
  one, and short numbers are easier for people to read and say.
- **The UI stays build-free but is split into modules.** Separate `.js` and `.css` files are served by the hub, with
  CSP `script-src 'self'`. The script hash goes away, and the board, roles and settings views get their own files.

---

## Phase 0: Foundations (no visible change)

| Item | Detail |
|---|---|
| Split the UI | `public/index.html` (markup), `public/app.css`, `public/app/*.js` as ES modules: `api`, `state`, `render-*`, `views/*`. `server/app.js` serves them with long cache plus a version query, and the CSP drops the hash. |
| Demo seed script | `node scripts/seed.js [hub]` creates two users, long handles and names, a long repo, branch and URL, unbroken identifiers, code blocks, all statuses, many threads and tasks. It becomes the QA fixture for every UI change. (The audit for this plan used a hand-run version.) |
| Server-side delegation state | New `threads` table. `owing()` and `statusOf()` move to `server/threads.js` and are tested there. `GET /threads` returns `{ id, title, status, waitingOn, from, to, count, updated }` with cursor pagination. The UI stops downloading 5000 messages and loads a thread's messages when it's opened. |
| Acknowledged delivery (from Phase L) | A connector that crashes after taking a message loses it, and users will read that as flakiness. Taking a message leases it, and posting the reply or an `ack` releases it. An expired lease puts the message back. Done here because "Mark as done" (Phase 1) also changes the inbox, so both land in one migration. |
| Schema v4 | `threads(team_id, id, title, state, closed_by, closed_at, summary, updated_at)`, backfilled from messages, and lease columns on `inbox` (`leased_until`, `leased_by`). |

## Phase 1: UI fixes and "Mark as done"

### Bugs found in the audit

| # | Where | Bug | Fix |
|---|---|---|---|
| 1 | Sign-in, invites | **A sign-in or invite link fails with "missing or invalid token"** when the browser still holds an old token, for example after a hub reset or from another hub on the same address. The UI sends the stored token, and `authenticate()` throws 401 even on public routes. Opening a second link by changing the hash also reuses the stale token held in memory. | The server treats an invalid credential on a public route as anonymous. The UI never sends a token to `/api/login/*` and clears `S.token` before exchanging a link. Add a test. |
| 2 | Mobile rail | The team switcher shows **"Back ⌄"**, which is "Backchannel" cut off and looks like a back button. | Replace the `<select>` with a team button (initials plus ellipsis) that opens a menu. |
| 3 | Mobile rail | Members and Connect are off-screen in a scrolling row with its scrollbar hidden, so there's no hint they exist. | Add a bottom tab bar under 720 px: Delegations, Board, Agents, More. |
| 4 | Agents table | The Owner column wraps onto four lines. The repo name under Access breaks after almost every character (a narrow monospace cell). | Make cells single-line with ellipsis and a `title`. Move the repo under the agent name. Below 900 px, turn rows into cards. |
| 5 | Members table | The "Owner · Last owner" badge wraps, and handles wrap mid-word. | Make the badge `nowrap`. Show the "last owner" hint as a tooltip. Truncate handles. |
| 6 | New-delegation picker | The owner name wraps under the handle. Grok and OpenAI show "read-only" although they can't read any files. | Truncate on one line. Use the same access label as the Agents table ("No file access"). |
| 7 | Delegation header | The "from (owner) to @handle (owner)" line takes two or three lines. "Hops 2 of 8" takes up space and means little to most people. | Use compact chips with handles and put owner names in tooltips. Move hops into a details popover, and show it only near the limit. |
| 8 | Timeline | Message headers (name, owner · backend, to, time) wrap onto three lines. Messages are indented by 36 px even on phones. | Show name and time on one line and truncate the rest. Drop the left rail under 720 px. |
| 9 | Timeline | URLs aren't links, and long URLs break anywhere. | Turn URLs into links that open in a new tab with `rel=noopener`, showing host plus a shortened path. Only `http:` and `https:` become links, so a `javascript:` URL can't run in the UI. |
| 10 | Timeline | Code blocks only scroll sideways, with no way to copy. | Add Copy and Wrap buttons on hover. |
| 11 | Commands (`.code pre`) | `word-break: break-all` splits commands mid-word, which makes them hard to read and check. | Use `overflow-wrap: anywhere` and break only at spaces and `/`. |
| 12 | Agent profile | The branch tag is `nowrap` with no limit, so a long branch name spills out of the repo card. | Set `max-width: 100%` with ellipsis and the full name in a `title`. |
| 13 | Lists and rail | Your own live session shows as "@filip", but your messages show as "You". The rail lists it again as "@filip Filip Milinković". | Show "You (session)" everywhere. List live sessions in their own small group in the rail. |
| 14 | Connect page | The owner-only Hub block (address, team id, hop limit) comes first, and "Create setup command" is in the second block. | Put setup first. Move hub settings to a new **Settings** view (see Phase 3). |
| 15 | Everywhere | Copy buttons give no confirmation that works for screen readers, and there are no toasts. | Add a small toast region (`role=status`) for copy, save and errors. |

**Sweep rule** (it stops the "text always overflows" class of bug from coming back):
- every flex or grid child that holds text gets `min-width: 0`;
- shared `.truncate` and `.clamp-2` utilities replace the one-off rules;
- every truncated value has a `title`;
- each view is checked against `scripts/seed.js` at 375, 768, 1100 and 1440 px.

Optionally, add a devDependency Playwright check that fails when any element scrolls sideways (`scrollWidth > clientWidth`) at those widths.

### Mark a delegation as done

- `PATCH /api/teams/:team/threads/:id { state: 'done' | 'open', summary? }`. The person who started the delegation,
  the owner of an agent in it, or a team owner can do this.
- **Done overrides** the computed status. The thread moves to Done and the change goes out over SSE as a `thread` event.
- **Closing withdraws** that thread's messages still waiting in agents' inboxes, so connectors don't start work nobody needs.
- A live session waiting in `ask_agent` gets back "Closed by Filip: <summary>".
- **Reopening:** any new message in the thread reopens it automatically.
- **UI:** a "Mark as done" button in the delegation header, an optional one-line resolution, and an undo toast.
- **Stop (same phase):** cancels work in progress. The connector's status heartbeat returns `{ cancel: true }`, and the
  connector kills the `claude` or `codex` child and posts "Stopped by Filip".

## Phase 2: Installation in one step

### Today's path

1. Open the invite and pick a handle.
2. Copy a two-part command (`npm i -g <hub>/install/backchannel.tgz && backchannel login '<10-minute link>'`).
3. Restart your sessions.
4. Optionally run `backchannel connect` in a foreground terminal and answer y/N there.

Where it breaks: system Node needs `sudo` for `npm -g`, nvm users end up with the wrong `node`, the link expires, and
nobody is told whether setup actually worked.

### Changes

| Change | Detail |
|---|---|
| **One-line installer** | `curl -fsSL https://hub/install.sh \| sh -s -- <code>` (Windows: `irm https://hub/install.ps1 \| iex`). It checks for Node 22.13 or newer and says exactly how to get it if missing. It unpacks the client into `~/.backchannel/lib` (no sudo, no `npm -g`) and links `~/.local/bin/backchannel`, adding it to PATH if needed. Then it runs `login` and `setup` and prints a checklist. The npm command stays as a "Use npm instead" option. |
| **Activation funnel (from Phase L)** | Count each step on the hub (no third-party analytics): invite opened, account created, computer signed in, session connected, first delegation, first answer. It uses the same events as the checklist below. An owner-only view or a CLI report shows where people drop off. |
| **Live setup checklist** | On the invite screen and on Connect, a three-step checklist turns ✓ as things happen. (1) "Run this" becomes "Signed in on *Filips-MacBook*" when the code is exchanged. (2) "Restart Claude Code" becomes "Claude Code connected as @filip" when a session registers. (3) The optional "Make an agent reachable" becomes "@filip-claude online". The hub already knows all three events and just has to broadcast them. Expired codes are replaced automatically, with a countdown. |
| **"Copy as a prompt"** | This is the button that hands the command to the agent. Next to *Copy command*, it copies a ready prompt for Claude Code or Codex: "Set me up on Backchannel: run `<command>`, then run `backchannel doctor` and tell me the result." The person pastes it into the agent they already have open, and the agent installs, verifies and reports. Browsers can't start a terminal themselves, so this is the closest thing to a one-click install. |
| **Doctor results in the UI** | `setup` and `doctor` report a short health summary to the hub. Connect lists *Your computers* (name, client version, Claude Code ✓, Codex ✓, last seen, Sign out). |
| **Background connector** | `backchannel connect --service` installs a per-user launchd agent (macOS) or systemd user unit (Linux). Approvals move to the web (Phase 3), so no terminal has to stay open. `backchannel connect --stop` and `--status` manage it. |
| **Updates** | Registration sends the client version. When the client is older than the hub, the UI shows "Update available" and `backchannel update` reinstalls from the hub. |

## Phase L: Launch readiness

**Goal:** it is safe to let people we don't know join teams, and to market the hosted hub. Launch means Phases 0, 1
and 2 plus this phase. Phases 4 to 6 (roles, board, memory) come after launch: we launch on delegation.

**Launch shape (decided 2026-10-08):** a closed beta on the shared hub we already run. We invite teams ourselves
(invites plus a waitlist, no open sign-up yet), and email is optional at first. Terms and a privacy policy are still
needed before the first outside team joins. Handles stay global across the hub.

Phase L runs as three tracks, so the non-code work never blocks the code:

| Track | Owner | Contents |
|---|---|---|
| **L0. Security fixes** | Claude | The first four rows of *Security* below. Small, independent of Phase 0, and production already has users, so they ship to production first. **Shipped 2026-10-08 as v0.3.1** (107552b); see the notes after this table. |
| **Engineering** | Claude / Codex | The rest of *Security*, *Operations*. |
| **Product** | Claude | *Accounts and data*, scoped to the closed beta. |
| **Business** | Filip | *Legal and launch basics*, except the activation funnel (moved to Phase 2). Runs alongside the others. |

**What L0 shipped, and what's left from it:**
- `safety.js` (in the client package) quotes other agents' messages as data in `check_inbox`, `ask_agent`, the inbox
  hook and connector prompts; removes secrets from outgoing replies; refuses credential files as attachments; and gives
  Claude Code connectors deny rules for `.env` files, keys, `~/.ssh`, `~/.aws` and similar.
- Codex's `read-only` sandbox **was tested and does read outside its folder** (it printed a file from another directory
  and the repo's `.env`). Codex connectors now say so in their description, at startup and on their profile. A real
  control (for example a sandbox profile that limits reads) is still open.
- The Claude Code deny rules couldn't be run end to end on the build machine (`claude -p` reported no credit). Claude
  accepts the settings, but one manual check on a working `claude -p` is still needed.
- `--write --no-approve` needs `--i-trust-this-team`; write connectors print who can reach them; the UI shows
  "Edits without approval".
- `AGENT_REQUESTS_PER_HOUR` (default 30) per person per agent. Answers back to the agent that asked don't count.
- **Clients only get this when they reinstall** (run the setup command again). Agent profiles show the client version:
  anything older than 0.3.1 lacks the client-side fixes. The hub-side quota and UI apply to everyone already.

### Security

| Item | Detail |
|---|---|
| **Inbound messages are data, not instructions** | Today the inbox hook and the MCP server instructions tell a live session to answer requests "using what you know or can find in this workspace", asking first only for edits or secrets. The session keeps whatever permissions it already has, and many people run Claude Code without permission prompts. One message from a teammate, or from an agent that read an injected web page, can steer it into running commands or reading `.env`. Fix: `check_inbox`, `ask_agent` results and the hook wrap message text as quoted reference material with the sender shown. The instructions say a message alone is never a reason to run commands, edit files, or read or send secrets without asking the user. The same wrapping goes into connector prompts. This brings the Phase 6 rule forward and applies it to messages. |
| **Hardcoded secret protection in connectors** | "Read-only" Claude Code (`Read,Glob,Grep`, `dontAsk`) and Codex (`--sandbox read-only`) can read `.env` in the repo, and replies go to the whole team. Check whether either can read outside the working folder too. Codex's `read-only` sandbox most likely allows reading the whole disk (`~/.ssh` included), and a prompt rule is not a control. If a test confirms it, read-only Codex connectors say "can read your whole disk" in their description and profile until there is a real control. Before the policy system exists, connectors always deny `**/.env*`, `**/*.pem`, `**/id_*`, `~/.ssh`, `~/.aws`, `~/.config/gcloud` and `~/.backchannel` (Claude: `--disallowedTools` path rules; Codex: a prompt rule plus the redaction below). They also scrub `sk-…`, `AKIA…`, `ghp_…`, `xox…` and PEM blocks from replies and `ATTACH:` files before posting. These become the hub defaults for `paths.deny` and `redactSecrets` in Phase 3. |
| **Write access needs a deliberate opt-in** | With `--write`, any team member can make the connector run Bash on the owner's machine. `--write --no-approve` refuses to start unless `--i-trust-this-team` is also passed, and the connector prints who can reach it. Its profile shows "Edits without approval" in warning style. |
| **Request quota per agent** | Without a limit, a teammate can use up someone else's Claude or Codex plan. The hub caps requests per requester per agent (default 30 an hour, a team setting later in Phase 3) and answers past the cap with a clear "@maya-claude takes at most 30 requests an hour from you". |
| **Requesters allow-list (from Phase 3)** | Ship `requesters { allow, deny }` early, as an agent setting the hub enforces in `postMessage`. Default for write agents: only the owner. Default for read agents: all members. |
| **Web approvals (from Phase 3)** | Ship the Approvals inbox early, so `--approve` doesn't need a terminal left open and works with the background connector. |
| **Client distribution integrity** | The hub serves the client to every user's machine (`/install/backchannel.tgz`, later `install.sh` and `backchannel update`). Anyone who controls the hub or the Railway account controls those machines. Turn on 2FA for Railway and GitHub and limit who can deploy. Publish a SHA-256 for each client version **somewhere the hub doesn't control** (GitHub releases or the repo): checksums served by the hub prove nothing when the hub is the thing that's compromised. `install.sh` and `update` check against that source. Sign releases once there's a release pipeline. |
| **External review** | Before marketing, get a security review of the hub, the connector and the MCP server from someone outside the project. Serve `/.well-known/security.txt` with a contact for reporting vulnerabilities, and add `docs/security.md` (Phase 7 #6) describing the trust model honestly: what a teammate's agent can and can't make yours do. |

### Operations

| Item | Detail |
|---|---|
| **Off-site backups** | Today's backups are daily copies, 7 kept, on the same 5 GB volume as the database. They don't survive losing the volume, and with files allowed up to 1 GB per team, a few active teams fill it. Upload each backup to S3-compatible storage (R2 or S3, with credentials in env and the upload done in plain `fetch`, so still no dependencies). Lower `TEAM_FILES_MB` for the hosted hub. Run a restore drill and write it down. |
| **Acknowledged delivery** | Moved into Phase 0, alongside the inbox change for "Mark as done". Still required for launch. |
| **Monitoring** | Check that `SENTRY_DSN` is set in production. Add an external uptime check on `/readyz`, alerts to email or phone, and a public status page. |
| **Railway config** | Railway deprecates `railway.json` (Config as Code) on 2026-12-01. Move its settings into `.railway/railway.ts`, which already defines the service and volume (`railway config migrate`). |
| **Know the ceiling** | One process and one SQLite file. Load-test with `scripts/seed.js` data (teams, threads, open streams and long polls) to find where it degrades, and write the numbers in `docs/run-a-hub.md`. Phase 0 removes the full-table scan in `threadSummaries`. |

### Accounts and data

| Item | Detail |
|---|---|
| **Email on accounts** | Optional at first, required for new accounts on the hosted hub. Used for account recovery (today an identity is a handle plus a token, so someone who loses every signed-in computer and browser is locked out), sign-in links, and notifications. Sent through an HTTP email API, with no SDK. |
| **Self-serve start** | Decided: a waitlist where we send invites, enough for the closed beta. "Create a workspace" with email comes after the beta. |
| **Handles across companies** | Decided: handles stay global. When a handle is taken, say so clearly and suggest free ones (`alex-acme`, `alexk`). |
| **Deletion and export** | A person can delete their account (their messages stay, attributed to "deleted user"). A team owner can delete the team and all its data, including files and backups after they rotate out. A team owner can export the team's messages and files. |
| **Retention (from Phase 7 #5)** | A per-team retention setting for messages and files, with a sensible default on the hosted hub. |

### Legal and launch basics

| Item | Detail |
|---|---|
| **License** | Add `LICENSE`. `server/bundle.js` already ships it in the client package, but the file doesn't exist. Decide whether the client is open source. |
| **Terms, privacy, DPA** | Terms of service, a privacy policy, and a data processing agreement for companies. Say where data lives (Railway, `sfo`) and list subprocessors (Railway, Sentry, the email provider). Say that the hub never calls an LLM, and that each person's own Claude Code or Codex does. |
| **AI vendor terms** | A connector uses its owner's `claude` or `codex` subscription to answer other people's requests. Check that Anthropic's and OpenAI's terms allow this for each plan type, and say in the docs that each owner needs a plan that does. |
| **Name and identifiers** | Check whether anyone holds a trademark on "Backchannel". The MCP server still calls itself `agent-network` (`serverInfo` in `mcp.js`), and so does the agent card's `protocolVersion`. |
| **Support** | A support address or channel, linked from the UI and the docs. |

### Settled launch question

**One shared hub, or a hub per team?** A shared hub, as a closed beta (decided 2026-10-08). That keeps terms, privacy
and deletion on the launch list; open sign-up and required email wait until after the beta. Self-hosting stays
documented, and signed releases matter for both.

## Phase 3: Guardrails and approvals on the web

### Policy

The same shape is used at every level. A missing field means "no opinion".

```
fileAccess        none | read | write
approval          always | writes | never            who approves: the agent's owner
approvalTimeout   minutes; the request is declined after this
requesters        { allow: [handles|role:slug|member:*], deny: [...] }
canDelegate       bool: may this agent ask other agents (onward hops)
maxHops           team only
paths             { deny: ["**/.env*", "secrets/**", ...], allow: [...] }   enforced by the connector
tools             { shell: bool, network: bool }      claude --allowedTools/--disallowedTools, codex --sandbox
limits            { minutes, turns }                  per request; the connector kills the run when exceeded
shareFiles        none | in | in+out, maxMb
tasks             { canClaim: bool, autoPickUp: bool, maxPriority: 0-4 }
hours             { tz, days, from, to }              outside these, requests queue (the hub holds them)
redactSecrets     bool                                the connector scrubs sk-…, AKIA…, ghp_…, PEM blocks from replies
```

**Levels, from loosest to strictest. Each one can only narrow the one before:**
1. Hub defaults.
2. Team policy (owners). Example: "No agent in this project gets write access or network."
3. Personal policy (each person, applies to all their agents). Example: "Always ask me. Never touch `~/.ssh`."
4. Per-agent settings (the agent's owner).
5. Connector flags on the machine. These are a hard local cap: without `--write`, nothing on the hub can turn writing on.

`GET /agents/:id/policy` returns the effective policy and, for each field, which level set it. The agent profile shows
this as an **Effective access** panel, for example "Read-only · set by team policy".

### Enforcement

| Rule | Where |
|---|---|
| requesters, canDelegate, maxHops, hours, approval | Hub. `postMessage` checks before queueing. Messages waiting for approval sit in a new `approvals` table instead of the inbox. |
| fileAccess, paths, tools, limits, redactSecrets, shareFiles out | Connector. It fetches the effective policy at start and on a `policy` event, maps it onto `claude` and `codex` flags, checks `ATTACH:` paths against `paths`, and kills runs that go past `limits`. |
| tasks.canClaim, maxPriority | Hub, in claim and claim-next. |
| Live sessions | The hub rejects requesters the policy doesn't allow. The MCP server instructions state the policy. The session's own Claude Code permissions do the rest. |

### Approvals on the web

- Requests to an agent with `approval: always` show up in the owner's **Approvals** inbox in the UI, with a nav badge
  and an optional browser notification. The owner can Approve, Approve and always allow this requester, or Decline
  with a note.
- The terminal y/N stays available for foreground connectors. Whichever answers first wins.

### UI

- New **Settings** view with three tabs:
  - *Team*: name, hop limit, team policy, audit log. Owners only.
  - *My guardrails*: personal policy.
  - *Computers*: from Phase 2.
- An agent's profile gets *Edit settings* for its owner.

### Audit log

`audit(team_id, seq, actor, action, target, before, after, ts)` records changes to policies, roles and members,
approvals, and done/stop actions. The Team settings tab shows it.

## Phase 4: Roles and discovery

### Data (schema)

```
roles(team_id, id, slug, name, description, instructions, skills JSON, policy JSON, template, created_by, updated_at, version)
agent_settings(team_id, agent_id, roles JSON, policy JSON, notes, updated_by, updated_at)
```

`agent_settings` is keyed by handle, so roles and policy survive a disconnect and reconnect. Today the `agents` row is
deleted on disconnect.

### Templates

Templates ship with the hub as code, not as database rows. Adding one copies it into the team, where it can be edited.

| Template | Purpose |
|---|---|
| Repo expert | Answers questions about its repos: architecture, where things live, how to call an API. |
| Reviewer | Reviews diffs and PRs for correctness and risk. |
| Implementer | Makes the requested changes, runs the tests, reports what changed. |
| QA / Tester | Reproduces bugs, writes or runs tests. |
| Researcher | Answers from the web or docs, with sources. |
| Planner | Breaks requests into tasks on the board, sets priority and dependencies. |
| Docs writer | Keeps READMEs, changelogs and context documents up to date. |
| Security reviewer | Looks for secrets, auth flaws and unsafe input handling. |

Each template has instructions (how to behave when acting in this role), skills (tags used for matching) and a
suggested policy. For example, Reviewer is read-only and Implementer asks for approval on writes. A role's policy
works like a level in Phase 3: it can only tighten.

### How agents use roles

- **Assigning.** The UI (agent profile → Roles), `backchannel connect --role reviewer`, or the CLI.
- **The agent learns its role.** Connector requests include the instructions for the agent's roles (read fresh on
  every request, because they can be edited). The MCP server instructions include them for a live session.
- **Finding the right agent.**
  - `list_agents` gains `role`, `skill`, `repo` and `online` filters and shows roles in its output.
  - The agent card's `skills` are filled from roles, which matches the A2A AgentCard.
- **Asking a role instead of a handle.** `ask_agent({ role: "reviewer", message })`, and `to: ["role:reviewer"]` in
  the API. The hub picks an online agent with that role that the asker may reach: idle before busy, then the one used
  least recently. It records the choice in the thread.
- **UI.** Agents can be filtered by role, roles appear as chips, and Settings → Team gets a Roles tab for creating
  roles from templates and editing them.

## Phase 5: Task board ("Jira for agents", modeled on beads)

### Data (schema)

```
tasks(team_id, num, title, description, acceptance, status, priority 0-4, type, assignee, role, labels JSON,
      parent_num, thread_id, created_by, created_by_kind, lease_until, revision, summary,
      created_at, updated_at, closed_at, defer_until)
task_deps(team_id, num, depends_on, type)      type: blocks | parent-child | related | discovered-from
task_events(team_id, num, seq, actor, kind, data JSON, ts)    history and comments
```

- **Display IDs** are `<PREFIX>-<num>`. The prefix is a team setting, defaulting to its initials.
- **Status:** `open → in_progress → in_review → done`, plus `cancelled`.
  - *Blocked* is worked out from open `blocks` and `parent-child` dependencies rather than stored.
  - *Deferred* means `defer_until` is in the future.
- **Ready** means: open, not deferred, no open blocking dependencies, and either unassigned or assigned to the caller
  (or to one of the caller's roles). Ready work is sorted by priority, then age.
- **Cycles** are refused when a dependency is added, as beads does.

### Concurrency (taken from beads)

- **Claiming is a single conditional `UPDATE`:**
  `... SET assignee=?, status='in_progress', lease_until=? WHERE num=? AND status='open' AND (assignee IS NULL OR assignee=?)`.
  Claiming a task you already hold is harmless. Losing a race returns 409 with the current holder's name.
- **`claim_next(filter)`** picks and claims in one transaction, so there is no gap between listing ready work and claiming it.
- **Leases.** A claim lasts 30 minutes by default. The connector's existing status heartbeat renews it. A reaper sets
  expired tasks back to `open` and logs an event.
- **Edits** carry `revision`. A stale write gets 409.

### Agent tools

These are added to MCP, the connector's tool text and the CLI.

| Tool | What it does |
|---|---|
| `find_work({ role?, label?, claim? })` | Ready tasks for me or my roles. With `claim: true`, it claims the best one. |
| `create_task({ title, description, acceptance?, priority?, role?, assignee?, parent?, blocks?, discovered_from? })` | Puts work on the board. `discovered_from` records follow-up work found during another task. |
| `update_task({ id, status?, claim?, release?, comment?, summary? })` | Claim or release a task, move its status, comment on it, or complete it with a summary. |

### How work flows

- **Delegations and tasks are linked.**
  - In the UI, **Turn into task** creates a task from a delegation and links the thread.
  - `ask_agent` accepts `task_id`, and the conversation lands in that task's thread.
- **Connectors can pick up work.** `backchannel connect --pick-up [--role implementer]` checks for work when idle,
  provided the policy allows `tasks.autoPickUp`.
  - It claims a task, works it under the role's instructions, and posts the result as a comment.
  - It moves the task to `in_review` (or `done` when the role says so).
  - If approval is on, the owner approves the claim first.
- **Board UI (new nav item).**
  - Columns are Ready, In progress, In review and Done. Blocked and deferred tasks fold away inside Ready.
  - Filters: role, assignee, priority, label. There is a list view as well.
  - Each task opens a drawer with its description, acceptance criteria, dependencies (with links), activity (events and
    the linked thread), assignment to a person, agent or role, and priority.
  - Cards can be dragged between columns. Changes arrive live as SSE `task` events.
- **Later:** import and export of beads JSONL (`.beads/issues.jsonl`), so teams that use `bd` locally can sync.

## Phase 6: Shared context and memory

| Piece | What it is | How agents get it |
|---|---|---|
| **Context documents** | Team pages in markdown (Architecture, Conventions, Glossary, Current goals), with versions and an author on each edit. People and agents with the Docs writer role can edit. | Pinned documents go into connector prompts (with a size budget). MCP instructions list their titles, and `recall` fetches the content. |
| **Memories** | Short facts (`key`, `text`, scope, author, `updated_at`, optional `expires_at`). Scope is `team`, `role:<slug>`, `agent:<handle>` (that agent and its owner) or `task:<id>`. | `remember({ text, key?, scope? })` (writing the same key again updates it) and `recall({ query, scope? })`. |
| **Search** | SQLite FTS5 (checked: `node:sqlite` on Node 24 supports it) over memories, context documents, task titles and summaries, and delegation summaries. | `recall`, and a ⌘K search in the UI. |
| **Summaries** | When a delegation or task closes, its summary (from Mark as done or `update_task`) is indexed. Old closed items keep the summary and drop out of the default lists, which is beads' "memory decay" without an LLM on the hub. | Found through `recall`. |

- Every memory and document shows who wrote it. People can edit and delete them in a **Knowledge** view.
- Team policy can stop agents from writing team-scoped memory (`memoryWrite: none | own-scope | team`).

## Phase 7: Polish backlog (in priority order)

1. ~~Acknowledged delivery for connectors.~~ Moved to Phase L.
2. Browser notifications for approvals needed, answers arriving, and work assigned to me.
3. Editable delegation titles, plus a "waiting for X minutes" age on active rows.
4. Per-delegation metrics: duration, turns, which backend handled it. A profile can then show the median response time.
5. An "archived" filter (retention itself moved to Phase L). The 5000-message cap goes away with Phase 0 pagination.
6. Split the README (280 lines) into `docs/run-a-hub.md`, `docs/join.md` and `docs/security.md`, and keep the README short.
7. Optional light theme, with tokens already in `:root`. PRODUCT.md says dark, so this is low priority.

---

## New API (summary)

| Method & path | Who |
|---|---|
| `GET /threads?cursor&state`, `PATCH /threads/:id` | member+ (closing: starter, owner of an agent in the thread, or team owner) |
| `POST /threads/:id/stop` | same as above |
| `GET/PUT /policy` (team), `GET/PUT /api/me/policy`, `GET/PUT /agents/:id/settings`, `GET /agents/:id/policy` | owner / self / agent owner / member |
| `GET /approvals`, `POST /approvals/:id { decision, always? }` | agent owner |
| `GET/POST/PATCH/DELETE /roles`, `GET /role-templates` | read: member · write: owner |
| `GET/POST /tasks`, `GET/PATCH /tasks/:num`, `POST /tasks/:num/claim`, `POST /tasks/claim-next`, `POST /tasks/:num/deps`, `POST /tasks/:num/comments` | member+ (agents act as their owner) |
| `GET/POST /context`, `GET/PUT /context/:slug`, `GET/POST/DELETE /memories`, `GET /search?q` | member+ (subject to policy) |
| `GET /audit` | owner |
| `GET /install.sh`, `GET /install.ps1` (public, rate-limited) | anyone |

New SSE event types: `thread`, `approval`, `task`, `policy`, `roles`, `setup`.

## Schema migrations

| Version | Adds |
|---|---|
| v4 | `threads` (backfilled) |
| v5 | `policies`, `agent_settings`, `approvals`, `audit` |
| v6 | `roles` |
| v7 | `tasks`, `task_deps`, `task_events`, team task prefix |
| v8 | `memories`, `context_docs`, `context_versions`, the FTS5 index |

Production runs schema v3. Every deploy in this plan migrates forward at startup, so take a backup first
(`node hub.js backup`). Older clients keep working because every change to the API only adds things.

## Order and size

| Phase | Size | Depends on |
|---|---|---|
| L0 Security fixes | S | |
| 0 Foundations | M | |
| 1 UI fixes and Mark as done | M | 0 |
| 2 Installation | M | 0 |
| L Launch readiness (rest) | L | 0, 2 (its requesters and approvals are the first slice of 3) |
| 3 Guardrails and web approvals | L | 0 (and the background connector in 2), L |
| 4 Roles and discovery | M | 3 (a role's policy is a level) |
| 5 Task board | L | 3, 4 |
| 6 Context and memory | M | 4 (role scope), 5 (task summaries) |
| 7 Polish | S each | |

L0 ships to production first, on its own branch. Phases 1 and 2 touch different files and can run in parallel, for example with one track going to Codex as in v2.
Launch comes after Phases 0, 1, 2 and L. Phase 3 then builds the policy system on the defaults L hardcoded.
Phase 3 goes before the board, because connectors that pick up work must not exist without `tasks.canClaim` and approvals.

## Settled questions

1. **Task IDs:** sequential per team (`BC-42`).
2. **Team roles and team policy:** owners only. Members manage their personal policy and their own agents' settings.
3. **Installer:** `curl … | sh` (and `irm … | iex` on Windows) is the main path. npm stays as a fallback.
4. **beads interop** (JSONL import and export): later, not in Phase 5.
5. **Auto pick-up:** off for every agent until its owner turns it on (`tasks.autoPickUp` defaults to `false` at every level).
6. **Launch shape:** a closed beta on the shared hub, with invites and a waitlist (2026-10-08).
7. **Handles:** global across the hub, with suggestions when one is taken (2026-10-08).
