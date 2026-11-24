// Delegations, as summarized by the hub (GET /threads). Who's working on one right now comes from the live event
// stream, so the status is finished here; a thread's messages are loaded when it's opened.
import { S, agentById, tapi } from './state.js';

// The loaded summaries, newest first, with their live status.
export function threads() {
  return [...S.threads.values()].map(withLive).sort((a, b) => b.updated - a.updated || (a.id < b.id ? 1 : -1));
}
export const thread = (id) => { const t = S.threads.get(id); return t && withLive(t); };

export function withLive(t) {
  const live = workingIn(t.id);
  const waiting = (t.waitingOn || []).filter((id) => agentById(id));
  // Mirrors present() in server/threads.js: a lone FYI is never being worked on.
  const status = t.kind === 'fyi' && t.count === 1 && !waiting.length ? 'fyi'
    : live.some((l) => l.state === 'approval') ? 'approval' : live.some((l) => l.state === 'working') ? 'working'
      : t.lastKind === 'error' ? 'error' : t.lastKind === 'declined' ? 'declined' : t.note ? 'stalled'
        : t.lastKind === 'needs-owner' && waiting.length ? 'owner' : waiting.length ? 'queued' : 'answered';
  return { ...t, waiting, status };
}

export function stripLead(text) { return text.replace(/^(\s*[,:;]*\s*@[a-zA-Z][\w-]*)+[\s,:;]*/, '').trim(); }

export function workingIn(threadId) {
  return Object.entries(S.live)
    .filter(([id, l]) => l.threadId === threadId && l.state !== 'idle' && agentById(id)?.online)
    .map(([id, l]) => ({ id, ...l }));
}

const PAGE = 50;
const merge = (list) => { for (const t of list) S.threads.set(t.id, t); };

// Every active delegation, the newest page of all of them, and the counts.
export async function loadThreads(team = S.team) {
  const [active, recent, counts] = await Promise.all([tapi('/threads?state=active'), tapi(`/threads?limit=${PAGE}`), tapi('/threads/counts')]);
  if (team !== S.team) return false;
  merge(active); merge(recent);
  S.counts = counts;
  if (S.olderCursor === undefined || S.olderCursor === null) S.olderCursor = recent.length === PAGE ? recent.at(-1).cursor : null;
  return true;
}

// The next page of older delegations.
export async function loadOlder() {
  if (!S.olderCursor) return;
  const team = S.team;
  const page = await tapi(`/threads?limit=${PAGE}&before=${encodeURIComponent(S.olderCursor)}`);
  if (team !== S.team) return;
  merge(page);
  S.olderCursor = page.length === PAGE ? page.at(-1).cursor : null;
}

// A thread's messages, loaded once and then kept current by the event stream.
export async function loadMessages(id, { force = false } = {}) {
  if (S.msgs.has(id) && !force) return S.msgs.get(id);
  const team = S.team;
  const msgs = await tapi(`/threads/${encodeURIComponent(id)}`);
  if (team !== S.team) return null;
  // Messages that arrived on the event stream while this was loading may be missing from the response.
  setMessages(id, [...msgs, ...(S.msgs.get(id) || [])]);
  return S.msgs.get(id);
}

// Messages heard on the event stream for threads whose messages aren't loaded yet. Kept for a while, so a load
// that races the stream (opening a thread, or a reply arriving before the hub answers a new delegation) loses none.
const unloaded = [];
// Sets a thread's messages (with any heard before it was loaded), oldest first, without duplicates.
export function setMessages(id, list) {
  const seen = new Set();
  const all = [...list, ...unloaded.filter((m) => m.threadId === id)].filter((m) => !seen.has(m.id) && seen.add(m.id));
  S.msgs.set(id, all.sort((a, b) => a.ts - b.ts));
}

// A message this browser posted or heard about: added to its thread if that thread is loaded.
export function addMessage(m) {
  const list = S.msgs.get(m.threadId);
  if (!list) { unloaded.push(m); if (unloaded.length > 200) unloaded.shift(); return; }
  if (!list.some((x) => x.id === m.id)) list.push(m);
}

// A summary from the event stream (or after posting). A thread we didn't know about adds to the total.
export function putThread(t) {
  if (!S.threads.has(t.id) && S.counts) S.counts.total++;
  S.threads.set(t.id, t);
}
