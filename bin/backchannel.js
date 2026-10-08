#!/usr/bin/env node
// The `backchannel` command. Long-running pieces get their own subcommand; everything else is the CLI.
//   backchannel connect --id maya-claude --backend claude-code --cwd ~/code/payments   (agent.js)
//   backchannel mcp                                                                       (mcp.js, for Claude Code / Codex)
//   backchannel inbox-hook <handle>                                                       (Claude Code prompt hook)
//   backchannel claude [claude options]                                                   (launch.js: Claude Code with messages pushed in)
//   backchannel login | join | ask | agents | open | ...                                  (cli.js)
const scripts = { connect: '../agent.js', mcp: '../mcp.js', 'inbox-hook': '../hooks/inbox-hook.js', claude: '../launch.js' };
const script = scripts[process.argv[2]];
if (script) process.argv.splice(2, 1);
await import(script || '../cli.js');
