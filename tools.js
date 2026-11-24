#!/usr/bin/env node
// Read-only tools for a connector's Claude Code (MCP over stdio), so it can look at git history and folders without a
// shell: `git` runs a read-only git command, `list_dir` lists a folder. Everything stays inside BACKCHANNEL_TOOLS_ROOT
// (the agent's folder), git runs without a shell and with every argument checked, and output loses anything that
// looks like a secret. The connector starts it through --mcp-config (backends.js).
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
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
// Options that write files, run programs, read files outside the repo (or ignored ones in it, like .env) or reach the
// network. git takes any unambiguous prefix of a long option (`--open` is --open-files-in-pager), so a prefix of one of
// these is refused too. --text and --ignore-rev are options of their own, not short for --textconv and --ignore-revs-file.
const FORBIDDEN_LONG = ['--output', '--ext-diff', '--textconv', '--exec', '--upload-pack', '--receive-pack', '--open-files-in-pager',
  '--no-index', '--git-dir', '--work-tree', '--namespace', '--config-env', '--run', '--create-reflog', '--contents', '--ignore-revs-file',
  '--untracked', '--no-exclude-standard'];
const OWN_OPTION = new Set(['--text', '--ignore-rev']);
// Options of one subcommand that read a file named by their value: git grep -f <patterns file>, git blame -S <revs file>.
const READS_FILE = { grep: { long: ['--file'], short: 'f' }, blame: { long: [], short: 'S' } };
function readsFile(sub, a) {
  const r = READS_FILE[sub];
  if (!r || a === '--' || !a.startsWith('-')) return false;
  if (!a.startsWith('--')) return a.slice(1).includes(r.short);
  const name = a.split('=')[0];
  return name.length > 2 && r.long.some((f) => f.startsWith(name));
}
function forbidden(a) {
  if (a === '--' || !a.startsWith('-')) return false;
  if (!a.startsWith('--')) return a.slice(1).includes('O'); // -O<cmd> (git grep, git diff), also bundled: -iO<cmd>
  const name = a.split('=')[0];
  return name.length > 2 && !OWN_OPTION.has(name) && FORBIDDEN_LONG.some((f) => f.startsWith(name));
}
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
    if (readsFile(sub, a)) throw new Error(`${a} reads a file; it isn't available here`);
    if (forbidden(a)) throw new Error(`${a} isn't allowed here${/^-[^-]/.test(a) ? ' (pass a short option\'s value as its own argument, e.g. "-S", "text")' : ''}`);
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

// Brings a remote's commits into the repository, so an agent asked about a commit or branch its owner hasn't fetched
// yet can read it. Only remotes the repository already has, only into remote-tracking refs and FETCH_HEAD: the owner's
// branches, index and files are untouched. No submodules, no ext:: transports, no automatic gc. Off with
// BACKCHANNEL_NO_FETCH=1 (backchannel connect --no-fetch).
export function checkFetch({ remote = 'origin', ref } = {}) {
  if (typeof remote !== 'string' || !/^[\w][\w.-]{0,99}$/.test(remote)) throw new Error('remote must be the name of one of the repository\'s remotes, like origin');
  if (ref !== undefined && ref !== null && ref !== '') {
    if (typeof ref !== 'string' || !/^[\w][\w./-]{0,199}$/.test(ref) || ref.includes('..') || ref.endsWith('.lock') || ref.endsWith('/')) {
      throw new Error('ref must be a branch, tag or commit id, like main or 1a2b3c4');
    }
    return { remote, ref };
  }
  return { remote, ref: null };
}

function run(argv, dir, timeout) {
  return new Promise((resolve) => {
    execFile('git', argv, { cwd: dir, encoding: 'utf8', timeout, maxBuffer: 1_048_576,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '', GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || 'ssh -o BatchMode=yes' } },
    (err, out, errOut) => resolve({ ok: !err, text: `${out || ''}${errOut || ''}`.trim(), err }));
  });
}

async function gitFetch(args) {
  const { remote, ref } = checkFetch(args);
  const dir = inside(args.repo);
  const remotes = (await git(['remote'], dir)).split('\n').map((r) => r.trim()).filter(Boolean);
  if (!remotes.includes(remote)) throw new Error(remotes.length ? `there's no remote named ${remote}; this repository has ${remotes.join(', ')}` : 'this repository has no remotes');
  const argv = ['-c', 'protocol.ext.allow=never', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', '-c', 'fetch.recurseSubmodules=false',
    'fetch', '--no-recurse-submodules', '--no-auto-gc', remote, ...(ref ? [ref] : [])];
  const got = await run(argv, dir, 60_000);
  if (!got.ok) return `git fetch ${remote}${ref ? ` ${ref}` : ''} failed: ${(got.text || got.err?.message || '').slice(0, 2000)}`;
  const head = ref ? (await run(['rev-parse', '--verify', '--quiet', 'FETCH_HEAD^{commit}'], dir, 10_000)).text.split('\n')[0] : '';
  return `Fetched ${remote}${ref ? ` ${ref}${head ? ` (now available as ${head.slice(0, 12)}, also FETCH_HEAD)` : ''}` : ''}.${got.text ? `\n${got.text}` : ' Already up to date.'}\nRead it with the git tool, e.g. ["log", "--oneline", "-5", "${ref && !/^[0-9a-f]{7,40}$/.test(ref) ? `${remote}/${ref}` : ref || `${remote}/HEAD`}"].`;
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
  ...(process.env.BACKCHANNEL_NO_FETCH === '1' ? [] : [{
    name: 'git_fetch',
    description: `Fetch new commits from one of a repository's remotes (git fetch), when a commit, branch or PR head you were asked about isn't in the local clone yet. It updates only remote-tracking branches (origin/…) and FETCH_HEAD, never the owner's branches or files.`,
    inputSchema: { type: 'object', properties: {
      remote: { type: 'string', description: 'Remote name (default: origin)' },
      ref: { type: 'string', description: 'Optional branch, tag or commit id to fetch, e.g. "main" or "1a2b3c4d" (default: everything)' },
      repo: { type: 'string', description: 'Folder of the repository, relative to the working directory (default: the working directory)' },
    } },
    run: async (args) => gitFetch(args),
  }]),
  {
    name: 'list_dir',
    description: `List the files and folders in a directory under ${ROOT} (folders end with /).`,
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Relative to the working directory (default: the working directory)' } } },
    run: async ({ path: p }) => listDir(p),
  },
];

// ---------- minimal MCP over stdio ----------
// fileURLToPath, not .pathname: an install path with spaces (My%20Code) or a Windows drive would not be found.
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
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
