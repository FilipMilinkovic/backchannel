// Members: roles, removing people, and invite links.
import { renderAll } from './main.js';
import { S, isOwner, post, tapi } from './state.js';
import { $, esc } from './util.js';

// ---------- render: members ----------
export function renderMembers() {
  const owners = S.members.filter((m) => m.role === 'owner').length;
  $('membersSummary').textContent = `${S.members.length} ${S.members.length === 1 ? 'person' : 'people'}`;
  $('membersBody').innerHTML = `<table>
    <thead><tr><th>Name</th><th class="col-hide">Handle</th><th>Role</th><th class="col-hide">Agents</th><th class="col-hide">Joined</th><th><span class="sr-only">Actions</span></th></tr></thead>
    <tbody>${S.members.map((m) => {
      const self = S.me && m.userId === S.me.user.id;
      const lastOwner = m.role === 'owner' && owners === 1;
      const agents = S.agents.filter((a) => a.ownerUserId === m.userId).map((a) => '@' + a.id);
      const role = isOwner() && !lastOwner
        ? `<label class="sr-only" for="role-${esc(m.userId)}">Role for ${esc(m.name)}</label><select class="input" id="role-${esc(m.userId)}" data-role-for="${esc(m.userId)}">
            ${['owner', 'member', 'viewer'].map((r) => `<option value="${r}" ${r === m.role ? 'selected' : ''}>${r[0].toUpperCase() + r.slice(1)}</option>`).join('')}</select>`
        : `<span class="tag">${esc(m.role[0].toUpperCase() + m.role.slice(1))}</span>${lastOwner ? '<span class="help" style="margin:0 0 0 8px">Last owner</span>' : ''}`;
      const action = self
        ? (lastOwner ? '' : `<button class="btn ghost danger" data-remove-member="${esc(m.userId)}" data-self="1">Leave team</button>`)
        : (isOwner() && !lastOwner ? `<button class="btn ghost danger" data-remove-member="${esc(m.userId)}">Remove</button>` : '');
      return `<tr>
        <td><div class="h">${esc(m.name || m.handle)}${self ? '<span class="you-tag">you</span>' : ''}</div></td>
        <td class="col-hide mono">@${esc(m.handle)}</td>
        <td>${role}</td>
        <td class="col-hide">${agents.length ? esc(agents.join(', ')) : '<span style="color:var(--ink-3)">None</span>'}</td>
        <td class="col-hide num">${m.joinedAt ? new Date(m.joinedAt).toLocaleDateString() : ''}</td>
        <td><div class="actions">${action}</div></td></tr>`;
    }).join('')}</tbody></table>`;

  $('inviteForm').hidden = !isOwner();
  $('inviteLede').textContent = isOwner()
    ? 'Send someone a link. They pick a handle, get their own access token, and can connect their agents to this team.'
    : 'Only owners can invite people. Ask an owner for a link.';
  if (!isOwner()) { $('invitesList').innerHTML = ''; return; }
  const active = S.invites.filter((i) => i.expiresAt > Date.now() && i.usesLeft > 0);
  $('invitesList').innerHTML = active.length ? `<div class="code-label"><span>Active invites</span></div><table><tbody>${active.map((i) => `<tr>
      <td><span class="tag">${esc(i.role)}</span></td>
      <td class="num">${i.usesLeft} use${i.usesLeft === 1 ? '' : 's'} left</td>
      <td class="num col-hide">Expires ${new Date(i.expiresAt).toLocaleDateString()}</td>
      <td><div class="actions"><button class="btn ghost" data-copy-invite="${esc(i.url || inviteUrl(i.code))}">Copy link</button>
        <button class="btn ghost danger" data-revoke="${esc(i.code)}">Revoke</button></div></td></tr>`).join('')}</tbody></table>` : '';
}
const inviteUrl = (code) => `${location.origin}/#join/${code}`;

export async function loadInvites() {
  if (!isOwner()) { S.invites = []; return; }
  try { S.invites = await tapi('/invites'); } catch { S.invites = []; }
}
$('membersBody').addEventListener('change', async (e) => {
  const userId = e.target.dataset.roleFor;
  if (!userId) return;
  e.target.disabled = true;
  try { await post(`/members/${encodeURIComponent(userId)}`, { role: e.target.value }, 'PATCH'); S.members = await tapi('/members'); }
  catch (err) { alert(`Couldn't change the role: ${err.message}`); }
  renderAll();
});

$('inviteForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('iError').textContent = ''; $('iCreate').disabled = true;
  try {
    const inv = await post('/invites', { role: $('iRole').value, uses: Number($('iUses').value) || 1, expiresInHours: Number($('iExpiry').value) });
    $('newLinkUrl').textContent = inv.url || inviteUrl(inv.code);
    $('newLink').hidden = false;
    await loadInvites(); renderMembers();
  } catch (err) { $('iError').textContent = `Couldn't create the invite: ${err.message}`; }
  finally { $('iCreate').disabled = false; }
});
