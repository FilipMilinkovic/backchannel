// Where a connector's answer came from, and where its changes go.
//   provenance(): the repos, commits and branches an answer was read from, for a line under the reply.
//   Write requests run in a git worktree of their own, on a branch named after the thread, so the agent never edits
//   the owner's checkout. The owner reviews the branch; nothing is pushed. A follow-up in the thread continues on the
//   same branch, and a request that changed nothing leaves nothing behind.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { describeWorkspace, gitRepo } from './client.js';

const untilde = (p) => (p?.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);
const tilde = (p) => (p === os.homedir() || p.startsWith(os.homedir() + path.sep) ? '~' + p.slice(os.homedir().length) : p);

export function git(dir, args, env = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd: dir, encoding: 'utf8', timeout: 60_000, maxBuffer: 32 * 1_048_576,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', ...env } },
    (err, out, errOut) => (err ? reject(new Error(`git ${args[0]}: ${String(errOut || err.message).trim().slice(0, 500)}`)) : resolve(out.trim())));
  });
}
const gitTop = (dir) => git(dir, ['rev-parse', '--show-toplevel']).catch(() => null);

// "payments@1a2b3c4 on main, with uncommitted changes" for each repo the paths are in (at most four).
export async function provenance(paths, cwd) {
  const tops = new Set();
  for (const p of [...new Set(paths)].slice(0, 100)) {
    let dir = p;
    try { if (!fs.statSync(p).isDirectory()) dir = path.dirname(p); } catch { dir = path.dirname(p); }
    if (!fs.existsSync(dir)) continue;
    const top = await gitTop(dir);
    if (top) tops.add(top);
  }
  if (!tops.size && !paths.length) { const own = await gitTop(cwd); if (own) tops.add(own); } // a one-repo folder
  const parts = [];
  for (const top of [...tops].slice(0, 4)) {
    const [info, sha, dirty] = await Promise.all([gitRepo(top), git(top, ['rev-parse', '--short', 'HEAD']).catch(() => null), git(top, ['status', '--porcelain', '-uno']).catch(() => '')]);
    if (!sha) continue;
    parts.push(`${info?.name || path.basename(top)}@${sha}${info?.branch ? ` on ${info.branch}` : ''}${dirty ? ', with uncommitted changes' : ''}`);
  }
  if (tops.size > 4) parts.push(`${tops.size - 4} more`);
  return parts.length ? `(Read from ${parts.join('; ')}.)` : '';
}

// The repo a write request is about: the one the message names in its `repo` field, the folder's only repo, or the
// one repo the request mentions by name. Otherwise { repos } lists the choices.
export async function targetRepo(cwd, msg) {
  const repos = (await describeWorkspace(cwd)).repos.map((r) => ({ ...r, top: untilde(r.path) }));
  const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
  const pick = (list) => (list.length === 1 ? list[0] : null);
  if (msg.repo) {
    const named = pick(repos.filter((r) => same(r.name, msg.repo) || same(path.basename(r.top), msg.repo)));
    if (named) return named;
  }
  if (repos.length === 1) return repos[0];
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const mentioned = pick(repos.filter((r) => new RegExp(`(^|[^\\w-])${esc(r.name)}($|[^\\w-])`, 'i').test(msg.text)));
  return mentioned || { repos };
}

// Outside ~/.backchannel, which connectors are denied (it holds the sign-in).
export const worktreesDir = (id) => path.join(os.homedir(), '.backchannel-worktrees', id);
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'repo';

// The worktree for this thread in `repo`: made on first use (branch backchannel/<thread>, from the commit the owner's
// checkout is on), reused for follow-ups.
export async function openWorktree({ id, repo, threadId }) {
  const short = threadId.slice(0, 8);
  const dir = path.join(worktreesDir(id), `${slug(repo.name)}-${short}`);
  const metaFile = `${dir}.json`;
  if (fs.existsSync(dir) && fs.existsSync(metaFile)) {
    try { return { ...JSON.parse(fs.readFileSync(metaFile, 'utf8')), created: false }; } catch {}
  }
  const branch = `backchannel/${short}`;
  const head = await git(repo.top, ['rev-parse', 'HEAD']);
  const onBranch = await git(repo.top, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => 'HEAD');
  const exists = await git(repo.top, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).then(() => true, () => false);
  fs.mkdirSync(worktreesDir(id), { recursive: true });
  await git(repo.top, ['worktree', 'prune']).catch(() => {});
  if (exists) await git(repo.top, ['worktree', 'add', dir, branch]);
  else await git(repo.top, ['worktree', 'add', '-b', branch, dir, head]);
  // The branch's starting point: where it left the owner's history.
  const base = exists ? await git(repo.top, ['merge-base', branch, head]) : head;
  const meta = { repo: repo.name, top: repo.top, path: dir, branch, base, baseBranch: onBranch === 'HEAD' ? null : onBranch, threadId };
  fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2));
  return { ...meta, created: true };
}

// After a turn: commits what the agent left uncommitted, and describes the branch. A worktree that ends up with no
// changes is removed again, if this turn made it.
export async function finishWorktree(wt, { message, author, patchDir }) {
  if (await git(wt.path, ['status', '--porcelain'])) {
    await git(wt.path, ['add', '-A']);
    // The owner's git identity if they have one; otherwise the agent signs as itself.
    const named = await git(wt.path, ['config', 'user.email']).then(Boolean, () => false);
    const env = named ? {} : { GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email, GIT_COMMITTER_NAME: author.name, GIT_COMMITTER_EMAIL: author.email };
    // Unsigned: a background connector can't answer a signing prompt (pinentry, a hardware key), and would hang on it.
    await git(wt.path, ['-c', 'commit.gpgsign=false', 'commit', '--no-verify', '-q', '-m', message], env);
  }
  const commits = Number(await git(wt.path, ['rev-list', '--count', `${wt.base}..HEAD`]));
  if (!commits) {
    if (wt.created) await removeWorktree(wt);
    return { changed: false };
  }
  const short = await git(wt.path, ['diff', '--shortstat', `${wt.base}..HEAD`]);
  const files = (await git(wt.path, ['diff', '--name-only', `${wt.base}..HEAD`])).split('\n').filter(Boolean);
  const head = await git(wt.path, ['rev-parse', '--short', 'HEAD']);
  fs.mkdirSync(patchDir, { recursive: true });
  const patchFile = path.join(patchDir, `${slug(wt.repo)}-${wt.branch.split('/').pop()}.patch`);
  fs.writeFileSync(patchFile, await git(wt.path, ['diff', `${wt.base}..HEAD`]) + '\n');
  return { changed: true, commits, files, head, stat: short.trim(), patchFile };
}

export async function removeWorktree(wt) {
  await git(wt.top, ['worktree', 'remove', '--force', wt.path]).catch(() => fs.rmSync(wt.path, { recursive: true, force: true }));
  await git(wt.top, ['branch', '-D', wt.branch]).catch(() => {});
  fs.rmSync(`${wt.path}.json`, { force: true });
}

// The lines under a reply that made changes.
export function changeSummary(wt, done, owner) {
  const names = done.files.slice(0, 8).join(', ') + (done.files.length > 8 ? `, and ${done.files.length - 8} more` : '');
  return `Changes are on branch \`${wt.branch}\` in ${wt.repo} (${done.stat}: ${names}), starting from ${wt.baseBranch || 'the checked-out commit'} at ${wt.base.slice(0, 7)}. `
    + `The diff is attached. Nothing was pushed: ${owner || 'the owner'} reviews and merges it. Worktree: ${tilde(wt.path)}`;
}
