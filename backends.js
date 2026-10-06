// Backends turn (system prompt, conversation) into a reply. Each one is a single async function.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Codex ships inside the ChatGPT app and often isn't on PATH.
function codexBin() {
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

function run(cmd, args, { cwd, input, timeoutMs = 15 * 60_000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
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
  'claude-code': async ({ system, prompt, model, cwd, write }) => {
    const args = ['-p', '--output-format', 'text', '--append-system-prompt', system];
    if (write) args.push('--permission-mode', 'acceptEdits', '--allowedTools', 'Read,Glob,Grep,Edit,Write,Bash');
    else args.push('--permission-mode', 'dontAsk', '--allowedTools', 'Read,Glob,Grep');
    if (model) args.push('--model', model);
    return run('claude', args, { cwd, input: prompt });
  },

  // Codex CLI non-interactive mode; the final message is written to a file.
  codex: async ({ system, prompt, model, cwd, write }) => {
    const outFile = path.join(os.tmpdir(), `codex-reply-${process.pid}-${Date.now()}.txt`);
    const args = ['exec', '--skip-git-repo-check', '--sandbox', write ? 'workspace-write' : 'read-only', '--output-last-message', outFile];
    if (model) args.push('--model', model);
    args.push('-');
    await run(codexBin(), args, { cwd, input: `${system}\n\n---\n\n${prompt}` });
    try { return fs.readFileSync(outFile, 'utf8'); } finally { fs.rmSync(outFile, { force: true }); }
  },

  // No keys needed. Useful for testing the network itself.
  echo: async ({ latest }) => `Echo: ${latest.text.replace(/@/g, '')}`,
};
