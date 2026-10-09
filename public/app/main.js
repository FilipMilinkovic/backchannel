// Entry point: error reporting, views and routing, the live event stream, global events, sign-in and boot.
import { disconnectAgent, renderAgents } from './agents.js';
import { buildMcp, createLoginCommand, renderConnect, rotateToken, setupCommand } from './connect.js';
import { downloadFile, pending, renderDetail, renderList, renderPending } from './delegations.js';
import { loadInvites, renderMembers } from './members.js';
import { renderRail } from './rail.js';
import { S, agentById, api, canPost, tapi } from './state.js';
import { addMessage, loadMessages, loadOlder, loadThreads, putThread } from './threads.js';
import { $, elapsed, esc, store } from './util.js';

// Unexpected errors go to the hub's log (and Sentry, if it's set up). At most five per page load; codes are stripped from the URL.
let errorsSent = 0;
function reportError(e) {
  if (errorsSent++ >= 5) return;
  const err = e.reason || e.error || {};
  fetch('/api/client-errors', { method: 'POST', keepalive: true, headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: String(err.message || e.message || err).slice(0, 1000), name: err.name, stack: String(err.stack || '').slice(0, 8000),
      url: location.origin + location.pathname + location.hash.replace(/(join|login)\/[\w-]+/, '$1/…') }) }).catch(() => {});
}
addEventListener('error', reportError);
addEventListener('unhandledrejection', reportError);
// ---------- orchestration ----------
export function renderAll() {
  renderRail();
  if (S.view === 'delegations') { renderList(); renderDetail(); }
  if (S.view === 'agents') renderAgents();
  if (S.view === 'members') renderMembers();
  if (S.view === 'connect') renderConnect();
}
// Two-step confirm used by destructive buttons: first click arms, second click (within 4s) acts.
export function armed(btn, label) {
  if (btn.dataset.armed === '1') return true;
  const orig = btn.textContent;
  btn.dataset.armed = '1'; btn.textContent = label;
  setTimeout(() => { if (btn.isConnected && btn.dataset.armed === '1') { btn.dataset.armed = ''; btn.textContent = orig; } }, 4000);
  return false;
}

// `profile`: an agent id, to show that agent's profile in the Agents view (#agents/<id>).
export function setView(v, profile = null) {
  if (!['delegations', 'agents', 'members', 'connect'].includes(v)) v = 'delegations';
  const changed = S.view !== v || S.profile !== (v === 'agents' ? profile : null);
  S.view = v; S.profile = v === 'agents' ? profile : null;
  if (v === 'members') loadInvites().then(() => S.view === 'members' && renderMembers());
  document.querySelectorAll('.view').forEach((el) => el.classList.toggle('active', el.id === `view-${v}`));
  const hash = S.profile ? `agents/${encodeURIComponent(S.profile)}` : v;
  // Opening a profile adds a history entry, so the browser's Back returns to the list.
  if (location.hash !== '#' + hash) history[S.profile ? 'pushState' : 'replaceState'](null, '', '#' + hash);
  renderAll();
  if (changed && v === 'agents') $('agentsBody').scrollTop = 0;
}
// "#agents/steve" -> ['agents', 'steve']; "#members" -> ['members', null].
const parseHash = (h) => { const [v, id] = h.split('/'); return [v, v === 'agents' && id ? decodeURIComponent(id) : null]; };

export function select(id, { focusReply = false } = {}) {
  S.selected = id; S.composing = !id; S.mobileDetail = true;
  renderList(); renderDetail();
  if (focusReply && id) $('replyText').focus();
}

function startNew(to) {
  if (to) S.composeTo = to;
  S.selected = null; S.composing = true; S.mobileDetail = true;
  setView('delegations');
  $('newText').focus();
}

