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

export function authenticate(req, url, users, optional = false) {
  const header = req.headers.authorization;
  const token = header ? /^Bearer (bc_[a-f0-9]{64})$/.exec(header)?.[1]
    : url.pathname.endsWith('/events') ? url.searchParams.get('token') : null;
  if (!header && !token && optional) return null;
  const user = token && users.find((u) => u.tokenHash === hashToken(token));
  if (!user) throw httpError(401, 'missing or invalid token');
  return user;
}

export function requireRole(member, roles) {
  if (!roles.includes(member.role)) throw httpError(403, 'permission denied');
}
