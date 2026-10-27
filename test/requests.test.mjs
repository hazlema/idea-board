import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BoardStore } from '../lib/store.mjs';
import { ConflictError } from '../lib/board.mjs';
import { agentId } from '../lib/authors.mjs';
import { ForemanRequests, holdsForeman } from '../lib/requests.mjs';

const A = { model: 'acme/alpha', roleId: 'systems', name: 'Alpha · Systems' };
const B = { model: 'acme/beta', roleId: 'art', name: 'Beta · Art' };
const ID_A = agentId(A.model, A.roleId);
const ID_B = agentId(B.model, B.roleId);

// A store with cards on the roster, a fake room (connections, dispatch) and a fake colab.
function setup({ cards = [A, B], claudeRoleId = 'foreman' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-board-requests-'));
  const store = new BoardStore(path.join(dir, 'board.json'));
  store.board.colab.lineup.agents = cards.map(({ model, roleId }) => ({ model, roleId }));
  store.board.colab.lineup.claudeRoleId = claudeRoleId;
  store.addColabRoster(cards.map((c) => ({ id: agentId(c.model, c.roleId), model: c.model, roleId: c.roleId, name: c.name, modelName: c.model, color: 'amber' })));
  const down = new Map();
  const dispatched = [];
  const room = {
    connections: () => [
      { n: 1, id: 'claude', available: !down.has('claude'), ...(down.has('claude') ? { why: down.get('claude') } : {}) },
      ...cards.map((c, i) => {
        const id = agentId(c.model, c.roleId);
        return { n: i + 2, id, available: !down.has(id), ...(down.has(id) ? { why: down.get(id) } : {}) };
      }),
    ],
    dispatch: (m) => dispatched.push(m),
  };
  const cut = [];
  const colab = { status: { state: 'idle' }, cutAnswer: (id) => cut.push(id) };
  const requests = new ForemanRequests({ store, room, colab });
  const answerAs = (id, m, text = 'done') => store.apply({ type: 'chat', text, answers: [m.id] }, id);
  const last = () => store.board.chat.at(-1);
  const cleanup = () => {
    store.historyLog.flush();
    fs.rmSync(dir, { recursive: true });
  };
  return { store, requests, room, colab, down, dispatched, cut, answerAs, last, cleanup };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('only the foreman can ask, and every foreman may', () => {
  const qa = setup({ cards: [{ ...A, roleId: 'foreman', name: 'Alpha · Foreman' }, B], claudeRoleId: 'qa' });
  const foremanCard = agentId(A.model, 'foreman');
  assert.equal(holdsForeman(qa.store.board, 'claude'), false);
  assert.equal(holdsForeman(qa.store.board, foremanCard), true);
  assert.throws(() => qa.requests.ask('claude', [{ agent: 'Art', request: 'x' }]), { message: 'Only the Foreman can ask other agents for work.' });
  assert.equal(qa.requests.ask(foremanCard, [{ agent: 'Art', request: 'x' }]).waiting, true);
  qa.cleanup();

  const both = setup({ cards: [{ ...A, roleId: 'foreman', name: 'Alpha · Foreman' }, B] });
  const r = both.requests.ask('claude', [{ agent: 'Art', request: 'x' }]);
  both.requests.answer(r.id, false);
  assert.equal(both.requests.ask(agentId(A.model, 'foreman'), [{ agent: 'Art', request: 'y' }]).waiting, true);
  both.cleanup();
});

test('asking posts the chain from the foreman and sends nothing', () => {
  const { store, requests, dispatched, last, cleanup } = setup();
  const { waiting, id } = requests.ask('claude', [{ agent: 'systems', request: 'rework the save format' }, { agent: ID_B, request: 'update the mockups' }]);
  assert.equal(waiting, true);
  const request = store.board.colab.request;
  assert.equal(request.id, id);
  assert.equal(request.state, 'waiting');
  assert.equal(request.by, 'claude');
  assert.deepEqual(request.steps.map((s) => s.to), [ID_A, ID_B]);
  assert.deepEqual(request.steps.map((s) => s.name), [A.name, B.name]);
  assert.equal(last().role, 'claude');
  assert.equal(last().text, `Asking the host to approve:\n1. ${A.name}: rework the save format\n2. ${B.name}: update the mockups`);
  assert.equal(dispatched.length, 0);
  cleanup();
});

test('a chain is checked before the host sees it', () => {
  const twoQa = setup({ cards: [{ ...A, roleId: 'qa', name: 'Alpha · QA' }, { ...B, roleId: 'qa', name: 'Beta · QA' }] });
  assert.throws(() => twoQa.requests.ask('claude', [{ agent: 'qa', request: 'x' }]), /"qa" could mean Alpha · QA or Beta · QA; use the id\./);
  twoQa.cleanup();

  const { store, requests, down, cleanup } = setup();
  const chat = store.board.chat.length;
  down.set(ID_B, 'over-budget');
  const refusals = [
    [[{ agent: 'nobody', request: 'x' }], /No agent called "nobody"\./],
    [[{ agent: 'claude', request: 'x' }], /You can't ask yourself\./],
    [[{ agent: 'art', request: 'x' }], /Beta · Art can't answer right now \(over budget\)\./],
    [[], /steps must list 1 to 10 requests/],
    [Array.from({ length: 11 }, () => ({ agent: 'systems', request: 'x' })), /steps must list 1 to 10 requests/],
    [[{ agent: 'systems', request: '' }], /request/],
    ['nope', /steps must list 1 to 10 requests/],
  ];
  for (const [steps, error] of refusals) {
    assert.throws(() => requests.ask('claude', steps), error);
    assert.equal(store.board.colab.request, null);
    assert.equal(store.board.chat.length, chat);
  }
  cleanup();
});

test('refused in a run and during an audit', () => {
  const { requests, colab, cleanup } = setup();
  colab.status = { state: 'running' };
  assert.throws(() => requests.ask('claude', [{ agent: 'art', request: 'x' }]), { message: 'A run is going: say it in the chat instead, and the next agent will pick it up.' });
  colab.status = { state: 'idle', auditing: true };
  assert.throws(() => requests.ask('claude', [{ agent: 'art', request: 'x' }]), /An audit is going; ask when it has finished\./);
  cleanup();
});

test('one request at a time', () => {
  const { requests, cleanup } = setup();
  requests.ask('claude', [{ agent: 'art', request: 'x' }]);
  assert.equal(requests.busy, true);
  assert.throws(() => requests.ask('claude', [{ agent: 'art', request: 'y' }]), /A request is already waiting for the host or under way\./);
  cleanup();
});

test('No posts the line and sends nothing', () => {
  const { store, requests, dispatched, last, cleanup } = setup();
  const { id } = requests.ask('claude', [{ agent: 'art', request: 'x' }]);
  assert.deepEqual(requests.answer(id, false), { ok: true });
  assert.equal(last().role, 'user');
  assert.equal(last().text, 'The host declined the request.');
  assert.deepEqual(last().owed, []);
  assert.equal(store.board.colab.request, null);
  assert.equal(requests.busy, false);
  assert.equal(dispatched.length, 0);
  cleanup();
});

test('a stale answer is refused', () => {
  const { requests, cleanup } = setup();
  const { id } = requests.ask('claude', [{ agent: 'art', request: 'x' }]);
  assert.throws(() => requests.answer('r_other', true), ConflictError);
  requests.answer(id, false);
  assert.throws(() => requests.answer(id, true), ConflictError);
  cleanup();
});

test('Yes plays the steps in order, each after the answer before it', async () => {
  const { store, requests, dispatched, answerAs, cleanup } = setup();
  const { id } = requests.ask('claude', [{ agent: 'systems', request: 'rework saves' }, { agent: 'art', request: 'update mockups' }]);
  requests.answer(id, true);
  assert.equal(store.board.colab.request.state, 'playing');
  assert.equal(dispatched.length, 1);
  const [first] = dispatched;
  assert.equal(first.role, 'user');
  assert.equal(first.text, 'rework saves');
  assert.deepEqual(first.to, [ID_A]);
  assert.deepEqual(first.owed, [ID_A]);
  assert.deepEqual(first.request, { by: 'claude', step: 1, of: 2 });
  answerAs(ID_A, first);
  await flush();
  assert.equal(dispatched.length, 2);
  assert.deepEqual(dispatched[1].to, [ID_B]);
  assert.deepEqual(dispatched[1].request, { by: 'claude', step: 2, of: 2 });
  assert.equal(store.board.colab.request.step, 1);
  answerAs(ID_B, dispatched[1]);
  await requests.settled();
  assert.equal(store.board.colab.request, null);
  assert.equal(requests.busy, false);
  cleanup();
});

test('a step waits for its own message', async () => {
  const { store, requests, dispatched, answerAs, cleanup } = setup();
  const { id } = requests.ask('claude', [{ agent: 'systems', request: 'one' }, { agent: 'art', request: 'two' }]);
  requests.answer(id, true);
  const { message: other } = store.apply({ type: 'chat', text: 'unrelated', to: [ID_A], owed: [ID_A] }, 'user');
  answerAs(ID_A, other);
  await flush();
  assert.equal(dispatched.length, 1);
  answerAs(ID_A, dispatched[0]);
  await flush();
  assert.equal(dispatched.length, 2);
  cleanup();
});

test('a step that fails stops the chain', async () => {
  const card = setup();
  const { id } = card.requests.ask('claude', [{ agent: 'systems', request: 'one' }, { agent: 'art', request: 'two' }]);
  card.requests.answer(id, true);
  card.answerAs(ID_A, card.dispatched[0], '(my turn failed: boom)');
  await card.requests.settled();
  assert.equal(card.last().text, `The foreman's request stopped at step 1 (${A.name}): the answer failed.`);
  assert.equal(card.store.board.colab.request, null);
  assert.equal(card.dispatched.length, 1);
  card.cleanup();

  // Claude through the binary: a failed answer leaves the message owed and says so in an event.
  const asClaude = setup({ cards: [{ ...A, roleId: 'foreman', name: 'Alpha · Foreman' }], claudeRoleId: 'qa' });
  const r = asClaude.requests.ask(agentId(A.model, 'foreman'), [{ agent: 'claude', request: 'one' }, { agent: 'claude', request: 'two' }]);
  asClaude.requests.answer(r.id, true);
  asClaude.store.emit({ type: 'agent', state: 'error', message: 'x' });
  await asClaude.requests.settled();
  assert.match(asClaude.last().text, /stopped at step 1 \(Claude\): the answer failed\./);
  assert.equal(asClaude.dispatched.length, 1);
  asClaude.cleanup();
});

test("a step that can't run stops the chain with a note", async () => {
  const { requests, dispatched, down, answerAs, last, cleanup } = setup();
  const { id } = requests.ask('claude', [{ agent: 'systems', request: 'one' }, { agent: 'art', request: 'two' }]);
  requests.answer(id, true);
  down.set(ID_B, 'over-budget');
  answerAs(ID_A, dispatched[0]);
  await requests.settled();
  assert.equal(last().text, `The foreman's request stopped at step 2 (${B.name}): over budget.`);
  assert.equal(dispatched.length, 1);
  cleanup();
});

test('cancel stops the rest of the chain', async () => {
  const { store, requests, dispatched, cut, answerAs, last, cleanup } = setup();
  assert.equal(requests.cancel(), false);
  const { id } = requests.ask('claude', [{ agent: 'systems', request: 'one' }, { agent: 'art', request: 'two' }]);
  requests.answer(id, true);
  assert.equal(requests.cancel(), true);
  await requests.settled();
  assert.deepEqual(cut, [ID_A]);
  assert.equal(last().text, `The foreman's request stopped at step 1 (${A.name}): stopped.`);
  assert.equal(store.board.colab.request, null);
  answerAs(ID_A, dispatched[0]);
  await flush();
  assert.equal(dispatched.length, 1);

  // A waiting request is dropped the same way.
  requests.ask('claude', [{ agent: 'art', request: 'x' }]);
  assert.equal(requests.cancel(), true);
  assert.equal(store.board.colab.request, null);
  assert.equal(last().text, `The foreman's request stopped at step 1 (${B.name}): stopped.`);
  cleanup();
});

test('a restart drops the request with a note', () => {
  const { store, requests, last, cleanup } = setup();
  requests.recoverAfterRestart();
  const chat = store.board.chat.length;
  assert.equal(store.board.chat.length, chat);
  store.board.colab.request = { id: 'r_1', by: 'claude', at: 'then', state: 'playing', step: 0, steps: [{ to: ID_A, name: A.name, text: 'x' }] };
  requests.recoverAfterRestart();
  assert.equal(store.board.colab.request, null);
  assert.equal(last().text, "The foreman's request was dropped when the server restarted.");
  assert.equal(last().role, 'claude');
  cleanup();
});
