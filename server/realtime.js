// In-memory live state for one hub process: SSE clients, long-poll waiters and agent presence.
import { agentKey } from './util.js';

export const ONLINE_MS = 40_000;
const MAX_BUFFERED = 1_000_000;

export function createRealtime() {
  const sseClients = new Set(); // { res, teamId, userId }
  const waiters = new Map();    // agentKey -> [wake]
  const presence = new Map();   // agentKey -> { lastSeen, state, stateThread }; the object's identity marks one registration

  return {
    sseClients,
    presenceOf(teamId, id) {
      const key = agentKey(teamId, id);
      let p = presence.get(key);
      if (!p) { p = { lastSeen: 0, state: 'idle', stateThread: null }; presence.set(key, p); }
      return p;
    },
    currentPresence: (teamId, id) => presence.get(agentKey(teamId, id)),
    forget(teamId, id) { presence.delete(agentKey(teamId, id)); this.wake(teamId, id); waiters.delete(agentKey(teamId, id)); },
    broadcast(teamId, event) {
      const data = `data: ${JSON.stringify(event)}\n\n`;
      for (const c of sseClients) if (c.teamId === teamId) this.write(c, data);
    },
    // A reader that stops reading is dropped once 1 MB is buffered for it; the browser reconnects and reloads.
    write(c, data) {
      if (c.res.writableLength > MAX_BUFFERED) { c.res.destroy(); sseClients.delete(c); return; }
      c.res.write(data);
    },
    // client: { res, teamId, userId, auth }
    addClient(client) { sseClients.add(client); client.res.on('close', () => sseClients.delete(client)); },
    // Ends streams whose credential or membership no longer holds (logout, session eviction or expiry, rotation, removal).
    revalidate(isValid) {
      for (const c of sseClients) if (!isValid(c)) { c.res.end(); sseClients.delete(c); }
    },
    wake(teamId, id) { for (const w of [...(waiters.get(agentKey(teamId, id)) || [])]) w(); },
    // Resolves after `ms`, or earlier when woken (new message, removal, revocation, shutdown) or the client goes away.
    wait(teamId, id, ms, res) {
      const key = agentKey(teamId, id);
      return new Promise((resolve) => {
        const wake = () => {
          clearTimeout(timer);
          res.off('close', wake);
          const list = waiters.get(key);
          if (list) { const i = list.indexOf(wake); if (i !== -1) list.splice(i, 1); if (!list.length) waiters.delete(key); }
          resolve();
        };
        const timer = setTimeout(wake, ms);
        const list = waiters.get(key) || [];
        list.push(wake); waiters.set(key, list);
        res.on('close', wake);
      });
    },
    // Ends a user's SSE streams and wakes their agents' long polls (after a role change, removal or token rotation),
    // so every live connection re-checks its permissions. `ownsAgent(key)` tells which waiters belong to the user.
    closeUser(userId, teamId, ownsAgent) {
      for (const c of sseClients) if (c.userId === userId && (!teamId || c.teamId === teamId)) { c.res.end(); sseClients.delete(c); }
      this.wakeIf((key) => (!teamId || key.startsWith(teamId + '/')) && ownsAgent(key));
    },
    wakeIf(pred) { for (const [key, list] of waiters) if (pred(key)) for (const w of [...list]) w(); },
    // Shutdown: end every stream and release every long poll.
    wakeAll() { for (const list of waiters.values()) for (const w of [...list]) w(); },
    closeAll() {
      for (const c of sseClients) c.res.end();
      sseClients.clear();
      for (const list of waiters.values()) for (const w of [...list]) w();
    },
    online: (p) => Date.now() - p.lastSeen < ONLINE_MS,
  };
}
