// Agents: the table, profiles, the stand-in setting and disconnecting.
import { renderAll, setView } from './main.js';
import { S, agentById, canPost, display, isOwner, ownerOf, post, senderName, tapi } from './state.js';
import { withLive } from './threads.js';
import { $, BACKEND, ICON, LABEL, esc, glyph, rel } from './util.js';

// ---------- render: agents ----------
const canManage = (a) => isOwner() || !!(S.me && a.ownerUserId === S.me.user.id);
const agentStatus = (a) => (!a.online ? `Offline · seen ${a.lastSeen ? rel(a.lastSeen) : 'never'}` : a.state === 'working' ? 'Working' : a.state === 'approval' ? 'Waiting for approval' : 'Online');
const statusDot = (a) => `<span class="dot ${a.online ? (a.state !== 'idle' ? 'busy' : 'on') : ''}" aria-hidden="true"></span>`;
const isCoder = (a) => a.backend === 'claude-code' || a.backend === 'codex';
// A coding agent that edits files and runs commands for anyone in the team, without its owner approving each request.
const unguarded = (a) => (a.kind === 'session' ? a.standIn === 'write' && hasStandIn(a)
  : isCoder(a) && a.access === 'write' && a.approve === false);
// Live sessions answer on their own after a minute when their owner allows it. Clients before 0.4.0 can't.
function hasStandIn(a) {
  const [major = 0, minor = 0] = String(a.client || '').split('.').map(Number);
  return a.kind === 'session' && (major > 0 || minor >= 4);
}
const STAND_IN = { off: 'Off', read: 'Read-only', write: 'Read and write' };
function standInCell(a, mine) {
  const v = a.standIn || 'read';
  const who = esc(ownerOf(a.id) || 'its owner');
  const say = !hasStandIn(a) ? `Its Backchannel client is older than 0.4.0, so requests wait until ${who}’s agent checks its inbox.` : {
    off: `Requests wait until ${who}’s agent checks its inbox.`,
    read: 'If the session doesn’t pick a request up within a minute, a headless agent answers it from the project. It can’t change anything.',
    write: 'If the session doesn’t pick a request up within a minute, a headless agent answers it and may change files and run commands in the project, without asking.',
  }[v];
  const old = !hasStandIn(a) ? ' <span class="tag">needs client 0.4.0</span>' : '';
  if (!mine) return `<span class="tag ${v === 'write' ? 'warn' : ''}">${STAND_IN[v]}</span>${old} ${say}`;
  return `<label class="sr-only" for="standIn">Stand-in</label><select class="input" id="standIn" data-stand-in="${esc(a.id)}" style="width:auto">
    ${Object.entries(STAND_IN).map(([k, l]) => `<option value="${k}"${k === v ? ' selected' : ''}>${l}</option>`).join('')}</select>${old}
    <span>${say}</span>`;
}
const accessTag = (a) => (unguarded(a) ? '<span class="tag warn" title="Edits files and runs commands without its owner approving each request">Edits without approval</span>'
  : `<span class="tag ${a.access === 'write' ? 'write' : ''}">${a.access === 'write' ? 'Can edit' : 'Read-only'}</span>`);
const PLATFORM = { darwin: 'macOS', linux: 'Linux', win32: 'Windows' };

// Online agents are disconnected (their connector or session stops); offline ones are removed. Two clicks within 4s.
// The armed state lives in S, so the live re-renders don't reset it.
function disconnectButton(a) {
  if (!canManage(a)) return '';
  const verb = a.online ? 'Disconnect' : 'Remove';
  const armedNow = S.armed?.id === a.id;
  return `<button class="btn ghost danger" type="button" data-disconnect="${esc(a.id)}" data-armed="${armedNow ? '1' : ''}"
    title="${a.online ? 'Stop its connector or session and remove it from the team' : 'Remove it from the team'}">${armedNow ? `${verb} @${esc(a.id)}?` : verb}</button>`;
}
export async function disconnectAgent(btn) {
  const id = btn.dataset.disconnect;
  const a = agentById(id);
  if (!a) return;
  if (S.armed?.id !== id) {
    clearTimeout(S.armed?.timer);
    S.armed = { id, timer: setTimeout(() => { if (S.armed?.id === id) { S.armed = null; renderAgents(); } }, 4000) };
    return renderAgents();
  }
  clearTimeout(S.armed.timer); S.armed = null;
  btn.disabled = true; btn.textContent = a.online ? 'Disconnecting…' : 'Removing…';
  try {
    await tapi(`/agents/${encodeURIComponent(id)}`, { method: 'DELETE' });
    S.agents = S.agents.filter((x) => x.id !== id);
    if (S.profile === id) return setView('agents');
    renderAll();
  } catch (err) {
    btn.disabled = false; btn.dataset.armed = ''; btn.textContent = a.online ? "Couldn't disconnect" : "Couldn't remove";
    btn.title = err.message;
  }
}

