// Hub settings from the environment, validated once at startup so a bad value fails fast with a clear message.
import path from 'node:path';

const LEVELS = ['debug', 'info', 'warn', 'error'];

export function loadConfig(env = process.env) {
  const problems = [];
  const int = (name, fallback, min, max) => {
    const raw = env[name];
    if (raw === undefined || raw === '') return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) { problems.push(`${name} must be a whole number from ${min} to ${max} (got "${raw}")`); return fallback; }
    return n;
  };
  const oneOf = (name, options, fallback) => {
    const raw = env[name] || fallback;
    if (!options.includes(raw)) problems.push(`${name} must be one of ${options.join(', ')} (got "${raw}")`);
    return raw;
  };

  const port = int('PORT', 7777, 0, 65535);
  const host = env.HOST || '127.0.0.1';
  // Railway sets RAILWAY_PUBLIC_DOMAIN once the service has a domain; use it unless PUBLIC_URL says otherwise.
  const onRailway = !!(env.RAILWAY_ENVIRONMENT || env.RAILWAY_PUBLIC_DOMAIN);
  const rawPublicUrl = env.PUBLIC_URL || (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : '');
  let publicUrl = null;
  if (rawPublicUrl) {
    try {
      const u = new URL(rawPublicUrl);
      if (!['http:', 'https:'].includes(u.protocol)) throw new Error();
      publicUrl = u.origin + u.pathname.replace(/\/$/, '');
    } catch { problems.push(`PUBLIC_URL must be an http(s) URL (got "${rawPublicUrl}")`); }
  }
  let sentry = null;
  if (env.SENTRY_DSN) {
    try {
      const u = new URL(env.SENTRY_DSN);
      const projectId = u.pathname.split('/').filter(Boolean).pop();
      if (!u.username || !projectId) throw new Error();
      sentry = { key: u.username, url: `${u.protocol}//${u.host}${u.pathname.slice(0, u.pathname.lastIndexOf('/'))}/api/${projectId}/envelope/`, dsn: env.SENTRY_DSN };
    } catch { problems.push('SENTRY_DSN is not a valid Sentry DSN'); }
  }

  const config = {
    port, host,
    publicUrl, // null means "derive from the listening address"
    dataDir: path.resolve(env.DATA_DIR || './data'),
    logLevel: oneOf('LOG_LEVEL', LEVELS, 'info'),
    logFormat: oneOf('LOG_FORMAT', ['json', 'pretty'], env.NODE_ENV === 'production' || !process.stdout.isTTY ? 'json' : 'pretty'),
    // Where the real client IP comes from: the socket (default), Fly-Client-IP, CF-Connecting-IP,
    // or the last X-Forwarded-For entry (one generic reverse proxy in front). Only set it when that proxy is the sole way in.
    // On Railway this defaults to "railway" (its edge replaces X-Forwarded-For; the first entry is the client).
    trustProxy: (() => {
      const modes = { '': null, 0: null, false: null, fly: 'fly', cloudflare: 'cloudflare', railway: 'railway', 1: 'xff', true: 'xff', xff: 'xff' };
      const raw = String(env.TRUST_PROXY ?? (onRailway ? 'railway' : '')).toLowerCase();
      if (raw in modes) return modes[raw];
      problems.push(`TRUST_PROXY must be one of fly, railway, cloudflare, xff (got "${env.TRUST_PROXY}")`);
      return null;
    })(),
    maxConnections: int('MAX_CONNECTIONS', 5000, 10, 1_000_000),
    sentry,
    environment: env.SENTRY_ENVIRONMENT || env.NODE_ENV || 'development',
    // Per-minute budgets. Public routes are per IP, writes are per user.
    limits: {
      publicPerMinute: int('RATE_PUBLIC_PER_MIN', 20, 1, 100_000),
      writesPerMinute: int('RATE_WRITES_PER_MIN', 240, 1, 100_000),
      readsPerMinute: int('RATE_READS_PER_MIN', 1200, 1, 1_000_000),
      streamsPerUser: int('MAX_STREAMS_PER_USER', 50, 1, 10_000),
    },
    // Attachments: the largest single file, and the total a team may store.
    maxFileMb: int('MAX_FILE_MB', 25, 1, 1024),
    teamFilesMb: int('TEAM_FILES_MB', 1024, 1, 1_000_000),
    sessionDays: int('SESSION_DAYS', 30, 1, 3650),
    // Automatic copies in DATA_DIR/backups. 0 turns them off.
    backupHours: int('BACKUP_HOURS', 24, 0, 24 * 30),
    backupKeep: int('BACKUP_KEEP', 7, 1, 365),
    shutdownMs: int('SHUTDOWN_TIMEOUT_MS', 10_000, 0, 120_000),
  };
  if (problems.length) {
    const err = new Error(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
    err.code = 'BAD_CONFIG';
    throw err;
  }
  return config;
}
