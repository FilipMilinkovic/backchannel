// Backends turn (system prompt, conversation) into a reply. Each one is a single async function.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeDenySettings } from './safety.js';

// Codex ships inside the ChatGPT app and often isn't on PATH.
export function codexBin() {
  if (process.env.CODEX_BIN) return process.env.CODEX_BIN;
  const bundled = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex';
  const onPath = (process.env.PATH || '').split(path.delimiter).some((d) => fs.existsSync(path.join(d, 'codex')));
  return !onPath && fs.existsSync(bundled) ? bundled : 'codex';
}

async function chatCompletions({ baseUrl, apiKey, model, system, prompt }) {
  if (!apiKey) throw new Error(`missing API key for ${baseUrl}`);
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }] }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status} ${body.error?.message || JSON.stringify(body).slice(0, 300)}`);
  return body.choices?.[0]?.message?.content ?? '';
}

// A stand-in runs inside a Claude Code session's MCP server, which marks its environment as that session's. The
// headless run it starts is a separate session, so it doesn't inherit those markers.
const NESTED = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT'];
export function childEnv() {
  const env = { ...process.env };
  for (const k of NESTED) delete env[k];
  return env;
}

export const turnTimeout = () => Number(process.env.CODER_TIMEOUT_MIN || 15) * 60_000;
export const claudeBin = () => process.env.CLAUDE_BIN || 'claude';

export function run(cmd, args, { cwd, input, timeoutMs = turnTimeout() }) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    const name = path.basename(cmd);
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`${name} timed out`)); }, timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => { clearTimeout(timer); reject(new Error(`could not start ${name}: ${e.message}`)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`${name} exited ${code}: ${(err || out).trim().slice(-500)}`));
    });
    child.stdin.end(input);
  });
}

// Arguments for `claude -p`. Credentials (.env files, keys, ~/.ssh, …) are denied by permission rules in every mode.
// `stream` keeps the process open and takes one turn per line on stdin (session.js); `resume` continues a conversation.
export function claudeArgs({ system, model, write, dirs = [], stream = false, resume }) {
  const args = ['-p', '--output-format', stream ? 'stream-json' : 'text', '--append-system-prompt', system, '--settings', claudeDenySettings()];
  if (stream) args.push('--input-format', 'stream-json', '--verbose');
  if (resume) args.push('--resume', resume);
  for (const d of dirs) args.push('--add-dir', d); // where attached files were saved
  if (write) args.push('--permission-mode', 'acceptEdits', '--allowedTools', 'Read,Glob,Grep,Edit,Write,Bash');
  else args.push('--permission-mode', 'dontAsk', '--allowedTools', 'Read,Glob,Grep');
  if (model) args.push('--model', model);
  return args;
}

// One `codex exec` run. With `resume`, it continues that Codex thread (session.js). Returns the final message and the
// thread id Codex reported, if any.
export async function codexExec({ input, model, cwd, write, resume }) {
  const outFile = path.join(os.tmpdir(), `codex-reply-${process.pid}-${Date.now()}.txt`);
  const args = ['exec', '--json', '--skip-git-repo-check', '--sandbox', write ? 'workspace-write' : 'read-only', '--output-last-message', outFile];
  if (model) args.push('--model', model);
  if (resume) args.push('resume', resume);
  args.push('-');
  try {
    const out = await run(codexBin(), args, { cwd, input });
    return { reply: fs.readFileSync(outFile, 'utf8'), thread: codexThread(out) };
  } finally { fs.rmSync(outFile, { force: true }); }
}

// The thread id in `codex exec --json` output: `thread.started` in current versions, `session_configured` in older ones.
export function codexThread(out) {
  for (const line of String(out).split('\n')) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const id = e?.type === 'thread.started' ? e.thread_id : (e?.msg?.type === 'session_configured' ? e.msg.session_id : null);
    if (typeof id === 'string' && id) return id;
  }
  return null;
}

export const backends = {
  openai: (o) => chatCompletions({
    baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    apiKey: process.env.OPENAI_API_KEY,
    model: o.model || process.env.OPENAI_MODEL || 'gpt-5',
    ...o,
  }),

  grok: (o) => chatCompletions({
    baseUrl: process.env.XAI_BASE_URL || 'https://api.x.ai/v1',
    apiKey: process.env.XAI_API_KEY || process.env.GROK_API_KEY,
    model: o.model || process.env.XAI_MODEL || 'grok-4',
    ...o,
  }),

  // Claude Code in headless mode, working inside the owner's repo.
  'claude-code': async ({ prompt, cwd, ...o }) => run(claudeBin(), claudeArgs(o), { cwd, input: prompt }),

  // Codex CLI non-interactive mode; the final message is written to a file.
  codex: async ({ system, prompt, ...o }) => (await codexExec({ ...o, input: `${system}\n\n---\n\n${prompt}` })).reply,

  // No keys needed. Useful for testing the network itself.
  echo: async ({ latest }) => `Echo: ${latest.text.replace(/@/g, '')}`,
};