// ---------- events ----------
let es = null;
// After a reconnect: fresh summaries, and the open thread's messages again.
async function catchUp(team) {
  try {
    if (!(await loadThreads(team))) return;
    if (S.selected) await loadMessages(S.selected, { force: true });
    renderAll();
  } catch {}
}
export function connect() {
  if (es) es.close();
  const team = S.team;
  let helloSeen = false;
  es = new EventSource(`/api/teams/${encodeURIComponent(team)}/events?token=${encodeURIComponent(S.token)}`);
  es.onopen = () => { S.connected = true; renderRail(); };
  es.onerror = () => { S.connected = false; renderRail(); };
  es.onmessage = (e) => {
    const ev = JSON.parse(e.data);
    if (team !== S.team) return;
    if (ev.type === 'hello') {
      // After a reconnect (network blip, hub restart), catch up on what changed while we were away.
      if (helloSeen) catchUp(team);
      helloSeen = true;
      if (ev.agents) S.agents = ev.agents;
      if (ev.config) S.config = { ...S.config, ...ev.config };
      if (ev.members) S.members = ev.members;
      if (ev.role && ev.role !== S.role) { S.role = ev.role; const t = S.teams.find((x) => x.id === team); if (t) t.role = ev.role; loadInvites().then(renderAll); }
    }
    if (ev.type === 'members') {
      if (ev.members) S.members = ev.members;
      const mine = S.members.find((m) => S.me && m.userId === S.me.user.id);
      if (!mine) { refreshAccount(); return; } // removed from this team
      if (mine.role !== S.role) { S.role = mine.role; loadInvites().then(renderAll); }
    }
    if (ev.type === 'agents') S.agents = ev.agents;
    if (ev.type === 'config') S.config = { ...S.config, ...ev.config };
    if (ev.type === 'status') {
      if (ev.state === 'idle') delete S.live[ev.id];
      else S.live[ev.id] = { state: ev.state, threadId: ev.threadId, since: S.live[ev.id]?.state === ev.state ? S.live[ev.id].since : Date.now() };
      const a = agentById(ev.id); if (a) a.state = ev.state;
    }
    if (ev.type === 'message') addMessage(ev.message);
    if (ev.type === 'thread') {
      putThread(ev.thread);
      if (ev.thread.id !== S.selected) S.fresh.add(ev.thread.id);
      // An open profile's activity is out of date once one of its delegations moves.
      if (S.profile && ev.thread.participants?.includes(S.profile)) delete S.activity[S.profile];
    }
    renderAll();
  };
}

document.addEventListener('click', async (e) => {
  const t = e.target.closest('button, [data-id], [data-profile], a');
  if (!t) return;
  if (t.dataset.view) return setView(t.dataset.view);
  if (t.dataset.file) return downloadFile(t.dataset.file, t.dataset.name).catch((err) => { $('replyError').textContent = `Couldn't download ${t.dataset.name}: ${err.message}`; });
  if (t.dataset.unattach) { pending[t.dataset.unattach].splice(Number(t.dataset.i), 1); return renderPending(t.dataset.unattach); }
  if (t.dataset.goto) return setView(t.dataset.goto);
  if (t.dataset.filter) { S.filter = t.dataset.filter; store.set('bc.filter', S.filter); return renderList(); }
  if (t.dataset.action === 'new' || t.id === 'newBtn') return startNew();
  if (t.dataset.action === 'older') {
    t.disabled = true; t.textContent = 'Loading…';
    try { await loadOlder(); } catch (err) { t.disabled = false; t.textContent = `Couldn't load more: ${err.message}`; return; }
    return renderList();
  }
  if (t.dataset.action === 'back') { S.mobileDetail = false; S.selected = null; S.composing = true; renderList(); return renderDetail(); }
  if (t.dataset.delegate) return startNew(t.dataset.delegate);
  if (t.dataset.disconnect) return disconnectAgent(t);
  if (t.dataset.profile) return setView('agents', t.dataset.profile);
  if (t.dataset.thread) { setView('delegations'); return select(t.dataset.thread); }
  if (t.dataset.action === 'signout') return signOut();
  if (t.dataset.action === 'reveal') { S.tokenRevealed = !S.tokenRevealed; return renderConnect(); }
  if (t.dataset.action === 'copy-token') return copy(t, S.token);
  if (t.dataset.action === 'rotate') return rotateToken(t);
  if (t.dataset.action === 'login-link') return createLoginCommand(t);
  if (t.dataset.card) return showCard(t.dataset.card);
  if (t.dataset.copyInvite) return copy(t, t.dataset.copyInvite);
  if (t.dataset.revoke) {
    if (!armed(t, 'Revoke?')) return;
    try { await tapi(`/invites/${encodeURIComponent(t.dataset.revoke)}`, { method: 'DELETE' }); await loadInvites(); renderMembers(); }
    catch (err) { t.textContent = "Couldn't revoke"; t.title = err.message; }
    return;
  }
  if (t.dataset.removeMember) {
    const self = t.dataset.self === '1';
    if (!armed(t, self ? 'Leave? Your agents here go too' : 'Remove? Their agents go too')) return;
    try {
      await tapi(`/members/${encodeURIComponent(t.dataset.removeMember)}`, { method: 'DELETE' });
      if (self) return refreshAccount();
      S.members = await tapi('/members'); renderAll();
    } catch (err) { t.textContent = "Couldn't remove"; t.title = err.message; }
    return;
  }
  if (t.dataset.tool) { S.mcpTool = t.dataset.tool; store.set('bc.tool', S.mcpTool); return buildMcp(); }
  if (t.dataset.copy) { const el = $(t.dataset.copy); return copy(t, el.dataset.copyText || el.textContent); }
  if (t.classList.contains('row')) return select(t.dataset.id);
});

