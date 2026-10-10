#!/usr/bin/env node
// Read-only tools for a connector's Claude Code (MCP over stdio), so it can look at git history and folders without a
// shell: `git` runs a read-only git command, `list_dir` lists a folder. Everything stays inside BACKCHANNEL_TOOLS_ROOT
// (the agent's folder), git runs without a shell and with every argument checked, and output loses anything that
// looks like a secret. The connector starts it through --mcp-config (backends.js).
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { redactSecrets, isSecretPath } from './safety.js';

const ROOT = fs.realpathSync(process.env.BACKCHANNEL_TOOLS_ROOT || process.cwd());
const MAX_OUT = 60_000;

// A folder inside ROOT, or an error.
function inside(rel = '.') {
  const want = path.resolve(ROOT, String(rel));
  let real;
  try { real = fs.realpathSync(want); } catch { throw new Error(`${rel} doesn't exist`); }
  if (real !== ROOT && !real.startsWith(ROOT + path.sep)) throw new Error(`${rel} is outside ${ROOT}`);
  return real;
}

// Subcommands that only read. Some only in their listing forms (checked below).
const READ = new Set(['log', 'show', 'diff', 'status', 'blame', 'rev-parse', 'ls-files', 'ls-tree', 'grep', 'describe',
  'shortlog', 'merge-base', 'name-rev', 'rev-list', 'branch', 'tag', 'remote', 'worktree']);
// Options that write files, run programs, read outside the repo or reach the network.
const FORBIDDEN = /^(?:--output\b|--ext-diff|--textconv|--exec\b|--upload-pack|--receive-pack|--open-files-in-pager|-O|--no-index|--git-dir|--work-tree|--namespace|--config-env|--run\b|--create-reflog)/;
// git branch and git tag only in their listing forms: flags from these sets, and names or commits only after a flag
// that takes them (a bare name would create a branch or tag).
const LISTING = {
  branch: new Set(['-a', '--all', '-r', '--remotes', '-v', '-vv', '--verbose', '--list', '-l', '--show-current', '--contains', '--no-contains', '--merged', '--no-merged', '--points-at', '--sort', '--format', '--column', '--no-column']),
  tag: new Set(['-l', '--list', '-n', '--contains', '--no-contains', '--merged', '--no-merged', '--points-at', '--sort', '--format', '--column', '--no-column']),
};
const TAKES_NAMES = new Set(['--list', '-l', '--contains', '--no-contains', '--merged', '--no-merged', '--points-at']);
function listingOnly(sub, rest) {
  let names = false;
  for (const a of rest) {
    if (!a.startsWith('-')) { if (!names) return false; continue; }
    const flag = a.split('=')[0];
    if (!LISTING[sub].has(flag) && !(sub === 'tag' && /^-n\d+$/.test(a))) return false;
    if (TAKES_NAMES.has(flag)) names = true;
  }
  return true;
}
// Secret files by name, also inside revision specs like HEAD:path/.env.
const secretArg = (a) => String(a).split(/[:=]/).some((part) => part && isSecretPath(path.resolve(ROOT, part)));

export function checkGit(args) {
  if (!Array.isArray(args) || !args.length || args.some((a) => typeof a !== 'string')) throw new Error('args must be a non-empty list of strings, e.g. ["log", "--oneline", "-20"]');
  const [sub, ...rest] = args;
  if (!READ.has(sub)) throw new Error(`git ${sub} isn't available; read-only subcommands: ${[...READ].join(', ')}`);
  for (const a of rest) {
    if (FORBIDDEN.test(a)) throw new Error(`${a} isn't allowed here`);
    if (secretArg(a)) throw new Error(`${a} looks like a file that holds credentials`);
  }
  if ((sub === 'branch' || sub === 'tag') && !listingOnly(sub, rest)) {
    throw new Error(`only listing forms of git ${sub} are available (e.g. git ${sub} ${sub === 'branch' ? '-a' : '--list'})`);
  }
  if (sub === 'remote' && !(rest.length === 0 || (rest.length === 1 && rest[0] === '-v') || (rest[0] === 'get-url' && rest.length === 2))) {
    throw new Error('only git remote, git remote -v and git remote get-url <name> are available');
  }
  if (sub === 'worktree' && rest[0] !== 'list') throw new Error('only git worktree list is available');
  return args;
}

