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

// A user authenticates with their main token (CLI, connectors, MCP) or a browser session token
// (from a one-time sign-in link), so browsers never need the main token.
export function authenticate(req, url, users, optional = false) {
  const token = tokenFrom(req, url);
  if (!req.headers.authorization && !token && optional) return null;
  const hash = token && hashToken(token);
  const user = hash && users.find((u) => u.tokenHash === hash || u.sessions?.some((s) => s.hash === hash));
  if (!user) throw httpError(401, 'missing or invalid token');
  return user;
}

export function requireRole(member, roles) {
  if (!roles.includes(member.role)) throw httpError(403, 'permission denied');
}