async function copy(btn, text) {
  const orig = btn.dataset.label || btn.textContent;
  btn.dataset.label = orig;
  try { await navigator.clipboard.writeText(text); btn.textContent = 'Copied'; }
  catch { btn.textContent = 'Copy failed'; }
  setTimeout(() => (btn.textContent = orig), 1600);
}

async function showCard(id) {
  try {
    const card = await tapi(`/agents/${encodeURIComponent(id)}/card`);
    const w = window.open('', '_blank');
    if (w) { w.document.title = `@${id} agent card`; w.document.body.style.cssText = 'background:#111;color:#ddd;font:13px/1.6 ui-monospace,monospace;padding:24px;white-space:pre-wrap'; w.document.body.textContent = JSON.stringify(card, null, 2); }
  } catch (err) { alert(`Couldn't load the card: ${err.message}`); }
}
$('teamSelect').addEventListener('change', (e) => {
  if (e.target.value === '__new') { e.target.value = S.team; return showGate('newteam'); }
  switchTeam(e.target.value);
});
// keyboard: N new · J/K move · Esc back · 1-4 views
document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('li[data-profile]')) { e.preventDefault(); return setView('agents', e.target.dataset.profile); }
  if (e.key === 'Escape' && !typing && S.profile) return setView('agents');
  if (e.key === 'Escape') { if (typing) document.activeElement.blur(); else if (S.view === 'delegations') { S.selected = null; S.composing = true; S.mobileDetail = false; renderList(); renderDetail(); } return; }
  if (typing) return;
  if ((e.key === 'n' || e.key === 'N') && canPost() && !$('app').hidden) { e.preventDefault(); return startNew(); }
  if (['1', '2', '3', '4'].includes(e.key)) return setView(['delegations', 'agents', 'members', 'connect'][Number(e.key) - 1]);
  if ((e.key === 'j' || e.key === 'k') && S.view === 'delegations') {
    const ids = [...document.querySelectorAll('#rows .row')].map((r) => r.dataset.id);
    if (!ids.length) return;
    const i = ids.indexOf(S.selected);
    const next = e.key === 'j' ? Math.min(ids.length - 1, i + 1) : Math.max(0, i === -1 ? 0 : i - 1);
    select(ids[next]);
    document.querySelector(`#rows .row[data-id="${ids[next]}"]`)?.scrollIntoView({ block: 'nearest' });
  }
});

// tick: live timers and relative times
setInterval(() => {
  document.querySelectorAll('[data-since]').forEach((el) => (el.textContent = elapsed(Number(el.dataset.since))));
}, 1000);
setInterval(() => { if (S.view === 'delegations') renderList(); }, 30000);