function git(args, dir) {
  const argv = ['--no-pager', '-c', 'core.pager=cat', '-c', 'core.fsmonitor=false', '-c', 'diff.external=', '-c', 'color.ui=false', ...checkGit(args)];
  return new Promise((resolve) => {
    execFile('git', argv, { cwd: dir, encoding: 'utf8', timeout: 20_000, maxBuffer: 8 * 1_048_576,
      env: { ...process.env, GIT_PAGER: 'cat', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_EXTERNAL_DIFF: '' } },
    (err, out, errOut) => resolve(err && !out ? `git exited ${err.code ?? ''}: ${String(errOut || err.message).trim().slice(0, 2000)}` : out || '(no output)'));
  });
}

function listDir(rel) {
  const dir = inside(rel);
  const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  const lines = entries.slice(0, 500).map((e) => `${e.name}${e.isDirectory() ? '/' : e.isSymbolicLink() ? '@' : ''}`);
  if (entries.length > 500) lines.push(`… and ${entries.length - 500} more`);
  return `${path.relative(ROOT, dir) || '.'} (${entries.length} entries)\n${lines.join('\n')}`;
}

const clip = (s) => (s.length > MAX_OUT ? `${s.slice(0, MAX_OUT)}\n… (cut at ${MAX_OUT} characters; narrow the command)` : s);

export const TOOLS = [
  {
    name: 'git',
    description: `Run a read-only git command in a repository under ${ROOT}: log, show, diff, status, blame, grep, branch -a, tag --list, rev-parse and similar. Use it to see history, branches, what changed and which commit you're reading. Commands that change anything aren't available.`,
    inputSchema: { type: 'object', properties: {
      args: { type: 'array', items: { type: 'string' }, description: 'git arguments without "git", e.g. ["log", "--oneline", "-20", "--", "src/"]' },
      repo: { type: 'string', description: 'Folder of the repository, relative to the working directory (default: the working directory)' },
    }, required: ['args'] },
    run: async ({ args, repo }) => git(args, inside(repo)),
  },
  {
    name: 'list_dir',
    description: `List the files and folders in a directory under ${ROOT} (folders end with /).`,
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Relative to the working directory (default: the working directory)' } } },
    run: async ({ path: p }) => listDir(p),
  },
];

// ---------- minimal MCP over stdio ----------
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url).pathname)) {
  const write = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
  readline.createInterface({ input: process.stdin }).on('line', async (line) => {
    let req;
    try { req = JSON.parse(line); } catch { return; }
    const { id, method, params = {} } = req;
    if (id === undefined) return;
    if (method === 'initialize') return write({ id, result: { protocolVersion: params.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'backchannel-tools', version: '1.0.0' } } });
    if (method === 'ping') return write({ id, result: {} });
    if (method === 'tools/list') return write({ id, result: { tools: TOOLS.map(({ run, ...t }) => t) } });
    if (method === 'tools/call') {
      const tool = TOOLS.find((t) => t.name === params.name);
      if (!tool) return write({ id, error: { code: -32602, message: `unknown tool ${params.name}` } });
      try {
        return write({ id, result: { content: [{ type: 'text', text: clip(redactSecrets(await tool.run(params.arguments || {})).text) }] } });
      } catch (err) {
        return write({ id, result: { content: [{ type: 'text', text: err.message }], isError: true } });
      }
    }
    write({ id, error: { code: -32601, message: `method not found: ${method}` } });
  });
}
