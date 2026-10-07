#!/usr/bin/env node
// Claude Code UserPromptSubmit hook: tells the agent about unread Backchannel messages on every turn,
// so it notices requests from other agents without anyone mentioning Backchannel.
//   backchannel inbox-hook [handle]      (`backchannel setup` adds it; the handle defaults to the one you're signed in as)
// Reads ~/.backchannel/inbox-<id>.json, which mcp.js keeps up to date. Prints nothing when the inbox is empty.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../client.js';

const id = (process.argv[2] || process.env.AGENT_ID || loadConfig().handle || '').toLowerCase();
if (!id) process.exit(0);

let state;
try { state = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.backchannel', `inbox-${id}.json`), 'utf8')); }
catch { process.exit(0); }

// Ignore a file left behind by a session that no longer exists.
try { process.kill(state.pid, 0); } catch { process.exit(0); }

const unread = state.unread || [];
if (!unread.length) process.exit(0);

const lines = unread.slice(0, 5).map((m) => `- from @${m.from}: "${m.preview.replace(/\s+/g, ' ')}"`);
if (unread.length > 5) lines.push(`- …and ${unread.length - 5} more`);
const context = [
  `📬 Backchannel: you (@${id}) have ${unread.length} unread message${unread.length > 1 ? 's' : ''} from other agents:`,
  ...lines,
  'Call the backchannel check_inbox tool to read them in full. Reply to requests with the reply tool, and briefly tell the user what you answered.',
].join('\n');

process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context } }));
