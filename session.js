// Persistent sessions for connectors: every request goes into one long conversation with the coding agent, so it keeps
// what it already learned (code it read, earlier threads) instead of starting cold each time.
//   Claude Code: one `claude -p --input-format stream-json` process that stays open and takes one turn per request.
//   Codex: `codex exec` once, then `codex exec resume <thread>` for each request after that.
// The conversation id is saved per agent, so a crash, a reboot or the background service restarting picks it up again.
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeArgs, claudeBin, childEnv, codexExec, turnTimeout, toolPaths } from './backends.js';

export const sessionFile = (id) => path.join(os.homedir(), '.backchannel', 'sessions', `${id}.json`);
const MAX_THREADS = 200, MAX_IDS = 200;

// What's saved between runs: the conversation id, and which messages of each thread it has already been shown, so a
// request in a known thread only carries what's new.
class Saved {
  constructor(file, { backend, cwd, fresh }) {
    this.file = file;
    this.backend = backend;
    this.cwd = cwd;
    let s = {};
    try { s = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
    // A conversation belongs to one backend and folder: Claude Code keeps its conversations per project.
    if (fresh || s.backend !== backend || s.cwd !== cwd) s = {};
    this.conversation = typeof s.conversation === 'string' ? s.conversation : null;
    this.seen = new Map(Object.entries(s.seen || {}).map(([t, ids]) => [t, new Set(ids)]));
  }
  save() {
    const seen = Object.fromEntries([...this.seen].slice(-MAX_THREADS).map(([t, ids]) => [t, [...ids].slice(-MAX_IDS)]));
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(this.file, JSON.stringify({ backend: this.backend, cwd: this.cwd, conversation: this.conversation, seen, updated: Date.now() }, null, 2), { mode: 0o600 });
    } catch {}
  }
  reset() { this.conversation = null; this.seen.clear(); this.save(); }
}

class Session {
  #queue = Promise.resolve();
  // o: { backend, file, cwd, model, write, system: () => string, dirs, fresh, log }
  constructor(o) {
    this.o = { log: () => {}, dirs: [], ...o };
    this.saved = new Saved(o.file, o);
    if (o.fresh) this.saved.save();
  }
  get conversation() { return this.saved.conversation; }
  // Ids of the messages in `threadId` this conversation has already been shown.
  seen(threadId) { return this.saved.seen.get(threadId) || new Set(); }
  remember(threadId, ids) {
    if (!this.saved.conversation) return; // nothing to remember them in
    const set = this.seen(threadId);
    for (const i of ids) if (i) set.add(i);
    this.saved.seen.delete(threadId); // most recent last, so the oldest threads are the ones dropped
    this.saved.seen.set(threadId, set);
    this.saved.save();
  }
  // Runs one turn and resolves to { text, paths }: the reply, and the files and folders its tools touched.
  // `build(seen)` writes the prompt from what the conversation has already been shown; it's called again if the saved
  // conversation can't be resumed and a new one starts. Turns run one at a time.
  ask(threadId, build) {
    const p = this.#queue.then(() => {
      if (!this.saved.conversation) this.saved.seen.clear(); // a new conversation has been shown nothing
      return this.turn(threadId, build);
    });
    this.#queue = p.catch(() => {});
    return p;
  }
  async close() {}
}

// A resumed conversation that no longer exists (deleted, another folder, another machine) fails before the first turn.
const lostConversation = (text) => /no conversation|not found|session|thread|resume/i.test(text);

export class ClaudeSession extends Session {
  #proc = null;
  #turn = null; // { resolve, reject, timer }

  async turn(threadId, build) {
    try {
      return await this.#send(build(this.seen(threadId)));
    } catch (err) {
      if (!err.lost) throw err;
      this.o.log(`  could not resume conversation ${this.saved.conversation}; starting a new one`);
      this.saved.reset();
      return this.#send(build(this.seen(threadId)));
    }
  }

