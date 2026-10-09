#!/usr/bin/env node
// Stands in for `claude -p --input-format stream-json --output-format stream-json` in tests: one process that takes a
// turn per line on stdin. It replies "turn <n> pid <pid> resumed <yes|no>", and logs its arguments and every prompt
// to $FAKE_CLAUDE_LOG. Prompts containing FAIL get an error result; CRASH ends the process mid-turn.
import readline from 'node:readline';
import crypto from 'node:crypto';
import fs from 'node:fs';

const args = process.argv.slice(2);
const at = args.indexOf('--resume');
const resumed = at >= 0 ? args[at + 1] : null;
const log = (o) => process.env.FAKE_CLAUDE_LOG && fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ pid: process.pid, ...o }) + '\n');
log({ start: true, args });
if (resumed === 'gone') { // what claude 2.1 does: an error result first, then the reason on stderr
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: resumed }) + '\n');
  console.error(`No conversation found with session ID: ${resumed}`);
  process.exit(1);
}
const sid = resumed || crypto.randomUUID();
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
let n = 0;
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const prompt = JSON.parse(line).message.content;
  log({ turn: ++n, prompt });
  out({ type: 'system', subtype: 'init', session_id: sid });
  if (prompt.includes('CRASH')) process.exit(3);
  if (prompt.includes('FAIL')) return out({ type: 'result', subtype: 'success', is_error: true, result: 'Credit balance is too low', session_id: sid });
  out({ type: 'assistant', message: { role: 'assistant', content: [] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: `turn ${n} pid ${process.pid} resumed ${resumed ? 'yes' : 'no'}`, session_id: sid });
});