// ---------- gate: sign in, join, create team ----------
const BRAND = document.querySelector('.brand').outerHTML;
function gate(html) {
  $('app').hidden = true;
  $('gate').hidden = false;
  $('gate').innerHTML = `<div class="gate-card">${BRAND}${html}</div>`;
  $('gate').querySelector('input')?.focus();
}
function showGate(kind, note = '') {
  if (es) { es.close(); es = null; }
  if (kind === 'signin') {
    gate(`<h1>Sign in</h1>
      <p>${note ? esc(note) : 'Paste your access token. Easier: run <span class="mono">backchannel open</span> on your computer and this page opens signed in. New here? Open the invite link a teammate sent you.'}</p>
      <form id="signinForm"><div><label class="label" for="tokenIn">Access token</label>
        <input class="input mono" id="tokenIn" type="password" autocomplete="off" spellcheck="false" placeholder="bc_…" required></div>
        <div class="form-error" id="gateError" role="alert"></div>
        <button class="btn primary" type="submit">Sign in</button></form>`);
    $('signinForm').onsubmit = async (e) => {
      e.preventDefault();
      S.token = $('tokenIn').value.trim();
      try { await refreshAccount(true); }
      catch (err) { S.token = ''; $('gateError').textContent = err.status === 401 ? "That token isn't valid on this hub." : `Couldn't sign in: ${err.message}`; }
    };
  } else if (kind === 'down') {
    gate(`<h1>Can't reach the hub</h1><p>${esc(note)}. Check that <span class="mono">node hub.js</span> is running, then retry.</p>
      <button class="btn primary" type="button" id="retryBtn">Retry</button>`);
    $('retryBtn').onclick = () => boot();
  } else if (kind === 'noteam' || kind === 'newteam') {
    gate(`<h1>${kind === 'noteam' ? "You're not in a team yet" : 'New team'}</h1>
      <p>${kind === 'noteam' ? 'Ask a teammate for an invite link, or start your own team and invite them.' : 'A team is one project: its own agents, delegations, members and settings. You’ll be its owner.'}</p>
      <form id="teamForm"><div><label class="label" for="teamName">Team name</label><input class="input" id="teamName" required maxlength="60" placeholder="Payments revamp"></div>
        <div class="form-error" id="gateError" role="alert"></div>
        <button class="btn primary" type="submit">Create team</button></form>
      ${kind === 'newteam' ? '<div class="alt"><button type="button" id="cancelGate">Cancel</button></div>' : `<div class="alt">Wrong account? <button type="button" id="gateSignout">Sign out</button></div>`}`);
    $('teamForm').onsubmit = async (e) => {
      e.preventDefault();
      try { const { team } = await api('/api/teams', { method: 'POST', body: JSON.stringify({ name: $('teamName').value.trim() }) }); store.set('bc.team', team.id); await refreshAccount(); }
      catch (err) { $('gateError').textContent = `Couldn't create the team: ${err.message}`; }
    };
    if ($('cancelGate')) $('cancelGate').onclick = () => { $('gate').hidden = true; $('app').hidden = false; connect(); };
    if ($('gateSignout')) $('gateSignout').onclick = () => signOut();
  }
}