// Re-rendering replaces the buttons; keep keyboard focus on the same one. preventScroll, because live updates re-render
// while you scroll: without it every agent coming or going would jump the table back to the last button you clicked.
function keepFocus(container, render) {
  const el = document.activeElement;
  const key = el && container.contains(el) && ['disconnect', 'delegate', 'profile', 'thread', 'card', 'action'].find((k) => el.dataset[k] !== undefined);
  render();
  if (key) container.querySelector(`[data-${key}="${CSS.escape(el.dataset[key])}"]`)?.focus({ preventScroll: true });
}

export function renderAgents() {
  keepFocus($('agentsBody'), () => (S.profile ? renderProfile() : renderAgentTable()));
}

function renderAgentTable() {
  const online = S.agents.filter((a) => a.online).length;
  $('agentsSummary').textContent = S.agents.length ? `${online} of ${S.agents.length} online` : '';
  if (!S.agents.length) {
    $('agentsBody').innerHTML = `<div class="empty" style="margin-top:12vh"><h3>No agents in this team yet</h3>
      <p>An agent appears here once its connector or session connects. It stays listed while offline, and across hub restarts, until you remove it.</p>
      <button class="btn primary" data-goto="connect">Connect an agent</button></div>`;
    return;
  }
  const list = [...S.agents].sort((a, b) => (b.online - a.online) || a.id.localeCompare(b.id));
  const repoLabel = (a) => (a.repos?.length ? a.repos.length === 1 ? a.repos[0].name : `${a.repos.length} repos` : a.repo || '');
  $('agentsBody').innerHTML = `<table>
    <thead><tr><th>Agent</th><th class="col-hide">Owner</th><th class="col-hide">Runs on</th><th class="col-hide">Access</th><th>Status</th><th class="col-hide"><span class="sr-only">Actions</span></th></tr></thead>
    <tbody>${list.map((a) => `<tr data-profile="${esc(a.id)}">
        <td><button class="link-h" type="button" data-profile="${esc(a.id)}" aria-label="Open @${esc(a.id)}'s profile">@${esc(a.id)}</button><div class="d" title="${esc(a.description)}">${esc(a.description)}</div></td>
        <td class="col-hide">${esc(ownerOf(a.id))}${a.ownerUserId && S.me && a.ownerUserId === S.me.user.id ? '<span class="you-tag">you</span>' : ''}</td>
        <td class="col-hide">${esc(BACKEND[a.backend] || a.backend)}${a.model ? ` <span class="mono" style="color:var(--ink-3)">${esc(a.model)}</span>` : ''}${a.kind === 'session' ? ' <span class="tag">live session</span>' : ''}</td>
        <td class="col-hide">${a.kind === 'session' ? `<span class="tag">asks others</span>${unguarded(a) ? ` ${accessTag(a)}` : ''}` : !isCoder(a) ? '<span class="tag">No files</span>' : accessTag(a)}${repoLabel(a) ? ` <span class="mono" style="color:var(--ink-3)">${esc(repoLabel(a))}</span>` : ''}</td>
        <td><span class="status-cell">${statusDot(a)}${agentStatus(a)}</span></td>
        <td class="col-hide"><div class="actions">
          ${a.kind !== 'session' && a.online && canPost() ? `<button class="btn" type="button" data-delegate="${esc(a.id)}">Delegate</button>` : ''}
          ${disconnectButton(a)}
        </div></td></tr>`).join('')}</tbody></table>`;
}

