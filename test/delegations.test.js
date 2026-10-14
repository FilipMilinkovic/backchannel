// Better delegations: read-only git tools, answers that say where they came from, write requests on a branch of their
// own, agents that wait on their owner, asking by repository, and asks that don't block the asker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';
import { startHub, tempDir, prefix, delay, ROOT, until, signedIn, connector, ask, gitRepo, FAKE, BIN } from './helpers.js';
import { debtsOf, present } from '../server/threads.js';
import { fromOwner, fromOwnerInPerson } from '../responder.js';

// An MCP server over stdio (mcp.js or tools.js), driven like a client would.
function mcpServer(t, script, { cwd, env }) {
  const child = spawn(process.execPath, [path.join(ROOT, script)], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  const waiting = new Map();
  let next = 1;
  readline.createInterface({ input: child.stdout }).on('line', (line) => { const m = JSON.parse(line); waiting.get(m.id)?.(m); waiting.delete(m.id); });
  const raw = (name, args = {}) => {
    const id = next++;
    const done = new Promise((resolve) => waiting.set(id, resolve));
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\n');
    return done.then((r) => ({ isError: !!r.result.isError, text: r.result.content[0].text }));
  };
  return { raw, async call(name, args) { const r = await raw(name, args); assert.ok(!r.isError, r.text); return r.text; } };
}

test('the read-only tools run git and list folders, and refuse anything that writes or leaks', async (t) => {
  const repo = gitRepo(t, 'payments', { 'src/app.js': 'x\n', '.env': 'STRIPE_SECRET_KEY=sk_live_abcdefghijklmnop1234\n' });
  repo.git('commit', '-q', '--allow-empty', '-m', 'Add refunds with key sk-ant-abcdefghijklmnopqrstuvwxyz123456');
  const tools = mcpServer(t, 'tools.js', { cwd: repo.parent, env: { ...process.env, BACKCHANNEL_TOOLS_ROOT: repo.parent } });

  const log = await tools.call('git', { args: ['log', '--oneline'], repo: 'payments' });
  assert.match(log, /Add refunds with key \[secret removed by Backchannel\]/);
  assert.match(log, /first/);
  assert.match(await tools.call('git', { args: ['branch', '-a'], repo: 'payments' }), /main/);
  assert.match(await tools.call('list_dir', {}), /^\. \(1 entries\)\npayments\/$/);
  assert.match(await tools.call('list_dir', { path: 'payments' }), /\.env\n\.git\/\nsrc\//);
  for (const [args, why] of [[['branch', '-D', 'main'], /listing forms/], [['commit', '-m', 'x'], /isn't available/], [['diff', '--output=/tmp/x'], /isn't allowed/],
    [['show', 'HEAD:.env'], /credentials/], [['diff', '--no-index', '/etc/hosts', 'x'], /isn't allowed/], [['remote', 'add', 'x', 'y'], /only git remote/]]) {
    const r = await tools.raw('git', { args, repo: 'payments' });
    assert.ok(r.isError, args.join(' '));
    assert.match(r.text, why);
  }
  assert.match((await tools.raw('list_dir', { path: '..' })).text, /outside/);
  assert.match((await tools.raw('git', { args: ['log'], repo: '../..' })).text, /outside/);
  assert.equal(repo.git('branch', '--list', 'main'), '* main');
});

test('claude runs with only Backchannel tools: no shell for read-only agents, and none of the owner\'s MCP servers', async () => {
  process.env.CLAUDE_BIN = FAKE;
  const { claudeArgs } = await import(`../backends.js?fresh=${Date.now()}`);
  const read = claudeArgs({ system: 's', write: false, root: '/repo' });
  assert.ok(read.includes('--strict-mcp-config') && read.includes('--restricted'));
  assert.equal(read[read.indexOf('--allowedTools') + 1], 'Read,Glob,Grep,mcp__backchannel-tools__git,mcp__backchannel-tools__list_dir');
  const mcp = JSON.parse(read[read.indexOf('--mcp-config') + 1]).mcpServers['backchannel-tools'];
  assert.deepEqual([mcp.args[0], mcp.env.BACKCHANNEL_TOOLS_ROOT], [path.join(ROOT, 'tools.js'), '/repo']);
  const write = claudeArgs({ system: 's', write: true, root: '/wt' });
  assert.ok(write.includes('--strict-mcp-config') && !write.includes('--restricted'));
  assert.equal(write[write.indexOf('--allowedTools') + 1], 'Read,Glob,Grep,mcp__backchannel-tools__git,mcp__backchannel-tools__list_dir,Edit,Write,Bash');
});

test('answers say which repo, commit and branch they were read from', async (t) => {
  const h = await startHub(t);
  const maya = await h.bootstrap('maya');
  const { env, claudeLog } = signedIn(t, h, maya);
  const repo = gitRepo(t);
  const sha = repo.git('rev-parse', '--short', 'HEAD');
  connector(t, ['--backend', 'claude-code', '--no-approve'], { cwd: repo.dir, env });
  await until(async () => (await h.ok(`${prefix(maya)}/agents`, maya.token)).find((a) => a.id === 'maya-claude' && a.online));
  const reply = await ask(h, maya, 'maya-claude', 'what does READ src/app.js export?');
  assert.match(reply.text, new RegExp(`^turn 1 pid \\d+ resumed no\\n\\n\\(Read from payments@${sha} on main\\.\\)$`));
  fs.writeFileSync(path.join(repo.dir, 'src', 'app.js'), 'changed\n');
  assert.match((await ask(h, maya, 'maya-claude', 'and now READ src/app.js')).text, new RegExp(`payments@${sha} on main, with uncommitted changes`));
  const start = claudeLog().find((e) => e.start).args;
  assert.ok(start.includes('--restricted') && start.includes('--strict-mcp-config'));
  assert.match(start[start.indexOf('--append-system-prompt') + 1], /read-only git commands with the git tool/);
});

test('write requests run in a worktree of their own and come back as a branch; the owner\'s checkout is never touched', async (t) => {
  const h = await startHub(t);
  const maya = await h.bootstrap('maya');
  const steve = await h.join(maya, 'member', 'steve');
  const { home, env, claudeLog } = signedIn(t, h, maya);
  const repo = gitRepo(t);
  connector(t, ['--backend', 'claude-code', '--write', '--no-approve', '--i-trust-this-team'], { cwd: repo.dir, env });
  const agent = await until(async () => (await h.ok(`${prefix(maya)}/agents`, maya.token)).find((a) => a.id === 'maya-claude' && a.online));
  assert.match(agent.description, /makes requested changes on a branch of their own, for maya to review/);

  const first = await ask(h, steve, 'maya-claude', 'Add a refunds module: EDIT src/refunds.js');
  const short = first.threadId.slice(0, 8);
  const wt = path.join(home, '.backchannel-worktrees', 'maya-claude', `payments-${short}`);
  assert.match(first.text, new RegExp(`Edited src/refunds\\.js\\.\\n\\nChanges are on branch \`backchannel/${short}\` in payments \\(1 file changed, 1 insertion\\(\\+\\): src/refunds\\.js\\), starting from main at [0-9a-f]{7}\\. The diff is attached\\. Nothing was pushed: maya reviews and merges it\\.`));
  assert.equal(first.files.length, 1);
  assert.equal(first.files[0].name, `payments-${short}.patch`);
  // The owner's checkout is as it was; the branch has the change, committed with the request as its message.
  assert.ok(!fs.existsSync(path.join(repo.dir, 'src', 'refunds.js')));
  assert.equal(repo.git('status', '--porcelain'), '');
  assert.equal(repo.git('rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  assert.equal(repo.git('log', '-1', '--format=%s', `backchannel/${short}`), 'Add a refunds module: EDIT src/refunds.js');
  assert.match(repo.git('log', '-1', '--format=%b', `backchannel/${short}`), new RegExp(`Requested by @steve in Backchannel thread ${first.threadId}`));
  assert.ok(fs.existsSync(path.join(wt, 'src', 'refunds.js')));
  assert.equal(claudeLog().find((e) => e.turn === 1).cwd, fs.realpathSync(wt));

  // A follow-up continues on the same branch, in the same conversation.
  const second = await ask(h, steve, 'maya-claude', 'Also EDIT src/tests.js', first.threadId);
  assert.match(second.text, /^turn 2 pid/);
  assert.match(second.text, new RegExp(`branch \`backchannel/${short}\` in payments \\(2 files changed`));
  assert.equal(repo.git('rev-list', '--count', `main..backchannel/${short}`), '2');

  // A request that changes nothing leaves no worktree or branch behind.
  const question = await ask(h, steve, 'maya-claude', 'What does the app export?');
  assert.doesNotMatch(question.text, /Changes are on branch/);
  assert.match(question.text, /\(Read from payments@[0-9a-f]{7} on main\.\)$/);
  assert.ok(!fs.existsSync(path.join(home, '.backchannel-worktrees', 'maya-claude', `payments-${question.threadId.slice(0, 8)}`)));
  assert.equal(repo.git('branch', '--list', `backchannel/${question.threadId.slice(0, 8)}`), '');
  const note = await until(() => { const n = JSON.parse(fs.readFileSync(path.join(home, '.backchannel', 'connector-maya-claude.json'), 'utf8')); return n.handled.length === 3 && n; });
  assert.deepEqual(note.handled.map((x) => x.branch || null), [`backchannel/${short}`, `backchannel/${short}`, null]);
});

test('in a folder of several repos, a write request needs to say which repo, by name or with repo', async (t) => {
  const h = await startHub(t);
  const maya = await h.bootstrap('maya');
  const { home, env, claudeLog } = signedIn(t, h, maya);
  const alpha = gitRepo(t, 'alpha');
  const beta = gitRepo(t, 'beta');
  const code = fs.realpathSync(tempDir(t, 'code-'));
  fs.renameSync(alpha.dir, path.join(code, 'alpha'));
  fs.renameSync(beta.dir, path.join(code, 'beta'));
  connector(t, ['--backend', 'claude-code', '--write', '--no-approve', '--i-trust-this-team'], { cwd: code, env });
  await until(async () => (await h.ok(`${prefix(maya)}/agents`, maya.token)).find((a) => a.id === 'maya-claude' && a.online));

  const vague = await ask(h, maya, 'maya-claude', 'please EDIT notes.md');
  assert.doesNotMatch(vague.text, /Changes are on branch/);
  const main = claudeLog().find((e) => e.start).args;
  assert.match(main[main.indexOf('--append-system-prompt') + 1], /must say which repository it's about \(alpha, beta\)/);
  assert.ok(!main.includes('Bash') && main.includes('--restricted'), 'the main conversation stays read-only');

  const named = await ask(h, maya, 'maya-claude', 'in beta, EDIT docs/x.md');
  assert.match(named.text, /branch `backchannel\/\w{8}` in beta/);
  const viaField = await ask(h, maya, 'maya-claude', 'EDIT docs/y.md', undefined, { repo: 'alpha' });
  assert.match(viaField.text, /branch `backchannel\/\w{8}` in alpha/);
  const git = (dir, ...a) => spawnSync('git', a, { cwd: path.join(code, dir), encoding: 'utf8' }).stdout.trim();
  assert.equal(git('alpha', 'status', '--porcelain'), '');
  assert.ok(fs.existsSync(path.join(home, '.backchannel-worktrees', 'maya-claude', `alpha-${viaField.threadId.slice(0, 8)}`, 'docs', 'y.md')));
});

test('an agent that needs its owner waits on them, and the owner\'s answer brings it back to finish, even after a restart', async (t) => {
  const h = await startHub(t);
  const maya = await h.bootstrap('maya');
  const steve = await h.join(maya, 'member', 'steve');
  const { home, env } = signedIn(t, h, maya);
  const repo = gitRepo(t);
  let c = connector(t, ['--backend', 'claude-code', '--no-approve'], { cwd: repo.dir, env });
  await until(async () => (await h.ok(`${prefix(maya)}/agents`, maya.token)).find((a) => a.id === 'maya-claude' && a.online));
  const summary = (id) => h.ok(`${prefix(maya)}/threads/${id}/summary`, maya.token);

  const question = await ask(h, steve, 'maya-claude', 'ASKOWNER: which DB does the deploy use?');
  assert.equal(question.kind, 'needs-owner');
  assert.equal(question.needsOwner, 'Which environment should I use, QC or prod?');
  assert.equal((await h.ok(`${prefix(maya)}/threads/${question.threadId}`, maya.token))[0].id, question.inReplyTo); // answers Steve's request
  assert.match(question.text, /I checked the config\.\n\n\(Read from payments@[0-9a-f]+ on main\.\)\n\n⏳ Waiting on maya for: Which environment should I use, QC or prod\?$/);
  const waiting = await summary(question.threadId);
  assert.equal(waiting.status, 'owner');
  assert.deepEqual(waiting.waitingOn, ['maya-claude']);
  assert.equal(waiting.active, true);
  const note = await until(() => { const n = JSON.parse(fs.readFileSync(path.join(home, '.backchannel', 'connector-maya-claude.json'), 'utf8')); return n.waiting?.length && n; });
  assert.equal(note.handled.at(-1).needsOwner, 'Which environment should I use, QC or prod?');
  assert.equal(note.waiting[0].requestId, question.inReplyTo);

  // The owner's own session hears about it, with what to reply to.
  const session = mcpServer(t, 'mcp.js', { cwd: home, env: { ...env, HUB_URL: h.base, HUB_TOKEN: maya.token, AGENT_ID: 'maya' } });
  const told = await session.call('list_agents', {});
  assert.match(told, /🙋 Your always-on Backchannel agent needs the user/);
  assert.match(told, new RegExp(`@maya-claude, for @steve's request \\(thread ${question.threadId}\\), asks: Which environment should I use, QC or prod\\?\\n  message_id ${question.id}`));

  // Restarted while waiting, it still knows. The owner answers; the agent finishes for Steve.
  await c.stop();
  c = connector(t, ['--backend', 'claude-code', '--no-approve'], { cwd: repo.dir, env });
  await until(async () => (await h.ok(`${prefix(maya)}/agents`, maya.token)).find((a) => a.id === 'maya-claude' && a.online));
  await session.call('reply', { message_id: question.id, text: 'QC.' });
  const p = prefix(maya);
  const done = await until(async () => (await h.ok(`${p}/threads/${question.threadId}`, maya.token)).find((m) => m.from === 'maya-claude' && m.kind !== 'needs-owner'), 15000);
  assert.match(done.text, /^@maya thanks\.\nFinished it with the owner's answer for @steve\./);
  assert.equal(done.inReplyTo, question.inReplyTo); // to Steve's request, not to the owner's answer
  assert.deepEqual(done.to, ['steve'], 'reaches the asker even though it starts with @maya');
  assert.equal((await summary(question.threadId)).status, 'answered');
  // The connector notes it just after posting.
  await until(() => JSON.parse(fs.readFileSync(path.join(home, '.backchannel', 'connector-maya-claude.json'), 'utf8')).waiting.length === 0);
});

test('a question for the owner keeps the delegation open without making the asker owe anything', () => {
  const isAgent = (id) => id.endsWith('-claude');
  const msgs = [
    { id: '1', from: 'steve', fromKind: 'user', to: ['maya-claude'] },
    { id: '2', from: 'maya-claude', fromKind: 'agent', to: ['steve'], inReplyTo: '1', reply: true, kind: 'needs-owner' },
  ];
  assert.deepEqual(debtsOf(msgs, isAgent), [{ debtor: 'maya-claude', creditor: 'steve' }]);
  const row = (list) => ({ id: 't', debts: debtsOf(list, isAgent), lastKind: list.at(-1).kind || null, note: false, updated: 1 });
  assert.equal(present(row(msgs), { isAgent }).status, 'owner');
  const answered = [...msgs, { id: '3', from: 'maya', fromKind: 'user', to: ['maya-claude'], inReplyTo: '2', reply: true },
    { id: '4', from: 'maya-claude', fromKind: 'agent', to: ['steve'], inReplyTo: '1', reply: true }];
  assert.equal(present(row(answered.slice(0, 3)), { isAgent }).status, 'queued');
  assert.equal(present(row(answered), { isAgent }).status, 'answered');
});

test('asking by repo picks the best agent that works in it, and asks can return right away and be followed up on', async (t) => {
  const h = await startHub(t);
  const maya = await h.bootstrap('maya');
  const steve = await h.join(maya, 'member', 'steve');
  const p = prefix(maya);
  const repos = [{ name: 'payments', remote: 'git@github.com:acme/payments.git' }];
  await h.ok(p + '/agents', maya.token, 'POST', { id: 'maya', kind: 'session', backend: 'claude-code', repos });
  await h.ok(p + '/agents', maya.token, 'POST', { id: 'maya-claude', backend: 'claude-code', repos, service: true, persistent: true });
  await h.ok(p + '/agents', maya.token, 'POST', { id: 'maya-docs', backend: 'claude-code', repos: [{ name: 'docs' }] });
  const home = tempDir(t);
  const s = mcpServer(t, 'mcp.js', { cwd: home, env: { ...process.env, HOME: home, HUB_URL: h.base, HUB_TOKEN: steve.token, AGENT_ID: 'steve', HUB_TEAM: '' } });
  await until(async () => (await h.ok(p + '/agents', maya.token)).some((a) => a.id === 'steve' && a.online));

  assert.match(await s.call('list_agents', {}), /@maya-claude [\s\S]*Always on[\s\S]*Repos: payments[\s\S]*call ask_agent with repo instead of agent/);
  const sent = await s.call('ask_agent', { repo: 'payments', message: 'How do partial refunds work?', wait_seconds: 0 });
  assert.match(sent, /^Asked @maya-claude, maya's agent in payments\. Others that work in payments: @maya\.\nSent to @maya-claude \(thread (\w+)\)\. Carry on with your work/);
  const threadId = sent.match(/thread (\w+)\)/)[1];
  const [request] = await h.ok(`${p}/threads/${threadId}`, maya.token);
  assert.deepEqual([request.repo, request.to], ['payments', ['maya-claude']]);
  assert.match(await s.call('my_delegations', {}), new RegExp(`Your asks:\\n- thread ${threadId}: "How do partial refunds work\\?" \\(to @maya-claude\\): waiting on @maya-claude, just now`));

  // By remote name too; and a repo nobody has is a clear answer, not a guess.
  assert.match(await s.call('ask_agent', { repo: 'payments.git', message: 'x', wait_seconds: 0 }), /^Asked @maya-claude/);
  assert.equal(await s.call('ask_agent', { repo: 'billing', message: 'x' }), 'No agent on the network works in billing. Repositories agents work in: docs, payments.');
  assert.match((await s.raw('ask_agent', { message: 'x' })).text, /pass agent .* or repo/);
  assert.equal((await h.api(p + '/messages', steve.token, 'POST', { text: '@maya-claude x', repo: '../etc' })).status, 400);

  // The answer arrives later as an unread message, and the ask shows as answered.
  await h.ok(p + '/messages', maya.token, 'POST', { from: 'maya-claude', inReplyTo: request.id, text: 'Through issueRefund().' });
  assert.match(await until(async () => { const r = await s.call('check_inbox', { thread_id: threadId }); return /issueRefund/.test(r) && r; }), /Through issueRefund\(\)\./);
  assert.match(await s.call('my_delegations', { include_done: true }), new RegExp(`- thread ${threadId}: "How do partial refunds work\\?" \\(to @maya-claude\\): answered`));
});

test('backchannel ask --repo asks whichever agent works in that repository', async (t) => {
  const h = await startHub(t);
  const maya = await h.bootstrap('maya');
  const steve = await h.join(maya, 'member', 'steve');
  await h.ok(prefix(maya) + '/agents', maya.token, 'POST', { id: 'maya-claude', backend: 'claude-code', repos: [{ name: 'payments' }] });
  const { env } = signedIn(t, h, steve);
  const r = spawnSync(process.execPath, [BIN, 'ask', '--repo', 'payments', 'How do refunds work?', '--wait', '1'], { env, encoding: 'utf8' });
  assert.match(r.stderr, /Asking @maya-claude, which works in payments\.\nSent to @maya-claude/);
  const [msg] = (await h.ok(prefix(maya) + '/messages', maya.token)).slice(-1);
  assert.deepEqual([msg.text, msg.repo], ['@maya-claude How do refunds work?', 'payments']);
});

test("a connector knows its owner by the account a message came from, not by the handle it shows", () => {
  const self = { id: 'maya-claude', ownerHandle: 'maya', ownerUserId: 'u-maya' };
  const msg = (from, fromKind, by) => ({ from, fromKind, by });
  // The owner in person, or their live session (which takes their handle).
  assert.equal(fromOwner(self, msg('maya', 'user', 'u-maya')), true);
  assert.equal(fromOwnerInPerson(self, msg('maya', 'user', 'u-maya')), true);
  assert.equal(fromOwnerInPerson(self, msg('maya', 'agent', 'u-maya')), true);
  // Another of the owner's agents answers for them, but isn't the owner in person.
  assert.equal(fromOwner(self, msg('maya-codex', 'agent', 'u-maya')), true);
  assert.equal(fromOwnerInPerson(self, msg('maya-codex', 'agent', 'u-maya')), false);
  // Someone else's agent named like the owner, or a message with no account (older hubs), is not the owner.
  assert.equal(fromOwner(self, msg('maya', 'agent', 'u-mallory')), false);
  assert.equal(fromOwnerInPerson(self, msg('maya', 'agent', 'u-mallory')), false);
  assert.equal(fromOwner(self, msg('maya', 'user', undefined)), false);
  // Its own messages, and an agent that doesn't know its owner's account yet, never count.
  assert.equal(fromOwner(self, msg('maya-claude', 'agent', 'u-maya')), false);
  assert.equal(fromOwner({ ...self, ownerUserId: null }, msg('maya', 'user', 'u-maya')), false);  // Automation on the owner's account (a scoped token) isn't the owner either.
  assert.equal(fromOwner(self, { ...msg('cw-1', 'agent', 'u-maya'), scoped: true }), false);
  assert.equal(fromOwnerInPerson(self, { ...msg('maya', 'user', 'u-maya'), scoped: true }), false);
});

test('a cloud worker runs a live session on a scoped token alone, from env vars, and can only talk to its coordinator', async (t) => {
  const h = await startHub(t);
  const steve = await h.bootstrap('steve');
  const bob = await h.join(steve, 'member', 'bob');
  const p = prefix(steve);
  await h.ok(p + '/agents', steve.token, 'POST', { id: 'steve', kind: 'session' });
  await h.ok(p + '/agents', bob.token, 'POST', { id: 'bob-claude' });
  const { token } = await h.ok('/api/me/scoped-tokens', steve.token, 'POST', { team: steve.team.id, agents: 'cw-', postTo: ['steve'], label: 'av-cloud-worker' });

  // No saved sign-in: everything comes from the environment, as in a container.
  const home = tempDir(t, 'bc-cloud-');
  const env = { ...process.env, HOME: home, HUB_URL: h.base, HUB_TOKEN: token, HUB_TEAM: steve.team.id, AGENT_ID: 'cw-1a2b3c4d',
    BACKCHANNEL_STAND_IN_DELAY_MS: '999999999' };
  const worker = mcpServer(t, 'mcp.js', { cwd: home, env });
  await until(async () => (await h.ok(p + '/agents', steve.token)).find((a) => a.id === 'cw-1a2b3c4d' && a.online));

  const sent = await worker.call('ask_agent', { agent: 'steve', message: 'WORKER-HELLO ENGR-1 @cw-1a2b3c4d', wait_seconds: 0 });
  assert.match(sent, /^Sent to @steve \(thread [a-f0-9]+\)/);
  const hello = (await h.ok(p + '/agents/steve/pending', steve.token)).messages[0];
  assert.deepEqual([hello.from, hello.scoped, hello.text], ['cw-1a2b3c4d', true, '@steve WORKER-HELLO ENGR-1 @cw-1a2b3c4d']);
  const noted = await h.ok(p + '/messages', steve.token, 'POST', { from: 'steve', inReplyTo: hello.id, text: 'noted, report here' });
  assert.match(await worker.call('check_inbox', { wait_seconds: 10 }), /noted, report here/);
  assert.match(await worker.call('reply', { message_id: noted.id, text: 'WORKER-STATE: pr-opened https://example.test/pr/1' }), /^Sent to @steve/);
  assert.match(await worker.call('my_delegations', { include_done: true }), /"WORKER-HELLO ENGR-1 @cw-1a2b3c4d" \(to @steve\): answered/);

  // Anyone else is out of reach.
  const elsewhere = await worker.raw('ask_agent', { agent: 'bob-claude', message: 'hi', wait_seconds: 0 });
  assert.ok(elsewhere.isError);
  assert.match(elsewhere.text, /this token can only message @steve/);
});
