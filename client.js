// Tiny hub client shared by the connector (agent.js) and the MCP server (mcp.js).
export class Hub {
  constructor(url, token) {
    this.url = url.replace(/\/$/, '');
    this.token = token;
  }

  async req(method, p, body) {
    const res = await fetch(this.url + p, {
      method,
      headers: { 'content-type': 'application/json', ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(data.error || `hub ${res.status}`); e.status = res.status; throw e; }
    return data;
  }

  register(card) { return this.req('POST', '/api/agents', card); }
  agents() { return this.req('GET', '/api/agents'); }
  thread(id) { return this.req('GET', `/api/threads/${id}`); }
  post(msg) { return this.req('POST', '/api/messages', msg); }
  status(id, state, threadId) { return this.req('POST', `/api/agents/${id}/status`, { state, threadId }); }
  requeue(id, ids) { return this.req('POST', `/api/agents/${id}/requeue`, { ids }); }
  inbox(id, wait = 25) { return this.req('GET', `/api/agents/${id}/inbox?wait=${wait}`); }

  // Register, then long-poll the inbox forever. Re-registers if the hub restarts; backs off if it's down.
  async listen(card, onMessage, log = () => {}) {
    let registered = false, backoff = 1000;
    for (;;) {
      try {
        if (!registered) { await this.register(card); registered = true; backoff = 1000; log(`@${card.id} online`); }
        for (const msg of await this.inbox(card.id)) await onMessage(msg);
      } catch (err) {
        if (err.status === 404) { registered = false; continue; }
        if (registered) log(`hub unreachable (${err.message}), retrying…`);
        registered = false;
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 15000);
      }
    }
  }
}
