// Delegations: the list, the detail pane, the picker and both composers (with attachments).
import { select } from './main.js';
import { S, agentById, canPost, display, ownerOf, post, senderName, tapi } from './state.js';
import { addMessage, loadMessages, putThread, stripLead, thread, threads, workingIn } from './threads.js';
import { $, ACTIVE, BACKEND, ICON, LABEL, clock, elapsed, esc, glyph, md, rel, size, store } from './util.js';

// ---------- render: list ----------
export function renderList() {
  $('newBtn').hidden = !canPost();
  const ts = threads();
  const nActive = ts.filter((t) => ACTIVE.has(t.status)).length;
  $('nActive').textContent = nActive || '';
  // Older finished delegations may not be loaded yet; the hub's count covers them.
  $('nDone').textContent = ((S.counts ? Math.max(S.counts.total, ts.length) : ts.length) - nActive) || '';
  document.querySelectorAll('#filters button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.filter === S.filter)));

  const shown = ts.filter((t) => t.id === S.selected || S.filter === 'all' || (S.filter === 'active') === ACTIVE.has(t.status));
  const older = S.filter !== 'active' && S.olderCursor
    ? '<li class="more" role="presentation"><button class="btn ghost" type="button" data-action="older">Show older delegations</button></li>' : '';
  if (!shown.length && older) { $('rows').innerHTML = older; return; }
  if (!shown.length) {
    $('rows').innerHTML = `<li class="empty" role="presentation">${ts.length
      ? `<h3>${S.filter === 'active' ? 'Nothing in flight' : 'Nothing finished yet'}</h3><p>${S.filter === 'active' ? 'Every delegation has been answered.' : 'Finished delegations show up here.'}</p>`
      : `<div class="diagram" aria-hidden="true"><span class="node mono">your agent</span><span class="wire"></span><span class="node mono">their agent</span></div>
         <h3>No delegations yet</h3>
         <p>A delegation is one agent asking another for an answer or a change, so neither person has to stop and ask. Start one here, or connect your coding agent so it can delegate on its own mid-task.</p>
         <div style="display:flex;gap:8px">${canPost() ? '<button class="btn primary" data-action="new">New delegation</button>' : ''}<button class="btn" data-goto="connect">Connect</button></div>`}</li>`;
    return;
  }
  $('rows').innerHTML = shown.map((t) => {
    const to = t.to.length ? t.to.map(display).join(', ') : 'nobody';
    const n = t.count;
    return `<li class="row${S.fresh.has(t.id) ? ' fresh' : ''}" role="option" tabindex="-1" data-id="${t.id}" aria-selected="${t.id === S.selected}">
      <span class="glyph">${glyph(t.status)}</span>
      <span class="title">${esc(t.title)}</span>
      <span class="time num">${rel(t.updated)}</span>
      <span class="route"><b>${esc(senderName(t))}</b> to <b>${esc(to)}</b> · ${n} ${n === 1 ? 'message' : 'messages'}</span>
      <span class="state ${t.status}">${LABEL[t.status]}</span>
    </li>`;
  }).join('') + older;
  S.fresh.clear();
}

// ---------- render: detail ----------
let renderedThread = null, renderedCount = 0;
const loading = new Set();
export function renderDetail() {
  const t = S.selected && thread(S.selected);
  $('view-delegations').classList.toggle('show-detail', !!(t || S.composing) && S.mobileDetail);
  $('viewerNote').hidden = canPost();
  if (!t) {
    $('detailBody').hidden = !!canPost(); $('replyForm').hidden = true; $('newForm').hidden = !canPost();
    if (!canPost()) { $('detailBody').innerHTML = '<div class="empty"><h3>Pick a delegation</h3><p>Select one on the left to follow along.</p></div>'; renderedThread = null; return; }
    renderPicker();
    renderedThread = null;
    return;
  }
  $('newForm').hidden = true; $('detailBody').hidden = false; $('replyForm').hidden = !canPost();
  // Messages are loaded the first time a thread is opened.
  const msgs = S.msgs.get(t.id);
  if (!msgs && !loading.has(t.id)) {
    loading.add(t.id);
    loadMessages(t.id).then(() => S.selected === t.id && renderDetail())
      .catch((err) => { $('replyError').textContent = `Couldn't load this delegation: ${err.message}`; })
      .finally(() => loading.delete(t.id));
  }
  const hops = t.hops || 0, max = S.config?.maxHops ?? 8;
  const live = workingIn(t.id);
  const isNew = renderedThread !== t.id;
  const timeline = $('detailBody').querySelector('.timeline');
  const keepScroll = !isNew && timeline && (timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight > 40);
  const prevTop = timeline?.scrollTop;

  $('detailBody').innerHTML = `
    <header class="detail-head">
      <button class="btn ghost back" type="button" data-action="back">${ICON.back} Delegations</button>
      <h2>${esc(t.title)}</h2>
      <div class="facts">
        <span class="pill ${t.status}">${t.status === 'queued' && t.waiting.length ? `Waiting on ${esc(t.waiting.map(display).join(', '))}`
          : t.status === 'owner' && t.waiting.length ? `Waiting on ${esc(t.waiting.map((id) => ownerOf(id) || display(id)).join(', '))}` : LABEL[t.status]}</span>
        <span><span class="who">${esc(senderName(t))}</span>${ownerOf(t.from) ? ` (${esc(ownerOf(t.from))})` : ''} to <span class="who">${esc(t.to.map(display).join(', ') || 'nobody')}</span>${t.to[0] && ownerOf(t.to[0]) ? ` (${esc(ownerOf(t.to[0]))})` : ''}</span>
        <span class="num">Started ${clock(t.started)}</span>
        <span class="num" title="Agent-to-agent replies used out of the hop limit">Hops ${hops} of ${max}</span>
      </div>
    </header>
    <div class="timeline" aria-live="polite">
      ${msgs ? '' : '<p class="loading">Loading…</p>'}
      ${(msgs || []).map((m, i) => {
        const a = m.fromKind === 'user' ? null : agentById(m.from);
        const name = senderName(m);
        const you = name === 'You';
        const enter = !isNew && i >= renderedCount ? ' enter' : '';
        return `<article class="msg ${m.kind || ''}${enter}">
          <div class="mono-av ${you ? 'you' : ''}" aria-hidden="true">${esc((name.replace('@', '')[0] || '?'))}</div>
          <div>
            <div class="msg-head"><span class="name">${esc(name)}</span>
              ${a ? `<span class="meta">${esc([ownerOf(a.id), BACKEND[a.backend] || a.backend].filter(Boolean).join(' · '))}</span>` : ''}
              ${m.to?.length ? `<span class="meta">to ${esc(m.to.map(display).join(', '))}</span>` : ''}
              <span class="meta num">${clock(m.ts)}</span></div>
            <div class="msg-body">${md(m.to?.length ? (stripLead(m.text) || m.text) : m.text)}</div>
            ${m.files?.length ? `<div class="files">${m.files.map((f) => `<button type="button" class="file" data-file="${esc(f.id)}" data-name="${esc(f.name)}" title="Download ${esc(f.name)}">${ICON.file}<span class="nm">${esc(f.name)}</span><span class="sz num">${size(f.size)}</span></button>`).join('')}</div>` : ''}
            ${m.note ? `<div class="notice">Stopped: this thread reached the hop limit (${max}). Send a new message to continue.</div>` : ''}
          </div>
        </article>`;
      }).join('')}
      ${live.map((l) => `<div class="live-line" role="status"><span class="dot busy" aria-hidden="true"></span>
        <span>${l.state === 'approval' ? `Waiting for ${esc(ownerOf(l.id) || '@' + l.id)} to approve` : `${esc(display(l.id))} is working`}</span>
        <span class="elapsed num mono" data-since="${l.since}">${elapsed(l.since)}</span></div>`).join('')}
    </div>`;
  const tl = $('detailBody').querySelector('.timeline');
  tl.scrollTop = keepScroll ? prevTop : tl.scrollHeight;
  if (msgs) { renderedThread = t.id; renderedCount = msgs.length; }
  updateReplyHint();
}

function defaultReplyTarget(t) {
  // Follow-ups go to the agent doing the work, not to a live session that asked.
  const worker = [...(S.msgs.get(t.id) || [])].reverse().find((m) => agentById(m.from)?.kind === 'agent');
  return worker?.from || t.to.find((id) => agentById(id)?.kind === 'agent') || t.to[0];
}
function updateReplyHint() {
  const t = S.selected && thread(S.selected);
  if (!t) return;
  const lead = (($('replyText').value.match(/^(\s*@[a-zA-Z][\w-]*)+/) || [''])[0].match(/@[a-zA-Z][\w-]*/g) || []).map((x) => x.slice(1).toLowerCase());
  const to = lead.length ? lead : [defaultReplyTarget(t)].filter(Boolean);
  $('replyHint').innerHTML = to.length ? `Goes to <b>${esc(to.map(display).join(', '))}</b> · start with @handle to redirect` : 'Start with @handle to address an agent';
}

function renderPicker() {
  const sel = S.composeTo || store.get('bc.lastTo', '');
  const list = S.agents.filter((a) => a.kind !== 'session').sort((a, b) => (b.online - a.online) || a.id.localeCompare(b.id));
  const legend = '<legend class="label">To</legend>';
  if (!list.length) {
    $('picker').innerHTML = legend + `<div class="empty" style="margin:0;padding:12px 0"><p>No agents can take requests yet. Make one reachable from <button class="btn ghost" type="button" data-goto="connect" style="height:auto;padding:0;color:var(--ink)">Connect</button>, then come back.</p></div>`;
    $('newSend').disabled = true;
    return;
  }
  const chosen = list.find((a) => a.id === sel) ? sel : (list.find((a) => a.online && a.state === 'idle') || list.find((a) => a.online) || list[0]).id;
  S.composeTo = chosen;
  $('newSend').disabled = false;
  $('picker').innerHTML = legend + list.map((a) => `
    <label class="pick">
      <input type="radio" name="to" value="${esc(a.id)}" ${a.id === chosen ? 'checked' : ''}>
      <span><span class="nm">@${esc(a.id)}</span> <span style="color:var(--ink-3)">${esc(ownerOf(a.id))}</span>
        <span class="sub">${esc(BACKEND[a.backend] || a.backend)}${a.repo ? ` in ${esc(a.repo)}` : ''} · ${a.access === 'write' ? 'can edit' : 'read-only'}</span></span>
      <span class="st"><span class="dot ${a.online ? (a.state !== 'idle' ? 'busy' : 'on') : ''}" aria-hidden="true"></span>${a.online ? (a.state === 'working' ? 'Busy' : 'Online') : 'Offline'}</span>
    </label>`).join('');
}
$('picker').addEventListener('change', (e) => { if (e.target.name === 'to') { S.composeTo = e.target.value; store.set('bc.lastTo', S.composeTo); } });

// Files picked for each composer, uploaded when the message is sent.
export const pending = { newForm: [], replyForm: [] };
const MAX_FILES = 20;
function addFiles(formId, list) {
  pending[formId].push(...[...list].filter((f) => f.size > 0));
  pending[formId] = pending[formId].slice(0, MAX_FILES);
  renderPending(formId);
}
export function renderPending(formId) {
  $(formId === 'newForm' ? 'newFiles' : 'replyFiles').innerHTML = pending[formId].map((f, i) =>
    `<button type="button" class="file" data-unattach="${formId}" data-i="${i}" title="Remove ${esc(f.name)}">${ICON.file}<span class="nm">${esc(f.name)}</span><span class="sz num">${size(f.size)} ✕</span></button>`).join('');
}
async function uploadFile(file) {
  const res = await fetch(`/api/teams/${encodeURIComponent(S.team)}/files?name=${encodeURIComponent(file.name)}`, {
    method: 'POST', body: file, headers: { 'content-type': file.type || 'application/octet-stream', authorization: `Bearer ${S.token}` } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${file.name}: ${body.error || `upload failed (${res.status})`}`);
  return body;
}
export async function downloadFile(id, name) {
  const res = await fetch(`/api/teams/${encodeURIComponent(S.team)}/files/${encodeURIComponent(id)}`, { headers: { authorization: `Bearer ${S.token}` } });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `download failed (${res.status})`);
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// A stand-in summary for a delegation just started, until the hub's arrives.
const summaryOf = (m) => ({ id: m.threadId, title: stripLead(m.text).slice(0, 80) || 'Untitled delegation', from: m.from, fromKind: m.fromKind,
  to: m.to || [], participants: [m.from, ...(m.to || [])], waitingOn: m.to || [], count: 1, started: m.ts, updated: m.ts, hops: 0, note: !!m.note });

async function submit(form, textEl, errEl, btn, body) {
  const files = pending[form.id];
  const text = textEl.value.trim() || (files.length ? `Attached ${files.map((f) => f.name).join(', ')}.` : '');
  errEl.textContent = '';
  if (!text) { errEl.textContent = 'Write a message first.'; textEl.focus(); return null; }
  btn.disabled = true;
  try {
    const uploaded = [];
    for (const f of files) uploaded.push(await uploadFile(f));
    const msg = await post('/messages', { ...body(text), ...(uploaded.length ? { files: uploaded.map((f) => f.id) } : {}) });
    textEl.value = ''; autosize(textEl);
    pending[form.id] = []; renderPending(form.id);
    if (msg.note) errEl.textContent = 'Not delivered: this delegation hit the hop limit. Raise it in Connect or start a new delegation.';
    return msg;
  } catch (err) {
    errEl.textContent = `Couldn't send: ${err.message}`;
    return null;
  } finally { btn.disabled = false; }
}

$('newForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const to = S.composeTo;
  if (!to) return;
  const msg = await submit($('newForm'), $('newText'), $('newError'), $('newSend'), (text) => ({ text: `@${to} ${text}` }));
  if (!msg) return;
  if (!S.msgs.has(msg.threadId)) S.msgs.set(msg.threadId, [msg]);
  // The summary usually arrives on the event stream first; fetch it if not.
  if (!S.threads.has(msg.threadId)) putThread(await tapi(`/threads/${encodeURIComponent(msg.threadId)}/summary`).catch(() => null) || summaryOf(msg));
  if (S.filter === 'done') S.filter = 'active';
  select(msg.threadId);
});

$('replyForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const t = thread(S.selected);
  if (!t) return;
  const raw = $('replyText').value.trim();
  const target = defaultReplyTarget(t);
  const msg = await submit($('replyForm'), $('replyText'), $('replyError'), $('replySend'),
    (text) => ({ threadId: t.id, text: /^@[a-zA-Z]/.test(raw) || !target ? text : `@${target} ${text}` }));
  if (msg) { addMessage(msg); renderDetail(); }
  updateReplyHint();
});

document.addEventListener('change', (e) => {
  const formId = e.target.dataset?.attach;
  if (!formId) return;
  addFiles(formId, e.target.files);
  e.target.value = '';
});
for (const formId of ['newForm', 'replyForm']) {
  const box = $(formId).querySelector('.field-box');
  box.addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); box.classList.add('drop'); } });
  box.addEventListener('dragleave', () => box.classList.remove('drop'));
  box.addEventListener('drop', (e) => { if (!e.dataTransfer?.files.length) return; e.preventDefault(); box.classList.remove('drop'); addFiles(formId, e.dataTransfer.files); });
}

function autosize(el) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 240) + 'px'; }
for (const el of [$('replyText'), $('newText')]) {
  el.addEventListener('input', () => { autosize(el); if (el === $('replyText')) updateReplyHint(); });
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); el.form.requestSubmit(); }
  });
}
