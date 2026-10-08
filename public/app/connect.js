// Connect: hub settings, the setup command, connector and MCP commands, and the access token.
import { armed, connect } from './main.js';
import { S, api, isOwner, post } from './state.js';
import { $, store } from './util.js';

// ---------- render: connect ----------
const shq = (s) => /^[\w@%+=:,./~-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`;
const masked = () => (S.token ? `${S.token.slice(0, 7)}…${S.token.slice(-4)}` : '');
S.tokenRevealed = false;
const setCmd = (id, text) => { $(id).textContent = text; };
// Only needed when you're in several teams; otherwise the CLI picks your one team.
const teamArg = (flag) => (S.teams.length > 1 ? flag(S.team) : '');

// One command that installs the client from this hub and signs the computer in with a one-time link.
export async function setupCommand() {
  const { url, expiresInSeconds } = await api('/api/me/login-link', { method: 'POST', body: JSON.stringify({ expiresInSeconds: 600 }) });
  const until = new Date(Date.now() + expiresInSeconds * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return { cmd: `npm install -g ${location.origin}/install/backchannel.tgz && \\\n  backchannel login '${url}'`, until };
}
export async function createLoginCommand(btn) {
  btn.disabled = true;
  try {
    const { cmd, until } = await setupCommand();
    setCmd('loginCmd', cmd);
    $('loginBox').hidden = false; $('setupNote').hidden = false;
    btn.textContent = 'Create another'; btn.classList.remove('primary');
    $('loginMsg').textContent = `Works once, until ${until}. Each computer gets its own sign-in.`;
  } catch (err) { $('loginMsg').textContent = `Couldn't create it: ${err.message}`; }
  finally { btn.disabled = false; }
}
export function renderConnect() {
  const c = S.config;
  if (!c) return;
  $('cfgAddr').textContent = location.origin;
  $('cfgTeam').textContent = c.name || '';
  $('cfgTeamId').textContent = S.team;
  if (document.activeElement !== $('hopsInput')) $('hopsInput').value = c.maxHops;
  $('hopsInput').disabled = !isOwner(); $('hopsSave').hidden = !isOwner(); $('hopsOwnerOnly').hidden = isOwner();
  $('tokenShown').textContent = S.tokenRevealed ? S.token : masked();
  $('revealBtn').textContent = S.tokenRevealed ? 'Hide' : 'Show';
  buildConnector(); buildMcp();
}

function buildConnector() {
  const backend = $('cBackend').value;
  const coder = backend === 'claude-code' || backend === 'codex';
  $('cFolderWrap').hidden = !coder;
  $('cWrite').disabled = !coder;
  const suffix = backend === 'claude-code' ? 'claude' : backend;
  if (S.me) { $('cHandle').placeholder = `${S.me.user.handle.slice(0, 31 - suffix.length)}-${suffix}`; $('cOwner').placeholder = S.me.user.name || S.me.user.handle; }
  const raw = $('cHandle').value.trim();
  const handle = raw.toLowerCase() || $('cHandle').placeholder;
  const valid = !raw || /^[a-z][a-z0-9_-]{0,31}$/.test(raw);
  $('cHandle').setAttribute('aria-invalid', String(!valid));
  $('cHandleHelp').textContent = valid ? 'Lowercase letters, numbers and dashes.' : 'Start with a letter; use only lowercase letters, numbers, - and _.';
  $('cHandleHelp').style.color = valid ? '' : 'var(--danger)';
  const env = [];
  if (backend === 'openai') env.push('OPENAI_API_KEY=sk-…');
  if (backend === 'grok') env.push('XAI_API_KEY=xai-…');
  // The connector defaults to @<you>-claude on Claude Code, so only spell out what differs.
  const args = [...(raw ? [`--id ${shq(handle)}`] : []), ...(backend === 'claude-code' ? [] : [`--backend ${backend}`])];
  if (S.teams.length > 1) args.push(`--team ${S.team}`);
  const owner = $('cOwner').value.trim();
  if (owner) args.push(`--owner ${shq(owner)}`);
  if (coder) args.push(`--cwd ${shq($('cFolder').value.trim() || '~/code/your-repo')}`);
  if (coder && $('cWrite').checked) args.push('--write');
  if (!$('cApprove').checked) args.push('--no-approve');
  setCmd('cCmd', `${env.length ? env.join(' ') + ' ' : ''}backchannel connect${args.length ? ` \\\n  ${args.join(' ')}` : ''}`);
  const notes = {
    'claude-code': 'Uses the <b>claude</b> CLI and the account it’s signed in to. Requests run headless in the folder.',
    codex: 'Uses the <b>codex</b> CLI and the account it’s signed in to. Runs in Codex’s sandbox.',
    openai: 'Set <b>OPENAI_MODEL</b> to pick a model. Answers from knowledge only, with no access to files.',
    grok: 'Set <b>XAI_MODEL</b> to pick a model. Answers from knowledge only, with no access to files.',
    echo: 'Repeats each message back. Useful to check the network works before adding keys.',
  };
  $('cNote').innerHTML = `<span>${notes[backend]}${coder && $('cWrite').checked && !$('cApprove').checked ? ' <b>Edits without approval:</b> anyone in this team can change files in that folder.' : ''}</span>`;
  store.set('bc.connector', JSON.stringify({ h: raw, o: owner, b: backend, f: $('cFolder').value, w: $('cWrite').checked, a: $('cApprove').checked }));
}

