// The hub's rule for whether a delegation is still waiting on someone (server/threads.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { debtsOf } from '../server/threads.js';

const AGENTS = { maya: 'session', steve: 'session', bob: 'agent', carol: 'agent' };
const isAgent = (id) => !!AGENTS[id];
const owing = ({ msgs }) => [...new Set(debtsOf(msgs, isAgent).map((d) => d.debtor))].filter(isAgent);

let n = 0;
const msg = (from, to, extra = {}) => ({ id: `m${++n}`, from, to, fromKind: AGENTS[from] ? 'agent' : 'user', reply: false, ...extra });
const waiting = (...msgs) => owing({ msgs });

test('a live session asking another live session waits for its reply', () => {
  const ask = msg('maya', ['steve']);
  assert.deepEqual(waiting(ask), ['steve']);
  const answer = msg('steve', ['maya'], { inReplyTo: ask.id, reply: true });
  assert.deepEqual(waiting(ask, answer), []);
  // A follow-up after the answer is a new request (its parent is inferred, so it isn't a reply).
  const follow = msg('maya', ['steve'], { inReplyTo: answer.id });
  assert.deepEqual(waiting(ask, answer, follow), ['steve']);
});

test('a person asking a connector is answered by its reply', () => {
  const ask = msg('maya', ['bob']); // a person in the web UI (not an agent)
  assert.deepEqual(waiting(ask), ['bob']);
  assert.deepEqual(waiting(ask, msg('bob', [], { inReplyTo: ask.id, reply: true })), []);
  assert.deepEqual(waiting(ask, msg('bob', ['maya'], { inReplyTo: ask.id, kind: 'declined', reply: true })), []);
});

test('handing work on keeps the delegation waiting until the chain comes back', () => {
  const ask = msg('maya', ['bob']);
  const handoff = msg('bob', ['carol'], { inReplyTo: ask.id, reply: true }); // "@carol what is…"
  assert.deepEqual(waiting(ask, handoff), ['bob', 'carol'], 'bob still owes maya, carol owes bob');
  const carol = msg('carol', ['bob'], { inReplyTo: handoff.id, reply: true });
  assert.deepEqual(waiting(ask, handoff, carol), ['bob'], 'carol answered; bob still owes maya');
  const done = msg('bob', ['carol'], { inReplyTo: carol.id, reply: true }); // a connector's reply goes to whoever messaged it
  assert.deepEqual(waiting(ask, handoff, carol, done), []);
  // Answering and handing on at once: settles what was owed to the asker, opens a new ask.
  const both = msg('bob', ['maya', 'carol'], { inReplyTo: ask.id, reply: true });
  assert.deepEqual(waiting(ask, both), ['carol']);
});

test('messages stopped by the hop limit ask nobody, and messages from older hubs still settle', () => {
  const ask = msg('maya', ['bob']);
  assert.deepEqual(waiting(ask, msg('bob', ['carol'], { inReplyTo: ask.id, reply: true, note: 'hop limit' })), []);
  const legacyAsk = msg('maya', ['bob'], { reply: undefined });
  assert.deepEqual(waiting(legacyAsk, msg('bob', ['maya'], { inReplyTo: legacyAsk.id, reply: undefined })), []);
  assert.deepEqual(waiting(msg('maya', ['gone'])), [], 'removed agents are not waited on');
});
