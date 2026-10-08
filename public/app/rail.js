// The left rail: navigation counts, who's on the network, the signed-in person and the connection.
import { S, ownerOf } from './state.js';
import { threads } from './threads.js';
import { $, ACTIVE, esc } from './util.js';

// ---------- render: rail ----------
export function renderRail() {
  document.querySelectorAll('.nav button').forEach((b) => b.setAttribute('aria-current', b.dataset.view === S.view ? 'page' : 'false'));
  const ts = threads();
  const active = ts.filter((t) => ACTIVE.has(t.status)).length;
  const working = ts.some((t) => t.status === 'working' || t.status === 'approval');
  $('countActive').textContent = active || '';
  $('countActive').className = 'count num' + (working ? ' live' : '');
  const online = S.agents.filter((a) => a.online).length;
  $('countOnline').textContent = S.agents.length ? `${online}/${S.agents.length}` : '';

  const list = [...S.agents].sort((a, b) => (b.online - a.online) || a.id.localeCompare(b.id));
  $('presence').innerHTML = list.length ? list.map((a) => {
    const busy = a.online && a.state !== 'idle';
    const label = !a.online ? 'offline' : a.state === 'working' ? 'working' : a.state === 'approval' ? 'waiting for approval' : 'online';
    return `<li class="${a.online ? '' : 'off'}" title="@${esc(a.id)}: ${label}" data-profile="${esc(a.id)}" role="button" tabindex="0">
      <span class="dot ${busy ? 'busy' : a.online ? 'on' : ''}" aria-hidden="true"></span>
      <span class="who">@${esc(a.id)}${ownerOf(a.id) ? ` <span>${esc(ownerOf(a.id))}</span>` : ''}</span><span class="sr-only">${label}</span></li>`;
  }).join('') : `<li class="empty-note">No agents yet. Connect one to start.</li>`;

  $('countMembers').textContent = S.members.length || '';
  $('teamSelect').innerHTML = S.teams.map((t) => `<option value="${esc(t.id)}" ${t.id === S.team ? 'selected' : ''}>${esc(t.name)}</option>`).join('')
    + '<option value="__new">New team…</option>';
  $('meWho').innerHTML = S.me ? `<b>${esc(S.me.user.name || S.me.user.handle)}</b><span>@${esc(S.me.user.handle)} · ${esc(S.role || '')}</span>` : '';
  $('hubDot').className = 'dot ' + (S.connected ? 'on' : '');
  $('hubState').textContent = S.connected ? 'Live' : 'Reconnecting…';
  $('hubAddr').textContent = location.host;
}
