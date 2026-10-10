// Delegations as the hub sees them. A thread's summary (title, who asked whom, who still owes an answer) is kept in
// the `threads` table and rebuilt from its messages whenever one is posted, so lists never scan every message.
// Whether an agent is working on it right now is live state, added when the summary is read.

// A delegation's title: the sender's explicit title, or the first substantial sentence of the request,
// without markdown, greetings like "Codex here." or routing @handles, cut at a word boundary.
export function stripLead(text) { return String(text).replace(/^(\s*[,:;]*\s*@[a-zA-Z][\w-]*)+[\s,:;]*/, '').trim(); }
export function titleOf(text) {
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

// Who still owes whom an answer. Each message asks the agents it's addressed to, except the one it answers.
// A reply (the sender named the message it answers) settles everything its sender owed, unless it hands work on to
// someone else. Writing to whoever asked always settles that ask.
// Messages from before the hub recorded `reply` count as replies when an agent sent them with inReplyTo.
// A question an agent passes to its owner (kind needs-owner) changes nothing: the agent still owes the answer.
export function debtsOf(msgs, isAgent) {
  const byId = new Map(msgs.map((m) => [m.id, m]));
  let debts = []; // { debtor, creditor }
  for (const m of msgs) {
    if (m.kind === 'needs-owner') continue;
    const parent = m.inReplyTo && byId.get(m.inReplyTo);
    const isReply = m.kind === 'error' || m.kind === 'declined' || (m.reply ?? (m.fromKind === 'agent' && !!m.inReplyTo));
    const answering = isReply && parent && parent.from !== m.from ? parent.from : null;
    const to = m.to || [];
    const asks = m.note ? [] : to.filter((r) => r !== m.from && r !== answering && isAgent(r));
    debts = debts.filter((d) => d.debtor !== m.from || !((isReply && !asks.length) || to.includes(d.creditor)));
    for (const r of asks) if (!debts.some((d) => d.debtor === r && d.creditor === m.from)) debts.push({ debtor: r, creditor: m.from });
  }
  return debts;
}

// The stored part of a thread's summary, from all its messages in order.
export function buildThread(msgs, isAgent) {
  const first = msgs[0], last = msgs[msgs.length - 1];
  return {
    title: first.title || titleOf(first.text),
    from: first.from, fromKind: first.fromKind || null, to: first.to || [],
    participants: [...new Set(msgs.flatMap((m) => [m.from, ...(m.to || [])]))],
    debts: debtsOf(msgs, isAgent),
    lastFrom: last.from, lastKind: last.kind || null, note: !!last.note, hops: last.hop || 0,
    count: msgs.length, started: first.ts, updated: last.ts,
  };
}

export const ACTIVE = new Set(['working', 'approval', 'queued', 'owner']);

// A summary as the API returns it. `live` lists the states of online agents working in this thread right now.
export function present(row, { isAgent, live = [] }) {
  const waitingOn = [...new Set(row.debts.map((d) => d.debtor))].filter(isAgent);
  const status = live.includes('approval') ? 'approval' : live.includes('working') ? 'working'
    : row.lastKind === 'error' ? 'error' : row.lastKind === 'declined' ? 'declined' : row.note ? 'stalled'
      : row.lastKind === 'needs-owner' && waitingOn.length ? 'owner' : waitingOn.length ? 'queued' : 'answered';
  const { debts, ...rest } = row;
  return { ...rest, waitingOn, status, active: ACTIVE.has(status), cursor: `${row.updated}:${row.id}` };
}