  #start() {
    const resume = this.saved.conversation;
    for (const d of this.o.dirs) fs.mkdirSync(d, { recursive: true });
    const args = claudeArgs({ system: this.o.system(), model: this.o.model, write: this.o.write, dirs: this.o.dirs, stream: true, resume, root: this.o.cwd });
    const child = spawn(claudeBin(), args, { cwd: this.o.cwd, env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    const proc = { child, resume, started: false, err: '' };
    this.#proc = proc;
    child.stdin.on('error', () => {}); // the process died; its exit handler reports it
    child.stderr.on('data', (d) => { proc.err = (proc.err + d).slice(-2000); });
    child.on('error', (e) => this.#ended(proc, new Error(`could not start ${path.basename(claudeBin())}: ${e.message}`)));
    child.on('exit', (code, signal) => this.#ended(proc, new Error(`claude ${signal ? `was stopped (${signal})` : `exited ${code}`}${proc.err.trim() ? `: ${proc.err.trim().slice(-500)}` : ''}`)));
    readline.createInterface({ input: child.stdout }).on('line', (line) => this.#line(proc, line));
  }

  #line(proc, line) {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    if (m.type === 'system' && m.subtype === 'init' && typeof m.session_id === 'string') {
      proc.started = true;
      if (m.session_id !== this.saved.conversation) { this.saved.conversation = m.session_id; this.saved.save(); }
      return;
    }
    if (m.type === 'assistant' && this.#turn) { this.#turn.paths.push(...toolPaths(m.message, this.o.cwd)); return; }
    if (m.type !== 'result') return;
    // A conversation that can't be resumed ends in a result before any init; the exit that follows says why.
    if (proc.resume && !proc.started) return;
    const turn = this.#turn;
    if (!turn) return;
    this.#turn = null;
    clearTimeout(turn.timer);
    // Failed turns still say subtype "success"; is_error is what tells them apart.
    if (m.is_error || m.subtype !== 'success') turn.reject(new Error(String(m.result || m.subtype || 'claude failed').slice(0, 500)));
    else turn.resolve({ text: String(m.result ?? ''), paths: turn.paths });
  }

  #ended(proc, err) {
    if (this.#proc === proc) this.#proc = null;
    const turn = this.#turn;
    if (!turn) return;
    this.#turn = null;
    clearTimeout(turn.timer);
    if (proc.resume && !proc.started && lostConversation(proc.err)) err.lost = true;
    turn.reject(err);
  }

  #send(prompt) {
    if (!this.#proc) this.#start();
    const proc = this.#proc;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#turn = null;
        proc.child.kill('SIGTERM'); // the next turn resumes the conversation in a new process
        reject(new Error('claude timed out'));
      }, turnTimeout());
      this.#turn = { resolve, reject, timer, paths: [] };
      proc.child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } }) + '\n');
    });
  }

  close() {
    const proc = this.#proc;
    if (!proc) return Promise.resolve();
    return new Promise((resolve) => {
      const kill = setTimeout(() => proc.child.kill('SIGTERM'), 3000);
      proc.child.once('exit', () => { clearTimeout(kill); resolve(); });
      proc.child.stdin.end();
    });
  }
}

export class CodexSession extends Session {
  // Codex has no system prompt, so the rules lead every turn, as they do for a one-off run.
  async turn(threadId, build) {
    const exec = (resume) => codexExec({ input: `${this.o.system()}\n\n---\n\n${build(this.seen(threadId))}`,
      model: this.o.model, cwd: this.o.cwd, write: this.o.write, resume });
    const resume = this.saved.conversation;
    let out;
    try {
      out = await exec(resume);
    } catch (err) {
      if (!resume || !lostConversation(err.message)) throw err;
      this.o.log(`  could not resume Codex thread ${resume}; starting a new one`);
      this.saved.reset();
      out = await exec(null);
    }
    if (out.thread && out.thread !== this.saved.conversation) {
      if (this.saved.conversation) this.saved.seen.clear(); // Codex started a new thread instead of continuing
      this.saved.conversation = out.thread;
      this.saved.save();
    }
    return { text: out.reply, paths: [] };
  }
}

export function createSession(backend, o) {
  if (backend === 'claude-code') return new ClaudeSession({ ...o, backend });
  if (backend === 'codex') return new CodexSession({ ...o, backend });
  return null;
}

// How the owner can open the conversation themselves.
export function resumeHint(backend, cwd, conversation) {
  if (!conversation) return null;
  const dir = cwd.replace(os.homedir(), '~');
  return backend === 'codex' ? `cd ${dir} && codex resume ${conversation}` : `cd ${dir} && claude --resume ${conversation}`;
}
