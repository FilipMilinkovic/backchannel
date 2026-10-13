import crypto from 'node:crypto';

export const HANDLE = /^[a-z][a-z0-9_-]{0,31}$/;
export const ROLES = ['owner', 'member', 'viewer'];
export const newId = () => crypto.randomBytes(6).toString('hex');
export const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');
export const newToken = () => `bc_${crypto.randomBytes(32).toString('hex')}`;
export const publicUser = ({ id, handle, name }) => ({ id, handle, name });

export function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

export function tokenFrom(req, url) {
  const header = req.headers.authorization;
  return header ? /^Bearer (bc_[a-f0-9]{64})$/.exec(header)?.[1]
    : url.pathname.endsWith('/events') ? url.searchParams.get('token') : null;
}

const TOUCH_EVERY_MS = 60_000;

// A user authenticates with their main token (CLI, connectors, MCP) or a browser session token
// (from a one-time sign-in link), so browsers never need the main token. Sessions expire after
// `sessionDays` without use; scoped tokens don't (automation may run rarely), they last until revoked or the main
// token is rotated. Returns { user, sessionHash, scopes } or null when optional and no token was sent; `scopes` is
// null except for scoped tokens (server/scopes.js).
export function authenticate(req, url, repo, { optional = false, sessionDays = 30 } = {}) {
  const token = tokenFrom(req, url);
  if (!req.headers.authorization && !token && optional) return null;
  const hash = token && hashToken(token);
  let user = hash && repo.userByTokenHash(hash);
  if (user) return { user, sessionHash: null, scopes: null };
  const session = hash && repo.sessionByHash(hash);
  if (session) {
    const now = Date.now();
    if (!session.scopes && now - session.lastUsedAt > sessionDays * 86_400_000) repo.deleteSession(hash);
    else {
      if (now - session.lastUsedAt > TOUCH_EVERY_MS) repo.touchSession(hash, now);
      user = repo.userById(session.userId);
      if (user) return { user, sessionHash: hash, scopes: session.scopes ? JSON.parse(session.scopes) : null };
    }
  }
  throw httpError(401, 'missing or invalid token');
}

// True while the credential used for a long-lived request (long poll) still works.
export function stillValid(repo, auth) {
  if (auth.sessionHash) return !!repo.sessionByHash(auth.sessionHash);
  return repo.userById(auth.user.id)?.tokenHash === auth.user.tokenHash;
}

export function requireRole(member, roles) {
  if (!roles.includes(member.role)) throw httpError(403, 'permission denied');
}
