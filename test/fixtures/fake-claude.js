#!/usr/bin/env node
// Stands in for `claude -p --output-format stream-json` in tests. With --input-format stream-json it's one process
// that takes a turn per line on stdin; otherwise it reads one prompt from stdin. It replies
// "turn <n> pid <pid> resumed <yes|no>", and logs its arguments and every prompt to $FAKE_CLAUDE_LOG.
// Words in the prompt make it act like a real agent:
//   FAIL (error result), CRASH (dies mid-turn), READ <path> (reads a file: a tool_use event), EDIT <path> (writes the
//   file in its working directory), ASKOWNER (ends with a NEEDS_OWNER line). When the prompt says the owner answered,
//   it finishes the original request.
import readline from 'node:readline';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
if (args.includes('--help')) { console.log('Usage: claude [options]\n  --restricted  Restricted mode\n  --strict-mcp-config'); process.exit(0); }
const at = args.indexOf('--resume');
const resumed = at >= 0 ? args[at + 1] : null;
const log = (o) => process.env.FAKE_CLAUDE_LOG && fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ pid: process.pid, cwd: process.cwd(), ...o }) + '\n');
log({ start: true, args });
if (resumed === 'gone') { // what claude 2.1 does: an error result first, then the reason on stderr
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: resumed }) + '\n');
  console.error(`No conversation found with session ID: ${resumed}`);
  process.exit(1);
}
const sid = resumed || crypto.randomUUID();
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
let n = 0;

function turn(prompt) {
  log({ turn: ++n, prompt });
  out({ type: 'system', subtype: 'init', session_id: sid });
  if (prompt.includes('CRASH')) process.exit(3);
  if (prompt.includes('FAIL')) return out({ type: 'result', subtype: 'success', is_error: true, result: 'Credit balance is too low', session_id: sid });
  const tools = [];
  for (const [, file] of prompt.matchAll(/\bREAD (\S+)/g)) tools.push({ type: 'tool_use', name: 'Read', input: { file_path: path.resolve(file) } });
  const extra = [];
  for (const [, file] of prompt.matchAll(/\bEDIT (\S+)/g)) {
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    fs.writeFileSync(path.resolve(file), `edited by fake claude in turn ${n}\n`);
    tools.push({ type: 'tool_use', name: 'Write', input: { file_path: path.resolve(file) } });
    extra.push(`Edited ${file}.`);
  }
  // Like the real model, it may start the answer with the owner's handle; the reply must still reach the asker.
  if (/answered the question you asked them/.test(prompt)) return reply(`@${/@([\w-]+) answered the question/.exec(prompt)?.[1]} thanks.\nFinished it with the owner's answer for @${/finish @([\w-]+)'s original request/.exec(prompt)?.[1]}.`, tools);
  if (prompt.includes('ASKOWNER')) extra.push('I checked the config.\nNEEDS_OWNER: Which environment should I use, QC or prod?');
  reply([`turn ${n} pid ${process.pid} resumed ${resumed ? 'yes' : 'no'}`, ...extra].join('\n'), tools);
}
function reply(text, tools) {
  out({ type: 'assistant', message: { role: 'assistant', content: tools } });
  out({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: sid });
}

if (args.includes('stream-json') && args[args.indexOf('--input-format') + 1] === 'stream-json') {
  readline.createInterface({ input: process.stdin }).on('line', (line) => turn(JSON.parse(line).message.content));
} else {
  let input = '';
  process.stdin.on('data', (d) => { input += d; });
  process.stdin.on('end', () => turn(input));
}