// A browsable https link for a git remote (git@host:org/repo.git, ssh://host/org/repo, https://host/org/repo.git), or null.
function remoteLink(remote) {
  if (!remote) return null;
  const m = /^git@([\w.-]+):(.+?)(?:\.git)?\/?$/.exec(remote) || /^(?:https|ssh|git):\/\/([\w.-]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/.exec(remote);
  return m ? `https://${m[1]}/${m[2]}` : null;
}

function renderProfile() {
  const a = agentById(S.profile);
  const back = `<button class="btn ghost back-link" type="button" data-goto="agents">${ICON.back} Agents</button>`;
  $('agentsSummary').textContent = '';
  if (!a) {
    $('agentsBody').innerHTML = `<div class="profile">${back}<div class="empty" style="margin:8vh 0 0;padding:0"><h3>@${esc(S.profile)} isn't in this team</h3>
      <p>It was disconnected or removed. It comes back when its owner starts it again.</p></div></div>`;
    return;
  }
  const owner = ownerOf(a.id);
  const mine = S.me && a.ownerUserId === S.me.user.id;
  const session = a.kind === 'session';
  const coder = isCoder(a);

  // Access
  const rows = [];
  rows.push(['Type', session
    ? `Live session · ${esc(owner || 'its owner')}’s ${esc(BACKEND[a.backend] || a.backend)} handles requests and delegates to others`
    : 'Connector · answers requests on its own, in its owner’s environment']);
  rows.push(['Runs', `${esc(BACKEND[a.backend] || a.backend)}${a.model ? ` <span class="mono" style="color:var(--ink-3)">${esc(a.model)}</span>` : ''}${!session && a.service ? ' <span class="tag" title="Runs as a background service on its owner’s computer">Always on</span>' : ''}`]);
  if (!session && coder && a.persistent) rows.push(['Memory', 'Keeps one conversation across requests, so it remembers code it read and earlier threads']);
  if (session) rows.push(['Files', `Whatever ${esc(owner || 'its owner')}’s session is allowed to touch. Their own ${esc(BACKEND[a.backend] || a.backend)} permissions apply.`]);
  if (session) rows.push(['Stand-in', standInCell(a, mine)]);
  else if (coder) rows.push(['Files', a.access === 'write' ? `${accessTag(a)} Reads and changes files in its repositories, and runs commands`
    : a.backend === 'codex' ? '<span class="tag">Read-only</span> Can’t change files. Codex’s read-only mode can also read files outside its repositories'
    : '<span class="tag">Read-only</span> Reads files in its repositories but can’t change them']);
  else rows.push(['Files', '<span class="tag">None</span> Answers from the model’s knowledge, without access to code']);
  if (!session && a.approve !== null && a.approve !== undefined) {
    rows.push(['Approval', a.approve ? `${esc(owner || 'Its owner')} approves each request before it runs`
      : unguarded(a) ? '<span class="tag warn">No approval</span> Anyone in the team can make it change files and run commands without asking its owner'
      : 'Handles requests without asking its owner']);
  }
  if (a.workdir) rows.push(['Folder', `<span class="mono">${esc(a.workdir)}</span>`]);

  // Repositories
  const repos = a.repos?.length ? a.repos : a.repo ? [{ name: a.repo }] : [];
  const repoList = repos.length ? `<ul class="repos">${repos.map((r) => {
    const link = remoteLink(r.remote);
    return `<li class="repo"><div class="top"><span class="nm">${esc(r.name)}</span>${r.branch ? `<span class="tag branch" title="Checked-out branch">${esc(r.branch)}</span>` : ''}
      ${!session && coder ? `<span class="tag ${a.access === 'write' ? 'write' : ''}">${a.access === 'write' ? 'can edit' : 'read-only'}</span>` : ''}</div>
      ${r.remote || r.path ? `<div class="meta">${r.remote ? (link ? `<a href="${esc(link)}" target="_blank" rel="noopener noreferrer">${esc(r.remote)}</a>` : `<span>${esc(r.remote)}</span>`) : ''}${r.path ? `<span>${esc(r.path)}</span>` : ''}</div>` : ''}</li>`;
  }).join('')}</ul>` : `<p class="note" style="margin:0">${session ? 'This session isn’t working in a git repository.' : coder ? 'No repository reported.' : 'None. This agent has no access to code.'}</p>`;
  const repoNotes = [
    session ? 'Live sessions share one handle, so this shows the most recently started session.' : '',
    a.repos?.length > 1 ? 'The folder holds several repositories; the agent can reach all of them.' : '',
    !a.repos && a.repo ? 'Its connector is on an older version. Restarting it with the current client adds the remote and branch.' : '',
  ].filter(Boolean);

  // Activity, from the hub. Fetched when the profile opens, and again after one of its delegations moves.
  const act = S.activity[a.id];
  if (!act) {
    // Written into this team's activity map, so a reply that lands after a team switch goes nowhere. A failure is kept
    // (and shown) rather than retried on every re-render; it's fetched again when one of the agent's delegations moves.
    const activity = S.activity;
    activity[a.id] = { loading: true };
    tapi(`/agents/${encodeURIComponent(a.id)}/activity`)
      .then((r) => { activity[a.id] = r; }, (err) => { activity[a.id] = { error: err.message }; })
      .then(() => S.activity === activity && S.profile === a.id && renderAgents());
  }
  const ready = act && !act.loading && !act.error;
  const stat = (v) => (ready ? v : '–');
  // Live status for the ones this browser has loaded; the hub's for the rest.
  const recent = ready ? act.threads.map((t) => withLive(S.threads.get(t.id) || t)) : [];

  // Connection
  const conn = [];
  if (a.host || a.platform) conn.push(['Computer', `${esc(a.host || 'Unknown')}${a.platform ? ` <span style="color:var(--ink-3)">${esc(PLATFORM[a.platform] || a.platform)}</span>` : ''}`]);
  conn.push(['Status', `<span class="status-cell">${statusDot(a)}${agentStatus(a)}</span>`]);
  if (a.connectedAt) conn.push(['Connected', `${new Date(a.connectedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`]);
  if (a.registeredAt) conn.push(['First joined', new Date(a.registeredAt).toLocaleDateString([], { dateStyle: 'medium' })]);
  if (a.client) conn.push(['Client', `<span class="mono">v${esc(a.client)}</span>`]);
  const kv = (list) => `<dl class="kv">${list.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`;

  $('agentsBody').innerHTML = `<div class="profile">${back}
    <header class="profile-head">
      <div class="ident">
        <h2>@${esc(a.id)}${a.name && a.name !== a.id ? `<small>${esc(a.name)}</small>` : ''}</h2>
        <div class="facts"><span class="status-cell">${statusDot(a)}${agentStatus(a)}</span>
          ${owner ? `<span>Owned by <span class="who">${esc(owner)}</span>${mine ? '<span class="you-tag">you</span>' : ''}</span>` : ''}
          ${session ? '<span class="tag">live session</span>' : ''}</div>
      </div>
      <div class="actions">
        ${!session && a.online && canPost() ? `<button class="btn" type="button" data-delegate="${esc(a.id)}">Delegate</button>` : ''}
        ${disconnectButton(a)}
      </div>
      ${a.description ? `<p class="desc">${esc(a.description)}</p>` : ''}
    </header>
    <section class="block"><h2>Access</h2>${kv(rows)}</section>
    <section class="block"><h2>Repositories</h2>${repoList}${repoNotes.map((n) => `<p class="note">${esc(n)}</p>`).join('')}</section>
    <section class="block"><h2>Activity</h2>
      <div class="stats">
        <div class="stat"><b>${stat(act?.received)}</b><span>Requests received</span></div>
        <div class="stat"><b>${stat(act?.replies)}</b><span>Replies sent</span></div>
        <div class="stat"><b>${stat(act?.started)}</b><span>Delegations started</span></div>
        <div class="stat"><b>${ready && act.lastMessageAt ? rel(act.lastMessageAt) : '–'}</b><span>Last message</span></div>
      </div>
      ${recent.length ? `<ul class="rows">${recent.map((t) => `<li><button class="row" type="button" data-thread="${esc(t.id)}">
        <span class="glyph">${glyph(t.status)}</span><span class="title">${esc(t.title)}</span><span class="time num">${rel(t.updated)}</span>
        <span class="route"><b>${esc(senderName(t))}</b> to <b>${esc((t.to.length ? t.to.map(display).join(', ') : 'nobody'))}</b></span>
        <span class="state ${t.status}">${LABEL[t.status]}</span></button></li>`).join('')}</ul>` : `<p class="note" style="margin:0">${ready ? 'No delegations yet.' : act?.error ? `Couldn’t load its activity: ${esc(act.error)}` : 'Loading…'}</p>`}
    </section>
    <section class="block"><h2>Connection</h2>${kv(conn)}
      ${a.online && canManage(a) ? `<p class="note">${a.kind === 'session' ? 'Disconnecting stops this session’s Backchannel connection. Starting a new session reconnects it.' : 'Disconnecting stops its connector and removes it from the team. Running the connect command again brings it back.'}</p>` : ''}
      <div style="margin-top:14px"><button class="btn ghost" type="button" data-card="${esc(a.id)}" style="margin-left:-8px">View agent card (JSON)</button></div>
    </section>
  </div>`;
}
$('agentsBody').addEventListener('change', async (e) => {
  const id = e.target.dataset.standIn;
  if (!id) return;
  e.target.disabled = true;
  try {
    const a = await post(`/agents/${encodeURIComponent(id)}`, { standIn: e.target.value }, 'PATCH');
    S.agents = S.agents.map((x) => (x.id === a.id ? a : x));
  } catch (err) { alert(`Couldn't change the stand-in: ${err.message}`); }
  renderAll();
});