async function showJoin(code) {
  // A token this hub no longer accepts (rotated, revoked, or from an earlier hub at this address) would make the
  // invite calls fail, so drop it and join as a new account.
  let me = null;
  if (S.token) {
    try { me = await api('/api/me'); }
    catch (err) { if (err.status === 401) { S.token = ''; store.set('bc.token', ''); } }
  }
  let info;
  try { info = await api(`/api/invites/${encodeURIComponent(code)}`); }
  catch (err) {
    return gate(`<h1>This invite doesn't work</h1><p>${err.status === 404 ? 'The link is invalid, expired or already used. Ask for a new one.' : esc(err.message)}</p>
      <button class="btn primary" type="button" id="toApp">Continue</button>`), ($('toApp').onclick = () => { history.replaceState(null, '', '#'); boot(); });
  }
  const head = `<h1>Join ${esc(info.teamName)}</h1>
    <p>${info.invitedBy ? `${esc(info.invitedBy)} invited you` : 'You’re invited'} as a <b style="color:var(--ink-2)">${esc(info.role)}</b>. You'll be able to ${info.role === 'viewer' ? 'follow the team’s delegations' : 'delegate to teammates’ agents and connect your own'}.</p>`;
  if (me) {
    gate(`${head}<form id="joinForm"><div class="form-error" id="gateError" role="alert"></div>
      <button class="btn primary" type="submit">Join as @${esc(me.user.handle)}</button></form>
      <div class="alt">Not you? <button type="button" id="otherAcct">Use a different account</button></div>`);
    $('otherAcct').onclick = () => { S.token = ''; store.set('bc.token', ''); showJoin(code); };
  } else {
    gate(`${head}<form id="joinForm">
      <div><label class="label" for="jName">Your name</label><input class="input" id="jName" required maxlength="60" autocomplete="name" placeholder="Maya Chen"></div>
      <div><label class="label" for="jHandle">Handle</label><input class="input mono" id="jHandle" required maxlength="32" pattern="[a-z][a-z0-9_\\-]{0,31}" autocomplete="username" spellcheck="false" placeholder="maya">
        <div class="help">How teammates mention you. Lowercase letters, numbers, - and _.</div></div>
      <div class="form-error" id="gateError" role="alert"></div>
      <button class="btn primary" type="submit">Create account and join</button></form>
      <div class="alt">Already have an account? <button type="button" id="haveToken">Sign in first</button></div>`);
    $('jName').oninput = () => { if (!$('jHandle').dataset.touched) $('jHandle').value = $('jName').value.toLowerCase().split(/\s+/)[0].replace(/[^a-z0-9_-]/g, ''); };
    $('jHandle').oninput = () => { $('jHandle').dataset.touched = '1'; };
    $('haveToken').onclick = () => showGate('signin', 'Sign in, then open the invite link again to join.');
  }
  $('joinForm').onsubmit = async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      const res = await api(`/api/invites/${encodeURIComponent(code)}/accept`, { method: 'POST',
        body: JSON.stringify(me ? {} : { handle: $('jHandle').value.trim().toLowerCase(), name: $('jName').value.trim() }) });
      store.set('bc.team', res.team.id);
      history.replaceState(null, '', '#delegations');
      if (res.token) {
        S.token = res.token; store.set('bc.token', res.token);
        gate(`<h1>You're in, @${esc(res.user.handle)}</h1>
          <p>Now set up the computer you code on. Run this in a terminal: it installs the <span class="mono">backchannel</span> command, signs the computer in as you, and connects Claude Code and Codex. Needs Node.js 22.13 or newer.</p>
          <div class="code"><pre id="joinCmd">Creating your setup command…</pre><button class="btn" type="button" data-copy="joinCmd">Copy</button></div>
          <div class="help" id="joinMsg" role="status"></div>
          <ol class="next-steps">
            <li>Restart open Claude Code and Codex sessions. Then just ask, like <i>“ask Sam’s agent how refunds work”</i>.</li>
            <li>To let teammates’ agents ask yours, run <span class="mono">backchannel connect</span> in your repo. It asks you before each request.</li>
          </ol>
          <details class="manual"><summary>Access token for scripts and CI</summary>
            <p class="help">You won't need it for the steps above. Anyone with it can act as you; you can see it again under Connect, in this browser.</p>
            <div class="token-box"><code id="newToken">${esc(res.token)}</code><button class="btn" type="button" id="copyNew">Copy</button></div></details>
          <div style="margin-top:18px"><button class="btn primary" type="button" id="toApp" style="width:100%;justify-content:center">Continue to ${esc(res.team.name)}</button></div>`);
        $('copyNew').onclick = (ev) => copy(ev.currentTarget, res.token);
        $('toApp').onclick = () => refreshAccount();
        setupCommand().then(({ cmd, until }) => { $('joinCmd').textContent = cmd; $('joinMsg').textContent = `Works once, until ${until}. Need it later or on another computer? Connect → Create setup command.`; })
          .catch((err) => { $('joinCmd').textContent = '—'; $('joinMsg').textContent = `Couldn't create it (${err.message}). Continue, then use Connect → Create setup command.`; });
      } else {
        await refreshAccount();
      }
    } catch (err) {
      btn.disabled = false;
      $('gateError').textContent = err.status === 409 ? 'That handle is taken. Pick another.' : `Couldn't join: ${err.message}`;
    }
  };
}

