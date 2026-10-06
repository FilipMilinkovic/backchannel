// Structured logger: one JSON object per line (production), or a short readable line (local terminal).
// Secrets never reach the log: bearer tokens, ?token= values, and invite/login codes in API paths are redacted.
// (The setup link printed at first start is meant for the operator, so #join links in messages are kept.)
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

export function redact(value) {
  if (typeof value !== 'string') return value;
  return value
    .replace(/bc_[a-f0-9]{64}/g, 'bc_[redacted]')
    .replace(/([?&]token=)[^&\s"]+/g, '$1[redacted]')
    .replace(/(\/api\/(?:invites|login)\/)([a-f0-9]{4})[a-f0-9]+/g, '$1$2…');
}

function clean(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    if (v instanceof Error) out[k] = { message: redact(v.message), stack: redact(v.stack), ...(v.code ? { code: v.code } : {}) };
    else out[k] = typeof v === 'string' ? redact(v) : v;
  }
  return out;
}

export function createLogger({ level = 'info', format = 'json', stream = process.stdout, base = {} } = {}) {
  const min = LEVELS[level] ?? LEVELS.info;
  function write(lvl, msg, fields = {}) {
    if (LEVELS[lvl] < min) return;
    const entry = { time: new Date().toISOString(), level: lvl, msg: redact(msg), ...clean({ ...base, ...fields }) };
    if (format === 'json') { stream.write(JSON.stringify(entry) + '\n'); return; }
    const { time, level: l, msg: m, ...rest } = entry;
    const extra = Object.entries(rest).filter(([k]) => k !== 'err')
      .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' ');
    stream.write(`${time.slice(11, 19)} ${l.toUpperCase().padEnd(5)} ${m}${extra ? '  ' + extra : ''}\n${rest.err?.stack ? rest.err.stack + '\n' : ''}`);
  }
  return {
    debug: (msg, f) => write('debug', msg, f),
    info: (msg, f) => write('info', msg, f),
    warn: (msg, f) => write('warn', msg, f),
    error: (msg, f) => write('error', msg, f),
    child: (more) => createLogger({ level, format, stream, base: { ...base, ...more } }),
  };
}
