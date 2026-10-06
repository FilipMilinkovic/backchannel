// Error reporting: every unexpected error is logged with its stack and context, and sent to Sentry
// when SENTRY_DSN is set (plain HTTP envelope API, no SDK). Sending is capped so an error loop can't flood it.
import crypto from 'node:crypto';
import os from 'node:os';
import { redact } from './log.js';

const MAX_PER_MINUTE = 30;

function frames(stack = '') {
  return stack.split('\n').slice(1).map((line) => {
    const m = /at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/.exec(line.trim());
    return m && { function: m[1] || '?', filename: m[2], lineno: Number(m[3]), colno: Number(m[4]),
      in_app: !m[2].includes('node:') && !m[2].includes('node_modules') };
  }).filter(Boolean).reverse();
}

export function createReporter({ log, sentry, environment, release }) {
  let windowStart = Date.now(), sent = 0;
  const pending = new Set();

  function toSentry(err, context) {
    if (!sentry) return;
    if (Date.now() - windowStart > 60_000) { windowStart = Date.now(); sent = 0; }
    if (++sent > MAX_PER_MINUTE) return;
    const eventId = crypto.randomUUID().replace(/-/g, '');
    const { requestId, method, path, userId, source = 'server', ...extra } = context;
    const event = {
      event_id: eventId, timestamp: Date.now() / 1000, platform: source === 'browser' ? 'javascript' : 'node',
      level: 'error', environment, release, server_name: os.hostname(),
      exception: { values: [{ type: err.name || 'Error', value: redact(String(err.message)).slice(0, 2000), stacktrace: { frames: frames(redact(err.stack)) } }] },
      tags: { source, ...(requestId ? { request_id: requestId } : {}) },
      ...(userId ? { user: { id: userId } } : {}),
      ...(method ? { request: { method, url: redact(path) } } : {}),
      extra: JSON.parse(redact(JSON.stringify(extra))),
    };
    const body = [JSON.stringify({ event_id: eventId, sent_at: new Date().toISOString(), dsn: sentry.dsn }),
      JSON.stringify({ type: 'event' }), JSON.stringify(event)].join('\n');
    const p = fetch(`${sentry.url}?sentry_key=${sentry.key}&sentry_version=7`, {
      method: 'POST', headers: { 'content-type': 'application/x-sentry-envelope' }, body, signal: AbortSignal.timeout(5000),
    }).then((res) => { if (!res.ok) log.warn('sentry rejected an event', { status: res.status }); })
      .catch((e) => log.warn('could not reach sentry', { error: e.message }))
      .finally(() => pending.delete(p));
    pending.add(p);
  }

  return {
    // context: { requestId, method, path, userId, source, ... }
    error(err, context = {}) {
      if (!(err instanceof Error)) err = new Error(String(err));
      log.error(context.message || err.message, { ...context, message: undefined, err });
      toSentry(err, context);
    },
    // Waits for in-flight Sentry requests, e.g. before exiting.
    flush(ms = 2000) {
      return Promise.race([Promise.allSettled([...pending]), new Promise((r) => setTimeout(r, ms).unref())]);
    },
  };
}

export function installProcessHandlers(reporter, onFatal) {
  process.on('unhandledRejection', (reason) => reporter.error(reason, { message: 'unhandled promise rejection', fatal: false }));
  process.on('uncaughtException', (err) => {
    reporter.error(err, { message: 'uncaught exception, exiting', fatal: true });
    onFatal();
  });
}
