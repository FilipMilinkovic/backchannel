// The app's state and the hub API, plus lookups every view uses.
import { signOut } from './main.js';
import { store } from './util.js';

export const S = {
  token: store.get('bc.token', ''),
  me: null, teams: [], team: null, role: null, members: [], invites: [],
  agents: [], config: null, live: {}, // live: agentId -> { state, threadId, since }
  // Delegations: summaries from the hub (id -> summary), messages of the threads opened so far (id -> [message]),
  // counts, where the next page of older ones starts, and agents' activity for their profiles (id -> activity).
  threads: new Map(), msgs: new Map(), counts: null, olderCursor: undefined, activity: {},
  view: 'delegations', filter: store.get('bc.filter', 'active'), selected: null, composing: true,
  fresh: new Set(), connected: false,
};
// ---------- data ----------
export async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { 'content-type': 'application/json', ...(S.token ? { authorization: `Bearer ${S.token}` } : {}) } });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401 && S.token && S.me) { signOut('Your session ended (the token was rotated or removed). Sign in again.'); }
  if (!res.ok) { const err = new Error(body.error || `Request failed (${res.status})`); err.status = res.status; throw err; }
  return body;
}
export const tapi = (p, opts) => api(`/api/teams/${encodeURIComponent(S.team)}${p}`, opts);
export const post = (p, data, method = 'POST') => tapi(p, { method, body: JSON.stringify(data) });

export const agentById = (id) => S.agents.find((a) => a.id === id);
const memberByHandle = (h) => S.members.find((m) => m.handle === h);
export const isOwner = () => S.role === 'owner';
export const canPost = () => S.role === 'owner' || S.role === 'member';
// Senders: agents are @handles; people show by name, and you as "You".
export function senderName(m) {
  if (m.fromKind === 'user' || (!m.fromKind && !agentById(m.from))) {
    if (S.me && m.from === S.me.user.handle) return 'You';
    if (m.from === 'human') return 'Someone';
    return memberByHandle(m.from)?.name || '@' + m.from;
  }
  return '@' + m.from;
}
export const display = (id) => (S.me && id === S.me.user.handle && !agentById(id) ? 'You' : '@' + id);
export const ownerOf = (id) => { const a = agentById(id); return a ? (memberByHandle(a.ownerHandle)?.name || a.owner || '') : ''; };