export function signOut(note) {
  // Revoke this browser's session on the hub (a main token is left alone; rotate it from Connect).
  if (S.token) fetch('/api/me/logout', { method: 'POST', headers: { authorization: `Bearer ${S.token}` } }).catch(() => {});
  S.token = ''; S.me = null; store.set('bc.token', '');
  showGate('signin', note);
}

// Loads the account and teams, then opens the chosen team.
async function refreshAccount(fromSignin = false) {
  const me = await api('/api/me');
  if (fromSignin) store.set('bc.token', S.token);
  S.me = me; S.teams = me.teams;
  if (!me.teams.length) return showGate('noteam');
  const want = store.get('bc.team', '');
  await switchTeam(me.teams.some((t) => t.id === want) ? want : me.teams[0].id);
}

async function switchTeam(teamId) {
  S.team = teamId; store.set('bc.team', teamId);
  S.role = S.teams.find((t) => t.id === teamId)?.role || null;
  Object.assign(S, { agents: [], members: [], invites: [], live: {}, selected: null, composing: true, config: null,
    threads: new Map(), msgs: new Map(), counts: null, olderCursor: undefined, activity: {} });
  const [team, agents, members] = await Promise.all([tapi(''), tapi('/agents'), tapi('/members'), loadThreads(teamId)]);
  S.config = team; S.role = team.role || S.role; S.agents = agents; S.members = members;
  for (const a of agents) if (a.state && a.state !== 'idle') S.live[a.id] = { state: a.state, threadId: a.stateThread, since: Date.now() };
  await loadInvites();
  $('gate').hidden = true; $('app').hidden = false;
  const [v, profile] = parseHash(location.hash.slice(1));
  setView(['delegations', 'agents', 'members', 'connect'].includes(v) ? v : 'delegations', profile);
  connect();
}

async function boot() {
  const join = location.hash.match(/^#join\/([\w-]+)/);
  if (join) return showJoin(join[1]);
  // One-time sign-in link from `backchannel open`: trade it for this browser's own session token.
  const login = location.hash.match(/^#login\/([a-f0-9]+)(?:&view=(\w+))?/);
  if (login) {
    history.replaceState(null, '', '#' + (login[2] || 'delegations'));
    try {
      const res = await api(`/api/login/${login[1]}`, { method: 'POST', body: JSON.stringify({ label: navigator.platform ? `browser on ${navigator.platform}` : 'browser' }) });
      S.token = res.token; store.set('bc.token', res.token);
    } catch (err) {
      return showGate('signin', err.status === 404 ? 'That sign-in link expired or was already used. Run backchannel open again.' : `Couldn't sign in: ${err.message}`);
    }
  }
  if (!S.token) return showGate('signin');
  try { await refreshAccount(); }
  catch (err) {
    if (err.status === 401) return signOut('That access token no longer works. Sign in again.');
    showGate('down', err.message);
  }
}

(() => {
  try {
    const c = JSON.parse(store.get('bc.connector', '{}'));
    if (c.b) { $('cHandle').value = c.h || ''; $('cOwner').value = c.o || ''; $('cBackend').value = c.b; $('cFolder').value = c.f || ''; $('cWrite').checked = !!c.w; $('cApprove').checked = c.a !== false; $('cService').checked = !!c.s; }
    const m = JSON.parse(store.get('bc.mcp', '{}'));
    $('mHandle').value = m.h || ''; $('mOwner').value = m.o || '';
  } catch {}
  window.addEventListener('hashchange', () => {
    const h = location.hash.slice(1);
    if (h.startsWith('join/') || h.startsWith('login/')) return boot();
    const [v, profile] = parseHash(h);
    if ((v !== S.view || profile !== S.profile) && ['delegations', 'agents', 'members', 'connect'].includes(v) && !$('app').hidden) setView(v, profile);
  });
  boot();
})();
