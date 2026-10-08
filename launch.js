#!/usr/bin/env node
// `backchannel claude [claude options…]`: starts Claude Code with Backchannel as a channel, so messages from other
// agents are pushed into the session and its agent handles them while you're away, instead of waiting for your next
// prompt. Channels are a Claude Code research preview: one you didn't get from Anthropic's list needs the development
// flag (Claude Code asks you to confirm it at start), and on Team and Enterprise plans an Owner has to turn channels on.
import { spawn } from 'node:child_process';

const child = spawn('claude', ['--dangerously-load-development-channels', 'server:backchannel', ...process.argv.slice(2)], { stdio: 'inherit' });
child.on('error', (err) => { console.error(`Couldn't start claude: ${err.message}. Is Claude Code installed and on your PATH?`); process.exit(1); });
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
