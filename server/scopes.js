// Scoped tokens: credentials for automation (cloud workers, CI) that can do less than their account. One is limited to
// one team, may only run agents whose handles start with a prefix, may only message the handles it was given, and by
// default reads only the threads its own agents took part in. It can't manage the account (rotate the token, sign in
// a browser, mint more tokens), the team (invites, members, settings) or anyone's stand-in.
import { HANDLE, httpError } from './auth.js';

export const MAX_SCOPED_TOKENS = 20;
const PREFIX = /^[a-z][a-z0-9_-]{1,23}$/;
const MAX_POST_TO = 20;
export const READS = ['own', 'team'];

// Checks what someone asked for and returns the scopes to store. `teams` are the account's memberships; `handle` and
// `agentIdsIn(teamId)` are the account's handle and its agents there, which the prefix must stay clear of (a prefix
// people pick to fence automation off would otherwise reach their own sessions).
export function parseScopes(b, teams, { handle, agentIdsIn }) {
  const team = teams.find((t) => t.id === b.team);
  if (!team) throw httpError(400, 'team must be the id of a team you are in');
  if (!['owner', 'member'].includes(team.role)) throw httpError(400, 'viewers can\'t make tokens that post');
  if (typeof b.agents !== 'string' || !PREFIX.test(b.agents)) {
    throw httpError(400, 'agents must be a handle prefix of 2 to 24 characters, e.g. "cw-"');
  }
  if (handle.startsWith(b.agents)) throw httpError(400, `the prefix "${b.agents}" covers your own handle @${handle}; pick one that doesn't, e.g. "cw-"`);
  const covered = agentIdsIn(team.id).filter((id) => id.startsWith(b.agents));
  if (covered.length) {
    throw httpError(400, `the prefix "${b.agents}" covers agents you already run (${covered.map((id) => '@' + id).join(', ')}); pick another`);
  }
  const postTo = Array.isArray(b.postTo) ? [...new Set(b.postTo.map((h) => String(h).replace(/^@/, '').toLowerCase()))] : [];
  if (!postTo.length || postTo.length > MAX_POST_TO || postTo.some((h) => !HANDLE.test(h))) {
    throw httpError(400, `postTo must list 1 to ${MAX_POST_TO} handles the token may message`);
  }
  const read = b.read === undefined ? 'own' : b.read;
  if (!READS.includes(read)) throw httpError(400, `read must be one of ${READS.join(', ')}`);
  return { team: team.id, agents: b.agents, postTo, read };
}

// Team routes a scoped token may use. `agent` is set when the route acts as one of the token's agents, which must
// then carry the prefix (and be one the token registered; routes.js checks that).
const ALLOWED = [
  ['GET', /^\/$/], ['GET', /^\/members$/], ['GET', /^\/agents$/], ['POST', /^\/agents$/],
  ['GET', /^\/agents\/[\w-]+\/card$/],
  ['DELETE', /^\/agents\/([\w-]+)$/, 'agent'],
  ['GET', /^\/agents\/([\w-]+)\/(?:inbox|pending|activity)$/, 'agent'],
  ['POST', /^\/agents\/([\w-]+)\/(?:status|requeue|claim|ack)$/, 'agent'],
  ['POST', /^\/files$/], ['GET', /^\/files\/[a-f0-9]+(?:\/info)?$/],
  ['GET', /^\/messages$/], ['POST', /^\/messages$/],
  ['GET', /^\/threads$/], ['GET', /^\/threads\/counts$/], ['GET', /^\/threads\/[\w-]+(?:\/summary)?$/],
];

// Returns { agent } (an agent id the route acts as, or null) or throws 403 for a route the token can't use.
export function scopedRoute(scopes, method, rest) {
  for (const [verb, re, kind] of ALLOWED) {
    const m = verb === method && re.exec(rest);
    if (!m) continue;
    const agent = kind === 'agent' ? m[1].toLowerCase() : null;
    if (agent && !agent.startsWith(scopes.agents)) throw httpError(403, `this token only runs agents named ${scopes.agents}…`);
    return { agent };
  }
  throw httpError(403, "this token is scoped and can't do that");
}

export const ownsHandle = (scopes, id) => id.startsWith(scopes.agents);
