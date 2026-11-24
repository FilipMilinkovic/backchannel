#!/usr/bin/env node
// Demo data for checking the UI: long handles, names, repos, branches and URLs, unbroken identifiers, code blocks,
// files, every delegation status, a long thread and enough threads to page. For development only.
//   node scripts/seed.js                       starts a throwaway hub (temporary folder) and fills it
//   node scripts/seed.js --port 7790           …on a chosen port
//   node scripts/seed.js --hub URL --invite X  fills an existing, unclaimed hub (X: its setup link or code)
// Prints a sign-in link for the owner and keeps a few agents online until Ctrl-C.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values: opt } = parseArgs({ options: { hub: { type: 'string' }, invite: { type: 'string' }, port: { type: 'string', default: '7790' } } });

async function startHub() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backchannel-seed-'));
  const child = spawn(process.execPath, ['hub.js'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DATA_DIR: dir, PORT: opt.port, HOST: '127.0.0.1', PUBLIC_URL: '', BACKUP_HOURS: '0', LOG_FORMAT: 'json', LOG_LEVEL: 'info',
      AGENT_REQUESTS_PER_HOUR: '0', RATE_WRITES_PER_MIN: '100000' } });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const stop = () => { child.kill(); fs.rmSync(dir, { recursive: true, force: true }); };
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { stop(); process.exit(0); });
  process.on('exit', stop);
  for (let i = 0; i < 100 && !/#join\/[a-f0-9]+/.test(out); i++) await new Promise((r) => setTimeout(r, 50));
  const code = out.match(/#join\/([a-f0-9]+)/)?.[1];
  if (!code) throw new Error(`the hub didn't start:\n${out}`);
  return { url: `http://127.0.0.1:${opt.port}`, code };
}

const { url: HUB, code: SETUP } = opt.hub
  ? { url: opt.hub.replace(/\/$/, ''), code: (opt.invite || '').match(/([a-f0-9]{24})/)?.[1] }
  : await startHub();
if (!SETUP) { console.error('With --hub, pass --invite with the hub\'s setup link or code.'); process.exit(1); }

async function api(token, method, p, body) {
  const res = await fetch(HUB + p, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${p}: ${res.status} ${data.error || ''}`);
  return data;
}

// People
const owner = await api(null, 'POST', `/api/invites/${SETUP}/accept`, { handle: 'sam', name: 'Sam Rivera' });
const T = `/api/teams/${owner.team.id}`;
const join = async (role, handle, name) => {
  const { code } = await api(owner.token, 'POST', `${T}/invites`, { role });
  return (await api(null, 'POST', `/api/invites/${code}/accept`, { handle, name })).token;
};
const maya = await join('member', 'maya-alexandra-chen-rodriguez', 'Maya Alexandra Chen-Rodríguez de la Vega');
await join('viewer', 'jordan', 'Jordan');
await api(owner.token, 'PATCH', T, { name: 'Payments platform and checkout revamp (Q4 2026)' });

// Agents
const LONG_REPO = 'payments-service-with-an-extremely-long-repository-name-v2';
const agent = (token, card) => api(token, 'POST', `${T}/agents`, card);
await agent(maya, { id: 'maya-alexandra-chen-rodriguez-c', name: 'maya-alexandra-chen-rodriguez-c', backend: 'claude-code', access: 'read', approve: true,
  owner: 'Maya Alexandra Chen-Rodríguez de la Vega', description: `Maya Alexandra Chen-Rodríguez de la Vega's claude-code agent with read-only access to 14 repos in super-long-monorepo-folder-name-that-keeps-going-and-going-forever.`,
  workdir: '~/code/really/deeply/nested/folder/structure/that/keeps/going', host: 'Mayas-MacBook-Pro-16-inch-2024-M4-Max', platform: 'darwin', client: '0.5.0',
  repos: [{ name: LONG_REPO, path: `~/code/really/deeply/nested/folder/structure/${LONG_REPO}`, remote: `git@github.com:some-org-with-a-long-name/${LONG_REPO}.git`,
    branch: 'feature/JIRA-12345-implement-partial-refunds-for-multi-currency-orders-with-rounding' },
  { name: 'checkout-web', path: '~/code/checkout-web', remote: 'https://github.com/acme/checkout-web.git', branch: 'main' }] });
await agent(owner.token, { id: 'sam-codex', backend: 'codex', access: 'read', approve: true, owner: 'Sam Rivera',
  description: "Sam Rivera's codex agent with read-only access to the ledger repo. Codex can also read files elsewhere on its computer.",
  workdir: '~/code/ledger', host: 'sam-mbp', platform: 'darwin', client: '0.4.0', repos: [{ name: 'ledger', path: '~/code/ledger', remote: 'git@github.com:acme/ledger.git', branch: 'main' }] });
await agent(owner.token, { id: 'sam-claude', backend: 'claude-code', access: 'write', approve: false, owner: 'Sam Rivera',
  description: "Sam Rivera's claude-code agent with read/write access to the infra repo.", workdir: '~/code/infra', host: 'sam-mbp', platform: 'darwin', client: '0.5.0',
  repos: [{ name: 'infra', path: '~/code/infra', remote: 'https://github.com/acme/infra.git', branch: 'main' }] });
await agent(maya, { id: 'grok-research', backend: 'grok', model: 'grok-4', owner: 'Maya Alexandra Chen-Rodríguez de la Vega', description: "Maya's Grok assistant." });
await agent(owner.token, { id: 'sam', kind: 'session', backend: 'claude-code', owner: 'Sam Rivera', description: "Sam Rivera's live coding session." });
await agent(maya, { id: 'maya-alexandra-chen-rodriguez', kind: 'session', backend: 'claude-code', owner: 'Maya Alexandra Chen-Rodríguez de la Vega', description: "Maya's live coding session." });
const MAYA_AGENT = 'maya-alexandra-chen-rodriguez-c';

// Delegations
const say = (token, body) => api(token, 'POST', `${T}/messages`, body);

// Answered, with a long URL, an unbroken identifier, inline code and a code block.
const q1 = await say(owner.token, { from: 'sam', text: `@${MAYA_AGENT} Can you explain how partial refunds work across multi-currency orders, specifically RefundCalculator.computeProratedAmountForLineItemsWithDiscountsApplied, and whether it's safe to call concurrently? https://github.com/some-org-with-a-long-name/${LONG_REPO}/blob/main/src/refunds/RefundCalculator.ts#L120-L245` });
await say(maya, { from: MAYA_AGENT, inReplyTo: q1.id, text: `It prorates per line item, then rounds with **banker's rounding** at 4 decimals. aVeryLongUnbrokenIdentifierThatGoesOnAndOnWithoutAnySpacesWhatsoeverToTestOverflow_abcdefghijklmnopqrstuvwxyz0123456789\n\nIt's safe concurrently: \`computeProrated\` is pure.\n\n\`\`\`ts\nconst refund = computeProratedAmountForLineItemsWithDiscountsApplied(order.lineItems.filter((li) => li.refundable && li.currency === order.settlementCurrency), discounts, { rounding: 'bankers', precision: 4 });\n\`\`\`` });

// Waiting (queued), several of them, one with two recipients.
await say(owner.token, { text: `@${MAYA_AGENT} Supercalifragilisticexpialidocious_refactor_of_the_entire_authentication_layer_including_oauth_saml_and_magic_links, what's the plan?` });
await say(owner.token, { text: `@${MAYA_AGENT} @grok-research Compare our retry policy with Stripe's recommended exponential backoff and tell me what we should change.` });

// Working and waiting for approval: live states, set below.
const working = await say(maya, { from: 'maya-alexandra-chen-rodriguez', text: '@sam-codex Where does the ledger reconcile settlement batches, and how often does it run?' });
const approval = await say(owner.token, { text: `@${MAYA_AGENT} Please bump the payments SDK to 4.2 and run the integration tests.` });

// Failed and declined.
const e1 = await say(owner.token, { text: '@grok-research Summarize the last incident review.' });
await say(maya, { from: 'grok-research', inReplyTo: e1.id, kind: 'error', text: 'grok error: 429 Rate limit exceeded for model grok-4. Please retry after 20s.' });
const d1 = await say(maya, { from: 'maya-alexandra-chen-rodriguez', text: '@sam-claude Delete the staging database and recreate it from the latest snapshot.' });
await say(owner.token, { from: 'sam-claude', inReplyTo: d1.id, kind: 'declined', text: 'Sam Rivera declined this request.' });

// For the owner in person (passed on, waiting on them), and an FYI nobody answers.
const fo = await say(owner.token, { from: 'sam', kind: 'for-owner', text: `@${MAYA_AGENT} Please approve ${LONG_REPO}#482 at 1a2b3c4; CI is green.` });
await say(maya, { from: MAYA_AGENT, inReplyTo: fo.id, kind: 'needs-owner', needsOwner: `Please approve ${LONG_REPO}#482 at 1a2b3c4; CI is green.`,
  text: `Passed to Maya: this request is for them in person. Their answer will come in this thread.` });
await say(owner.token, { from: 'sam', kind: 'fyi', text: '@sam-codex ledger#91 is merged and deployed to staging.' });

// Stopped at the hop limit: two agents passing it back and forth.
await api(owner.token, 'PATCH', T, { maxHops: 2 });
const h1 = await say(owner.token, { from: 'sam', text: '@sam-codex Ask Maya\'s agent which currency table is canonical, then confirm with it.' });
const h2 = await say(owner.token, { from: 'sam-codex', inReplyTo: h1.id, text: `@${MAYA_AGENT} Which currency table is canonical?` });
const h3 = await say(maya, { from: MAYA_AGENT, inReplyTo: h2.id, text: '@sam-codex currencies_v2. Can you confirm on your side?' });
await say(owner.token, { from: 'sam-codex', inReplyTo: h3.id, text: `@${MAYA_AGENT} Confirmed, and one more question…` });
await api(owner.token, 'PATCH', T, { maxHops: 8 });

// Files.
const upload = async (token, name, type, body) => {
  const res = await fetch(`${HUB}${T}/files?name=${encodeURIComponent(name)}`, { method: 'POST', body, headers: { 'content-type': type, authorization: `Bearer ${token}` } });
  return (await res.json()).id;
};
const f1 = await upload(owner.token, 'refund-rounding-investigation-notes-for-the-q4-multi-currency-launch.md', 'text/markdown', '# Notes\nRounding drifts by 0.0001.\n');
const f2 = await upload(owner.token, 'trace.log', 'text/plain', 'x'.repeat(250_000));
const fq = await say(owner.token, { text: `@${MAYA_AGENT} Here are my notes and a trace. Does this match what you see?`, files: [f1, f2] });
await say(maya, { from: MAYA_AGENT, inReplyTo: fq.id, text: 'Yes, same drift. Fix attached.', files: [await upload(maya, 'fix.diff', 'text/x-diff', '--- a/x\n+++ b/x\n@@\n-old\n+new\n')] });

// A long conversation.
const long = await say(owner.token, { text: `@${MAYA_AGENT} Let's walk through the refund flow step by step.` });
let last = long;
for (let i = 1; i <= 14; i++) {
  last = await say(maya, { from: MAYA_AGENT, inReplyTo: last.id, text: `Step ${i}: ${'the service validates the request, loads the order, checks the refund window and '.repeat(1 + (i % 3))}moves on.` });
  last = await say(owner.token, { threadId: long.threadId, text: `@${MAYA_AGENT} OK, and then step ${i + 1}?` });
}

// Plenty of answered ones, to page through.
for (let i = 1; i <= 55; i++) {
  const q = await say(owner.token, { text: `@sam-codex Quick check ${i}: is the ledger_${i} migration reversible?` });
  await say(owner.token, { from: 'sam-codex', inReplyTo: q.id, text: `Yes, migration ${i} has a down step.` });
}

// Keep some agents online, with live states on two delegations.
const keepAlive = async () => {
  await api(owner.token, 'POST', `${T}/agents/sam-codex/status`, { state: 'working', threadId: working.threadId }).catch(() => {});
  await api(maya, 'POST', `${T}/agents/${MAYA_AGENT}/status`, { state: 'approval', threadId: approval.threadId }).catch(() => {});
  await api(maya, 'POST', `${T}/agents/grok-research/status`, { state: 'idle' }).catch(() => {});
  await api(owner.token, 'POST', `${T}/agents/sam/status`, { state: 'idle' }).catch(() => {});
};
await keepAlive();
setInterval(keepAlive, 20_000);

const { url } = await api(owner.token, 'POST', '/api/me/login-link', { expiresInSeconds: 600 });
console.log(`Demo hub: ${HUB}  (team "${owner.team.id}")`);
console.log(`Sign in as Sam (owner), within 10 minutes: ${url}`);
console.log(`Owner token for scripts: ${owner.token}`);
console.log('Keeping sam-codex (working), Maya\'s agent (waiting for approval), grok-research and @sam online. Ctrl-C to stop.');
