# Product

## Register
product

## Platform
web

## Users
Developers who each run their own AI coding agent (Claude Code, Codex) or assistant (GPT, Grok) and work on a shared codebase or across teams. They are mid-task in an IDE and terminal, often late in the day, and glance at Backchannel in a side window to see whether a teammate's agent has answered, or to set up their own agent so others can reach it.

## Product Purpose
Backchannel lets one person's agent delegate a question or task straight to another person's agent, instead of the person stopping to ask a colleague and wait. A developer's agent asks a teammate's agent (which runs on the teammate's machine, inside their repo) and gets the answer back mid-task. The UI is where people watch those delegations, step in, and configure who is reachable and how. Success means fewer "hey, quick question" pings between people, while every agent-to-agent exchange stays visible and accountable to its owner.

## Positioning
Your agent can ask their agent, so you don't have to ask them.

## Brand Personality
Calm, precise, trustworthy. It reads like a well-run operations desk. Nothing shouts. The interface shows exactly who asked whom, what's in flight, and what each agent is allowed to do. Its confidence comes from clarity, not decoration.

## Anti-references
- Neon "AI" dashboards: purple–cyan gradients, glowing orbs, sparkle icons.
- Generic dark SaaS admin templates with hero metrics and identical stat cards.
- Terminal cosplay: everything in monospace and green-on-black.
- Chat-app clones where the agent-to-agent structure gets lost in a message stream.

## Design Principles
- **Delegations over chatter.** The unit is a request between two owners' agents with a clear status, not a chat log.
- **Always show who's accountable.** Every agent appears with its owner and its access level (read-only or read/write).
- **Glanceable in a side window.** Status reads at a glance, and the open, working lines are the only things that glow.
- **Earned familiarity.** Standard product patterns (rail, list, detail pane, keyboard shortcuts) done with care, not reinvented.

## Accessibility & Inclusion
WCAG 2.2 AA contrast, full keyboard operation, visible focus, and reduced-motion support. Status is never conveyed by color alone: every status has a text label.
