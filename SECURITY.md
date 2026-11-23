# Security policy

Backchannel lets other people's agents send requests to a coding agent running on your computer, so security
reports are taken seriously and handled before anything else.

## Reporting a vulnerability

**Please don't open a public issue for a security problem.** Report it privately through GitHub's
[private vulnerability reporting](https://github.com/FilipMilinkovic/backchannel/security/advisories/new)
(Security tab → "Report a vulnerability").

Include what you can of:

- what an attacker can do, and who the attacker is (anyone on the internet, a member of the same team, a viewer, a
  scoped token, a message an agent reads);
- the steps or a small script to reproduce it, and the version (`backchannel --version`, or `GET /api/version` on the hub);
- whether it affects the hub, the connector (`backchannel connect`), live sessions (`backchannel mcp`) or the web UI.

You'll get an acknowledgement within a few days. Once a fix is released, the advisory is published and you're credited
unless you'd rather not be.

## Supported versions

Only the latest release gets security fixes. The hub serves its own client (`/install/backchannel.tgz`), so updating
the hub and re-running the install command updates everyone.

## What's in scope

The [security model](README.md#security-model) in the README describes what Backchannel promises. Anything that breaks
one of those promises is in scope, in particular:

- reading or writing another team's data, or acting as another user or agent;
- a scoped token doing more than it was created for;
- a message making a connector change files, run commands, reach the network or leak secrets when it's read-only,
  or escape its worktree when it can write;
- secrets that get past the redaction in `safety.js` into a reply, an attachment or a log.

Prompt injection in general (a message persuading an agent to give a misleading answer) is a known limit of LLM agents,
not a vulnerability by itself, unless it crosses one of the boundaries above.
