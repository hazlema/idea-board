import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BoardStore } from '../lib/store.mjs';
import { Library } from '../lib/colab/library.mjs';
import { Room } from '../lib/room.mjs';
import { ConflictError, OpError } from '../lib/board.mjs';
import { agentId } from '../lib/authors.mjs';

const A = { model: 'acme/alpha-one', roleId: 'creative' };
const B = { model: 'acme/beta-two', roleId: 'qa' };
const ID_A = agentId(A.model, A.roleId);
const ID_B = agentId(B.model, B.roleId);
const NOTE = 'No one is connected to answer. Connect Claude (see the sidebar) or add an OpenRouter connection.';

// A store with two cards on the roster, a fake agent and a fake colab that records calls.
function setup({ via = 'binary', cards = [A, B], state = 'idle', pruning = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-board-room-'));
  const store = new BoardStore(path.join(dir, 'board.json'));
  store.board.colab.lineup.agents = cards;
  if (cards.length) store.addColabRoster(cards.map((c) => ({ id: agentId(c.model, c.roleId), model: c.model, roleId: c.roleId, name: c.model, modelName: c.model, color: 'amber' })));
  const library = new Library(path.join(dir, 'colab.json'));
  const nudges = [];
  const agent = { via: () => via, nudge: () => nudges.push(1), found: via === 'binary', role: () => '' };
  const presence = { role: () => '', attached: () => via === 'mcp' };
  const calls = { audit: [], prune: [], answer: [], start: [], stop: 0, ensureRoster: 0, budgetChanged: 0, recover: 0 };
  const colab = {
    status: { state, pruning },
    audit: (o) => { calls.audit.push(o); return calls.auditResult ?? { ok: true, by: 'Claude' }; },
    prune: (o) => { calls.prune.push(o); return calls.pruneResult ?? { ok: true }; },
    ensureRoster: () => { calls.ensureRoster += 1; },
    canAnswer: (id) => (cards.some((c) => agentId(c.model, c.roleId) === id) ? { ok: true } : { ok: false, why: 'no-model' }),
    answer: (id) => calls.answer.push(id),
    startError: () => calls.startError ?? null,
    start: (id) => calls.start.push(id),
    stop: () => { calls.stop += 1; },
    budgetChanged: () => { calls.budgetChanged += 1; },
    recoverAfterRestart: () => { calls.recover += 1; },
  };
  const room = new Room({ store, agent, presence, colab, library });
  return { dir, store, room, nudges, calls, colab, agent, presence, library };
}

test('a plain message is owed by every available connection', () => {
  const { room, nudges, calls } = setup();
  const { message } = room.userChat({ text: 'hi' });
  assert.deepEqual(message.owed, ['claude', ID_A, ID_B]);
  assert.equal(nudges.length, 1);
  assert.deepEqual(calls.answer, [ID_A, ID_B]);
});

test('/chat 2 goes to the first card only', () => {
  const { room, nudges, calls } = setup();
  const { message } = room.userChat({ text: '/chat 2 what do you think?' });
  assert.deepEqual(message.owed, [ID_A]);
  assert.deepEqual(message.to, [ID_A]);
  assert.equal(message.text, 'what do you think?');
  assert.equal(nudges.length, 0);
  assert.deepEqual(calls.answer, [ID_A]);
});

test('/chat 1 when Claude is not connected is refused', () => {
  const { room, store } = setup({ via: 'none' });
  assert.throws(() => room.userChat({ text: '/chat 1 hello' }), /Claude.*can't answer right now \(not connected\)/);
  assert.equal(store.board.chat.length, 0);
});

test('/chat 9 is refused', () => {
  const { room } = setup();
  assert.throws(() => room.userChat({ text: '/chat 9 hello' }), /No connection 9\. Connections are numbered 1 to 3 in the sidebar\./);
});

test('unknown command is refused and nothing is posted', () => {
  const { room, store } = setup();
  assert.throws(() => room.userChat({ text: '/home/x' }), /Unknown command/);
  assert.equal(store.board.chat.length, 0);
});

test('//home sends a plain message', () => {
  const { room, store } = setup();
  room.userChat({ text: '//home' });
  assert.equal(store.board.chat[0].text, '/home');
});

test('during a run, messages are owed by no one', () => {
  const { room, nudges, calls } = setup({ state: 'running' });
  assert.deepEqual(room.userChat({ text: 'hello' }).message.owed, []);
  const { message } = room.userChat({ text: '/chat 2 x' });
  assert.deepEqual(message.owed, []);
  assert.deepEqual(message.to, [ID_A]);
  assert.deepEqual(calls.answer, []);
  assert.equal(nudges.length, 0);
});

test('/start posts the kickoff and starts', () => {
  const { room, calls, nudges } = setup();
  const { message } = room.userChat({ text: '/start build the classes' });
  assert.equal(message.start, true);
  assert.deepEqual(message.owed, []);
  assert.equal(message.text, 'build the classes');
  assert.deepEqual(calls.start, [message.id]);
  assert.equal(nudges.length, 0);
});

test('/start during a run and /stop with no run are refused', () => {
  const running = setup({ state: 'running' });
  assert.throws(() => running.room.userChat({ text: '/start again' }), /A run is already going\. Use \/stop first\./);
  assert.deepEqual(running.room.userChat({ text: '/stop' }), { stopped: true });
  assert.equal(running.calls.stop, 1);
  assert.equal(running.store.board.chat.length, 0);
  const idle = setup();
  assert.throws(() => idle.room.userChat({ text: '/stop' }), /No run is going\./);
  const nobody = setup({ via: 'none', cards: [] });
  assert.throws(() => nobody.room.userChat({ text: '/start go' }), /No one is connected to start a run\./);
});

test('nobody connected still posts with a note', () => {
  const { room, store } = setup({ via: 'none', cards: [] });
  room.userChat({ text: 'anyone?' });
  assert.deepEqual(store.board.chat.map((m) => [m.role, m.text]), [['user', 'anyone?'], ['claude', NOTE]]);
  assert.deepEqual(store.board.chat[0].owed, []);
});

test('connections number Claude 1 and the cards after it', () => {
  const { room } = setup({ via: 'none' });
  assert.deepEqual(room.connections(), [
    { n: 1, id: 'claude', kind: 'direct', available: false, why: 'not-connected' },
    { n: 2, id: ID_A, kind: 'openrouter', available: true },
    { n: 3, id: ID_B, kind: 'openrouter', available: true },
  ]);
});

test('recover drops OpenRouter debts and keeps Claude\'s', () => {
  const { room, store, calls } = setup();
  store.apply({ type: 'chat', text: 'q', owed: ['claude', ID_A] }, 'user');
  const entries = store.historyLog.entries().length;
  room.recover();
  assert.deepEqual(store.board.chat[0].owed, ['claude']);
  assert.equal(store.historyLog.entries().length, entries);
  assert.equal(calls.recover, 1);
  assert.equal(calls.ensureRoster, 1);
});

test('recover fills a missing Claude role from the library', () => {
  const { room, store } = setup();
  store.board.colab.lineup.claudeRoleId = 'gone';
  room.recover();
  assert.equal(store.board.colab.lineup.claudeRoleId, 'foreman');
  assert.equal(store.board.colab.claudeName, 'Claude · Foreman');
});

test('recover sets Claude\'s model from IDEA_BOARD_MODEL once', () => {
  const saved = process.env.IDEA_BOARD_MODEL;
  try {
    process.env.IDEA_BOARD_MODEL = 'haiku';
    const a = setup();
    delete a.store.board.colab.lineup.claudeModel;
    a.room.recover();
    assert.equal(a.store.board.colab.lineup.claudeModel, 'haiku');
    delete process.env.IDEA_BOARD_MODEL;
    const b = setup();
    delete b.store.board.colab.lineup.claudeModel;
    b.room.recover();
    assert.equal(b.store.board.colab.lineup.claudeModel, 'sonnet');
    const c = setup();
    c.store.board.colab.lineup.claudeModel = 'opus';
    c.room.recover();
    assert.equal(c.store.board.colab.lineup.claudeModel, 'opus');
  } finally {
    if (saved === undefined) delete process.env.IDEA_BOARD_MODEL; else process.env.IDEA_BOARD_MODEL = saved;
  }
});

test('lineupChanged names Claude by role', () => {
  const { room, store, calls } = setup();
  store.board.colab.lineup.claudeRoleId = 'foreman';
  room.lineupChanged();
  assert.equal(store.board.colab.claudeName, 'Claude · Foreman');
  assert.equal(calls.ensureRoster, 1);
  assert.equal(calls.budgetChanged, 1);
});

test('resetSpent zeroes spent and tells the run', () => {
  const { room, store, calls } = setup();
  store.setColabSpent(3);
  room.resetSpent();
  assert.equal(store.board.colab.spent, 0);
  assert.equal(calls.budgetChanged, 1);
});

test('Claude\'s role text joins its job, its extra and the rules', () => {
  const { room, store, presence, agent, library } = setup();
  store.board.colab.extras = { rules: 'be kind', roles: { foreman: 'keep score' } };
  const { roles, rules } = library.get();
  const job = roles.find((r) => r.id === 'foreman').job;
  const expected = `${job}\n\nkeep score\n\n${rules}\n\nbe kind`;
  assert.equal(room.roleText(), expected);
  assert.equal(presence.role(), expected);
  assert.equal(agent.role(), expected);
});

test('presence and agent events re-send the run status', () => {
  const { store } = setup();
  const seen = [];
  store.subscribe((e) => seen.push(e.type));
  store.emit({ type: 'presence', attached: true });
  store.emit({ type: 'agent', state: 'idle' });
  assert.deepEqual(seen.filter((t) => t === 'colab').length, 2);
});

test('a /start the run refuses posts nothing', () => {
  const { room, store, calls } = setup();
  calls.startError = 'Agent 2 has no model';
  assert.throws(() => room.userChat({ text: '/start go' }), (error) => error instanceof OpError && !(error instanceof ConflictError) && /Agent 2 has no model/.test(error.message));
  assert.equal(store.board.chat.length, 0);
  assert.deepEqual(calls.start, []);
});

test('/prune starts a pass and posts the request, owing nothing', () => {
  const a = setup();
  a.room.userChat({ text: '/prune' });
  assert.deepEqual(a.calls.prune, [{ guidance: '' }]);
  const m = a.store.board.chat.at(-1);
  assert.equal(m.text, 'Prune the board.');
  assert.deepEqual(m.owed, []);
  const b = setup();
  b.room.userChat({ text: '/prune the pirates' });
  assert.deepEqual(b.calls.prune, [{ guidance: 'the pirates' }]);
  assert.equal(b.store.board.chat.at(-1).text, 'Prune the board: the pirates');
  assert.deepEqual(b.store.board.chat.at(-1).owed, []);
});

test('a refused /prune throws and posts nothing', () => {
  const a = setup();
  a.calls.pruneResult = { error: '/prune needs the claude command.' };
  assert.throws(() => a.room.userChat({ text: '/prune' }), /\/prune needs the claude command\./);
  assert.equal(a.store.board.chat.length, 0);
});

test('/stop while a pass runs stops it', () => {
  const a = setup({ pruning: true });
  assert.deepEqual(a.room.userChat({ text: '/stop' }), { stopped: true });
  assert.equal(a.calls.stop, 1);
});

test('/stop while a pass is asked for but not started stops it; with nothing going it is refused', () => {
  const a = setup();
  a.colab.status = { state: 'idle', pruning: false, prunePending: true };
  assert.deepEqual(a.room.userChat({ text: '/stop' }), { stopped: true });
  assert.equal(a.calls.stop, 1);
  a.colab.status = { state: 'idle', pruning: false, prunePending: false };
  assert.throws(() => a.room.userChat({ text: '/stop' }), /No run is going\./);
});

test('/audit starts a pass and posts the request, owing nothing', () => {
  const a = setup();
  a.room.userChat({ text: '/audit' });
  assert.deepEqual(a.calls.audit, [{ focus: '' }]);
  assert.equal(a.store.board.chat.at(-1).text, 'Audit the board.');
  assert.deepEqual(a.store.board.chat.at(-1).owed, []);
  const b = setup();
  b.room.userChat({ text: '/audit the rules' });
  assert.deepEqual(b.calls.audit, [{ focus: 'the rules' }]);
  assert.equal(b.store.board.chat.at(-1).text, 'Audit the board: the rules');
  assert.equal(b.store.board.chat.at(-1).role, 'user');
  assert.deepEqual(b.store.board.chat.at(-1).owed, []);
});

test('a refused /audit throws an OpError and posts nothing', () => {
  const a = setup();
  a.calls.auditResult = { error: 'Nobody can audit right now.' };
  assert.throws(() => a.room.userChat({ text: '/audit' }), (e) => e instanceof OpError && /Nobody can audit/.test(e.message));
  assert.equal(a.store.board.chat.length, 0);
});

test('/stop while an audit runs stops it', () => {
  const a = setup();
  a.colab.status = { state: 'idle', pruning: false, prunePending: false, auditing: true };
  assert.deepEqual(a.room.userChat({ text: '/stop' }), { stopped: true });
  assert.equal(a.calls.stop, 1);
});
