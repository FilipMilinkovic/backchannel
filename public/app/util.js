// Small helpers with no state: DOM lookup, escaping, storage, icons, labels, time and text formatting.

export const $ = (id) => document.getElementById(id);
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const store = { get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} } };
export const ICON = {
  back: '<svg class="i" viewBox="0 0 16 16"><path d="M10 3 5 8l5 5"/></svg>',
  file: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9 2H4.5A1.5 1.5 0 0 0 3 3.5v9A1.5 1.5 0 0 0 4.5 14h7a1.5 1.5 0 0 0 1.5-1.5V6L9 2Z"/><path d="M9 2v4h4"/></svg>',
};
export const size = (n) => (n < 1024 ? `${n} B` : n < 1_048_576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1_048_576).toFixed(1)} MB`);
export const LABEL = { working: 'Working', approval: 'Needs approval', queued: 'Waiting', owner: 'Waiting on its owner', answered: 'Answered', declined: 'Declined', error: 'Failed', stalled: 'Stopped' };
export const ACTIVE = new Set(['working', 'approval', 'queued', 'owner']);
export const BACKEND = { 'claude-code': 'Claude Code', codex: 'Codex', openai: 'OpenAI', grok: 'Grok', echo: 'Echo' };

export function glyph(status) {
  const c = '<circle cx="8" cy="8" r="6.2"/>';
  switch (status) {
    case 'working': return `<svg class="g working" viewBox="0 0 16 16" aria-hidden="true"><circle class="track" cx="8" cy="8" r="6.2"/><circle class="arc" cx="8" cy="8" r="6.2"/></svg>`;
    case 'approval': return `<svg class="g approval" viewBox="0 0 16 16" aria-hidden="true">${c}<path d="M8 5v3.6M8 10.9v.1"/></svg>`;
    case 'answered': return `<svg class="g answered" viewBox="0 0 16 16" aria-hidden="true">${c}<path d="m5.4 8.2 1.8 1.8 3.5-3.7"/></svg>`;
    case 'declined': return `<svg class="g declined" viewBox="0 0 16 16" aria-hidden="true">${c}<path d="M5.6 8h4.8"/></svg>`;
    case 'error': case 'stalled': return `<svg class="g ${status}" viewBox="0 0 16 16" aria-hidden="true">${c}<path d="m6 6 4 4M10 6l-4 4"/></svg>`;
    default: return `<svg class="g queued" viewBox="0 0 16 16" aria-hidden="true">${c}</svg>`;
  }
}
// ---------- time ----------
export function rel(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 45) return 'now';
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' });
}
export const clock = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
export function elapsed(since) { const s = Math.max(0, Math.round((Date.now() - since) / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }

// ---------- text ----------
export function md(text) {
  const parts = String(text).split(/```[\w-]*\n?([\s\S]*?)```/g);
  return parts.map((p, i) => {
    if (i % 2) return `<pre>${esc(p.replace(/\n$/, ''))}</pre>`;
    return p.split(/\n{2,}/).filter((x) => x.trim()).map((para) => '<p>' + esc(para)
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^\w&])@([a-zA-Z][\w-]*)/g, '$1<span class="mention">@$2</span>')
      .replace(/\n/g, '<br>') + '</p>').join('');
  }).join('');
}