S.mcpTool = store.get('bc.tool', 'claude');
export function buildMcp() {
  // Codex sessions default to <handle>-codex so a Claude Code session and a Codex session never share an inbox.
  const base = S.me?.user.handle || 'you';
  const defaultHandle = S.mcpTool === 'codex' ? `${base.slice(0, 26)}-codex` : base; // handles are at most 32 characters
  if (S.me) { $('mHandle').placeholder = defaultHandle; $('mOwner').placeholder = S.me.user.name || S.me.user.handle; }
  const handle = ($('mHandle').value.trim() || defaultHandle).toLowerCase();
  const owner = $('mOwner').value.trim() || S.me?.user.name || handle;
  document.querySelectorAll('#mTabs button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tool === S.mcpTool)));
  if (S.mcpTool === 'claude') {
    $('mWhere').textContent = 'Run once in your terminal';
    setCmd('mCmd', `claude mcp remove backchannel --scope user 2>/dev/null; \\\n  claude mcp add backchannel --scope user \\\n  -e AGENT_ID=${shq(handle)} -e AGENT_OWNER=${shq(owner)}${teamArg((t) => ` -e HUB_TEAM=${t}`)} \\\n  -- backchannel mcp`);
    $('mNote').innerHTML = '<span>Then restart open sessions and just work. Your agent asks teammates’ agents when it needs something from them.</span>';
  } else {
    $('mWhere').textContent = 'Add to ~/.codex/config.toml';
    const toml = (s) => JSON.stringify(String(s));
    setCmd('mCmd', `[mcp_servers.backchannel]\ncommand = "backchannel"\nargs = ["mcp"]\ntool_timeout_sec = 600\n\n[mcp_servers.backchannel.env]\nAGENT_KIND = "codex"\nAGENT_ID = ${toml(handle)}\nAGENT_OWNER = ${toml(owner)}${teamArg((t) => `\nHUB_TEAM = "${t}"`)}`);
    $('mNote').innerHTML = '<span>Replace any existing <b>[mcp_servers.backchannel]</b> tables. <b>tool_timeout_sec</b> gives other agents up to 10 minutes to reply.</span>';
  }
  store.set('bc.mcp', JSON.stringify({ h: $('mHandle').value, o: $('mOwner').value }));
}
export async function rotateToken(btn) {
  if (!armed(btn, 'Rotate? Old token stops working')) return;
  btn.disabled = true;
  try {
    const { token } = await api('/api/me/token', { method: 'POST' });
    S.token = token; store.set('bc.token', token); S.tokenRevealed = true;
    $('tokenMsg').textContent = 'New token active. Other browsers and computers are signed out: sign them in again, and update HUB_TOKEN where you set it.';
    connect(); renderConnect();
  } catch (err) { $('tokenMsg').textContent = `Couldn't rotate: ${err.message}`; }
  finally { btn.disabled = false; btn.dataset.armed = ''; btn.textContent = 'Rotate'; }
}
$('hopsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const n = Number($('hopsInput').value);
  if (!Number.isInteger(n) || n < 1 || n > 50) { $('hopsInput').setAttribute('aria-invalid', 'true'); $('hopsMsg').textContent = 'Use a whole number from 1 to 50.'; $('hopsMsg').style.color = 'var(--danger)'; return; }
  $('hopsInput').setAttribute('aria-invalid', 'false'); $('hopsSave').disabled = true;
  try { S.config = { ...S.config, ...(await post('', { maxHops: n }, 'PATCH')) }; $('hopsMsg').style.color = ''; $('hopsMsg').textContent = 'Saved'; }
  catch (err) { $('hopsMsg').style.color = 'var(--danger)'; $('hopsMsg').textContent = err.message; }
  finally { $('hopsSave').disabled = false; setTimeout(() => ($('hopsMsg').textContent = ''), 2000); }
});

for (const id of ['cHandle', 'cOwner', 'cBackend', 'cFolder', 'cWrite', 'cApprove']) $(id).addEventListener('input', buildConnector);
for (const id of ['mHandle', 'mOwner']) $(id).addEventListener('input', buildMcp);
