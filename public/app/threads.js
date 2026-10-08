// Delegations, worked out from the messages this browser has loaded.
import { S, agentById } from './state.js';

export function threads() {
  const map = new Map();
  for (const m of S.messages) {
    let t = map.get(m.threadId);
    if (!t) { t = { id: m.threadId, msgs: [] }; map.set(m.threadId, t); }
    t.msgs.push(m);
  }
  const out = [];
  for (const t of map.values()) {
    t.first = t.msgs[0]; t.last = t.msgs[t.msgs.length - 1];
    t.from = t.first.from; t.to = t.first.to || [];
    t.title = t.first.title || summarize(t.first.text);
    t.updated = t.last.ts;
    t.waiting = owing(t);
    t.status = statusOf(t);
    out.push(t);
  }
  return out.sort((a, b) => b.updated - a.updated);
}

// A delegation's title: the sender's explicit title, or the first substantial sentence of the request,
// without markdown, greetings like "Codex here." or routing @handles, cut at a word boundary.
function summarize(text) {
  const plain = stripLead(text)
    .replace(/```[\s\S]*?```/g, ' ').replace(/[*`#>]+|\b__?|__?\b(?!\w)/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  const firstLine = plain.split(/\n/).map((l) => l.trim()).find(Boolean) || '';
  const sentences = firstLine.split(/(?<=[.!?])\s+/);
  const greeting = /^(hi|hey|hello|thanks|ok(ay)?|quick question)\b|\bhere[.!]?$|^(i'?m|i am|this is)\b.{0,40}\b(agent|claude|codex|code|session)[.!]?$/i;
  let pick = sentences.map((x) => x.trim()).find((x) => x.length > 12 && !greeting.test(x)) || firstLine;
  pick = pick.replace(/[.:;,]+$/, '');
  if (pick.length <= 80) return pick || 'Untitled delegation';
  const cut = pick.slice(0, 80);
  return cut.slice(0, cut.lastIndexOf(' ') > 40 ? cut.lastIndexOf(' ') : 80).replace(/[,;:\s-]+$/, '') + '…';
}

export function stripLead(text) { return text.replace(/^(\s*[,:;]*\s*@[a-zA-Z][\w-]*)+[\s,:;]*/, '').trim(); }

function statusOf(t) {
  const live = workingIn(t.id);
  if (live.some((l) => l.state === 'approval')) return 'approval';
  if (live.some((l) => l.state === 'working')) return 'working';
  const last = t.last;
  if (last.kind === 'error') return 'error';
  if (last.kind === 'declined') return 'declined';
  if (last.note) return 'stalled';
  return t.waiting.length ? 'queued' : 'answered';
}

// The agents a thread is still waiting on. Each message asks the agents it's addressed to, except the one it answers.
// A reply (the sender named the message it answers) settles everything its sender owed, unless it hands work on to
// someone else. Writing to whoever asked always settles that ask.
// Messages from before the hub recorded `reply` count as replies when an agent sent them with inReplyTo.
function owing(t) {
  const byId = new Map(t.msgs.map((m) => [m.id, m]));
  let debts = []; // { debtor, creditor }
  for (const m of t.msgs) {
    const parent = m.inReplyTo && byId.get(m.inReplyTo);
    const isReply = m.kind === 'error' || m.kind === 'declined' || (m.reply ?? (m.fromKind === 'agent' && !!m.inReplyTo));
    const answering = isReply && parent && parent.from !== m.from ? parent.from : null;
    const to = m.to || [];
    const asks = m.note ? [] : to.filter((r) => r !== m.from && r !== answering && agentById(r));
    debts = debts.filter((d) => d.debtor !== m.from
      || !((isReply && !asks.length) || to.includes(d.creditor)));
    for (const r of asks) if (!debts.some((d) => d.debtor === r && d.creditor === m.from)) debts.push({ debtor: r, creditor: m.from });
  }
  return [...new Set(debts.map((d) => d.debtor))].filter((id) => agentById(id));
}

export function workingIn(threadId) {
  return Object.entries(S.live)
    .filter(([id, l]) => l.threadId === threadId && l.state !== 'idle' && agentById(id)?.online)
    .map(([id, l]) => ({ id, ...l }));
}
