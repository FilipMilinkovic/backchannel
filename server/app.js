// HTTP layer: request ids, security headers, access logs, error handling, static UI, health checks, graceful shutdown.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createApi, send } from './routes.js';
import { createRealtime } from './realtime.js';
import { RateLimiter, StreamCap } from './limits.js';
import { httpError } from './auth.js';
import { redact } from './log.js';

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8' };
const MAX_BODY = 2_000_000;

// CSP that allows exactly the inline scripts in the UI (by hash) and nothing else inline.
function contentSecurityPolicy(publicDir) {
  let html = '';
  try { html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8'); } catch {}
  const hashes = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map((m) => `'sha256-${crypto.createHash('sha256').update(m[1]).digest('base64')}'`);
  return ["default-src 'self'", `script-src 'self' ${hashes.join(' ')}`.trim(),
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com", "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:", "connect-src 'self'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'", "object-src 'none'"].join('; ');
}

export function createApp({ config, repo, log, reporter, version, publicDir }) {
  const rt = createRealtime();
  const limits = {
    public: new RateLimiter(config.limits.publicPerMinute),
    writes: new RateLimiter(config.limits.writesPerMinute),
    reads: new RateLimiter(config.limits.readsPerMinute),
    clientErrors: new RateLimiter(10),
    streams: new StreamCap(config.limits.streamsPerUser),
  };
  let publicUrl = config.publicUrl;
  let draining = false;
  const api = createApi({ repo, rt, config, publicUrl: () => publicUrl, limits });
  const csp = contentSecurityPolicy(publicDir);
  const hsts = config.publicUrl?.startsWith('https://');

  function clientIp(req) {
    const header = (name) => { const v = req.headers[name]; return typeof v === 'string' && v.length < 100 ? v.trim() : null; };
    let ip = null;
    if (config.trustProxy === 'fly') ip = header('fly-client-ip');
    else if (config.trustProxy === 'cloudflare') ip = header('cf-connecting-ip');
    else if (config.trustProxy === 'xff') {
      // The right-most entry is the one our own proxy added; anything left of it is client-supplied.
      ip = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean).pop() || null;
    }
    return ip || req.socket.remoteAddress || 'unknown';
  }

  async function readBody(req) {
    if (!/^application\/json\b/i.test(req.headers['content-type'] || 'application/json')) throw httpError(415, 'send JSON (content-type: application/json)');
    if (Number(req.headers['content-length'] || 0) > MAX_BODY) throw httpError(413, 'body too large');
    let raw = '';
    for await (const chunk of req) { raw += chunk; if (raw.length > MAX_BODY) throw httpError(413, 'body too large'); }
    if (!raw) return {};
    let body;
    try { body = JSON.parse(raw); } catch { throw httpError(400, 'invalid JSON'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw httpError(400, 'body must be an object');
    return body;
  }

  function serveStatic(req, res, pathname) {
    if (!['GET', 'HEAD'].includes(req.method)) throw httpError(405, 'method not allowed');
    const file = path.resolve(publicDir, pathname === '/' ? 'index.html' : '.' + decodeURIComponent(pathname));
    if (!file.startsWith(publicDir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('not found');
    }
    const isHtml = file.endsWith('.html');
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': isHtml ? 'no-cache' : 'public, max-age=300' });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  }

  // Browser errors from the UI. Public (the sign-in screen can fail too), size-capped and rate-limited per IP.
  async function clientError(ctx) {
    limits.clientErrors.take(`ip:${ctx.ip}`);
    const b = await readBody(ctx.req);
    const s = (v, n) => (typeof v === 'string' ? v.slice(0, n) : undefined);
    const err = new Error(s(b.message, 1000) || 'browser error');
    err.name = s(b.name, 100) || 'BrowserError';
    err.stack = `${err.name}: ${err.message}\n${s(b.stack, 8000) || ''}`;
    reporter.error(err, { message: `browser error: ${err.message}`, source: 'browser', requestId: ctx.requestId,
      page: s(b.url, 500), userAgent: s(ctx.req.headers['user-agent'], 300), release: s(b.release, 50) });
    return send(ctx.res, 202, { ok: true });
  }

  const server = http.createServer(async (req, res) => {
    const started = process.hrtime.bigint();
    const incoming = req.headers['x-request-id'];
    const requestId = typeof incoming === 'string' && /^[\w.-]{1,64}$/.test(incoming) ? incoming : crypto.randomBytes(8).toString('hex');
    const url = new URL(req.url, 'http://hub.local');
    const ctx = { req, res, url, path: url.pathname, requestId, ip: clientIp(req), userId: undefined,
      readBody: () => readBody(req), draining: () => draining };

    res.setHeader('x-request-id', requestId);
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader('cross-origin-opener-policy', 'same-origin');
    res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('content-security-policy', csp);
    if (hsts) res.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains');

    res.on('close', () => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      const quiet = ctx.path === '/healthz' || ctx.path === '/readyz';
      log[quiet ? 'debug' : 'info']('request', { requestId, method: req.method, path: redact(req.url), status: res.statusCode,
        ms: Math.round(ms), ip: ctx.ip, userId: ctx.userId, ...(res.writableFinished ? {} : { aborted: true }) });
    });

    inflight++;
    try {
      const p = ctx.path;
      if (p === '/healthz') return send(res, 200, { ok: true, version });
      if (p === '/readyz') {
        let ok = !draining;
        try { ok = ok && repo.ping(); } catch { ok = false; }
        return send(res, ok ? 200 : 503, { ok, version, ...(draining ? { draining: true } : {}) });
      }
      if (draining) { res.setHeader('connection', 'close'); throw httpError(503, 'hub is restarting, retry in a moment'); }
      if (p !== '/api' && !p.startsWith('/api/')) return serveStatic(req, res, p);
      if (p === '/api/client-errors' && req.method === 'POST') return await clientError(ctx);
      if (p === '/api/version' && req.method === 'GET') return send(res, 200, { version });
      await api(ctx);
    } catch (err) {
      if (err.status === 429 && err.retryAfter) res.setHeader('retry-after', String(err.retryAfter));
      if (!err.status) reporter.error(err, { message: 'request failed', requestId, method: req.method, path: req.url, userId: ctx.userId });
      if (!res.headersSent && !res.destroyed) {
        send(res, err.status || 500, err.status ? { error: err.message } : { error: 'internal server error', requestId });
      } else if (!res.writableEnded) res.end();
    } finally {
      if (--inflight === 0) for (const done of idle.splice(0)) done();
    }
  });
  let inflight = 0;
  const idle = [];
  // Longer than typical proxy idle timeouts (Fly, ALB use 60 s), so the hub never closes a connection the proxy is about to reuse.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  server.maxConnections = config.maxConnections;

  // Background jobs. A failing job is reported, never fatal.
  const every = (ms, name, fn) => setInterval(() => {
    try { fn(); } catch (err) { reporter.error(err, { message: `background job failed: ${name}` }); }
  }, ms);
  const timers = [
    every(10_000, 'agent presence', () => { for (const teamId of new Set([...rt.sseClients].map((c) => c.teamId))) api.broadcastAgents(teamId); }),
    every(20_000, 'stream keepalive', () => { for (const c of rt.sseClients) rt.write(c, ': ping\n\n'); }),
    every(30_000, 'stream revalidation', () => api.revalidateStreams()),
    every(3_600_000, 'session expiry', () => {
      const n = repo.pruneSessions(Date.now() - config.sessionDays * 86_400_000);
      if (n) log.info('expired browser sessions removed', { count: n });
    }),
  ];
  for (const t of timers) t.unref();

  return {
    server,
    setPublicUrl(url) { publicUrl = url; },
    get publicUrl() { return publicUrl; },
    // Stop taking requests (readiness fails, new requests get 503), release long polls with an empty answer
    // (nothing is dequeued) and end streams, then wait for running handlers so the database can close safely.
    async shutdown() {
      if (draining) return;
      draining = true;
      for (const t of timers) clearInterval(t);
      const closed = new Promise((resolve) => server.close(resolve));
      rt.closeAll();
      // Released polls and ended streams leave keep-alive sockets idle a moment later; keep sweeping them.
      server.closeIdleConnections();
      const sweep = setInterval(() => server.closeIdleConnections(), 50);
      closed.then(() => clearInterval(sweep));
      const handlersDone = () => (inflight ? new Promise((resolve) => idle.push(resolve)) : Promise.resolve());
      const deadline = new Promise((resolve) => setTimeout(() => resolve('timeout'), config.shutdownMs).unref());
      if (await Promise.race([Promise.all([closed, handlersDone()]), deadline]) === 'timeout') {
        log.warn('shutdown timeout; closing remaining connections', { inflight });
        server.closeAllConnections();
        await Promise.race([handlersDone(), new Promise((resolve) => setTimeout(resolve, 1000).unref())]);
      }
      clearInterval(sweep);
      // Let socket close events (which may put undelivered messages back in an inbox) run before the database closes.
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}
