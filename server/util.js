export const agentKey = (teamId, agentId) => `${teamId}/${agentId}`;

// Git remotes are shown to the whole team, so credentials (https://user:token@host/…) and query strings are dropped.
// Same rule as cleanRemote in client.js, which strips them before they leave the computer.
export function cleanRemote(url) {
  if (!url) return null;
  const m = /^([a-z][a-z0-9+.-]*:\/\/)(?:[^/?#]*@)?([^?#]*)/i.exec(url);
  return m ? m[1] + m[2] : url.replace(/^[^@/]*:[^@/]*@/, '');
}
