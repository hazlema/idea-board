import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createToolRunner, TOOLS, MAX_CHAT_CHARS, unansweredChat } from '../lib/mcp-tools.mjs';
import { AUDIT_DENIED } from '../lib/audit.mjs';
import { BoardStore } from '../lib/store.mjs';

const DEPRECATED = '* deprecated, please use view_brief, view_brainstorm, view_flow, view_chat to maximize context';

async function withStore(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-board-read-'));
  const store = new BoardStore(path.join(dir, 'board.json'));
  try {
    return await fn(store);
  } finally {
    store.historyLog.flush();
    fs.rmSync(dir, { recursive: true });
  }
}

const say = (store, author, text, extra = {}) => store.apply({ type: 'chat', text, ...extra }, author);
// A card connection on the roster, so it may write and be written to.
const addQa = (store) => store.board.colab.roster.push({ id: 'agent:x=qa', model: 'x', roleId: 'qa', name: 'X · QA', modelName: 'X', color: 'violet' });

test('view_brief shows the title, then ruled_out, then the brief', () => withStore(async (store) => {
  store.apply({ type: 'ruleOut', target: { kind: 'idea' }, text: 'Fireballs', reason: 'too flashy' }, 'user');
  const view = await createToolRunner(store).call('view_brief', {});
  assert.deepEqual(Object.keys(view), ['title', 'ruled_out', 'brief']);
  assert.equal(view.ruled_out[0].text, 'Fireballs');
  assert.deepEqual(Object.keys(view.ruled_out[0]), ['id', 'text', 'reason', 'from', 'at']);
  assert.deepEqual(Object.keys(view.brief[0]), ['id', 'title', 'text']);
  assert.match(TOOLS.find((t) => t.name === 'view_brief').description, /Start here/);
}));

test('view_brainstorm is the brainstorm part of the board, with positions and ruled-out entries', () => withStore(async (store) => {
  const { object } = store.apply({ type: 'addObject', kind: 'group', title: 'Wizards', x: 10, y: 20, entries: [{ label: 'Staves' }, { label: 'Fireballs' }] }, 'user');
  store.apply({ type: 'ruleOut', target: { kind: 'entry', groupId: object.id, entryId: object.entries[1].id }, reason: 'no' }, 'user');
  const view = await createToolRunner(store).call('view_brainstorm', {});
  assert.deepEqual(Object.keys(view), ['groups', 'notes', 'pictures', 'topics', 'links']);
  const [g] = view.groups;
  assert.deepEqual([g.x, g.y], [10, 20]);
  assert.deepEqual(g.entries.map((e) => e.label), ['Staves']);
  assert.deepEqual(g.ruled_out_entries.map((e) => e.label), ['Fireballs']);
}));

test('view_flow lists cards and connections, with full notes on request', () => withStore(async (store) => {
  const long = 'n'.repeat(400);
  const { node } = store.apply({ type: 'addNode', title: 'Start', notes: long }, 'user');
  const tools = createToolRunner(store);
  const view = await tools.call('view_flow', {});
  assert.deepEqual(Object.keys(view), ['nodes', 'connections']);
  assert.equal(view.nodes[0].id, node.id);
  assert.match(view.nodes[0].notes, /get_node for the rest/);
  assert.equal((await tools.call('view_flow', { full_notes: true })).nodes[0].notes, long);
}));

test('view_chat gives the whole chat oldest first, and what is unanswered', () => withStore(async (store) => {
  for (let i = 1; i <= 25; i += 1) say(store, i % 2 ? 'user' : 'claude', `m${i}`, i % 2 ? { owed: i === 25 ? ['claude'] : [] } : {});
  const view = await createToolRunner(store).call('view_chat', {});
  assert.deepEqual(Object.keys(view), ['messages', 'more', 'unanswered']);
  assert.deepEqual(view.messages.map((m) => m.text), Array.from({ length: 25 }, (_, i) => `m${i + 1}`));
  assert.equal(view.more, 0);
  assert.deepEqual(Object.keys(view.messages[0]), ['id', 'from', 'at', 'text']);
  assert.equal(view.messages.at(-1).from, 'Host');
  assert.equal(view.messages.at(-2).from, 'Claude');
  assert.deepEqual(view.unanswered.map((m) => m.text), ['m25']);
}));

test('view_chat limit gives the last few, and before pages back', () => withStore(async (store) => {
  for (let i = 1; i <= 130; i += 1) say(store, 'claude', `m${i}`);
  const tools = createToolRunner(store);
  const first = await tools.call('view_chat', { limit: 10 });
  const older = await tools.call('view_chat', { limit: 10, before: first.messages[0].id });
  assert.deepEqual(older.messages.map((m) => m.text), Array.from({ length: 10 }, (_, i) => `m${i + 111}`));
  assert.equal(older.more, 110);
  assert.equal(first.more, 120);
  assert.equal((await tools.call('view_chat', {})).messages.length, 130);
  await assert.rejects(tools.call('view_chat', { before: 'm_nope' }), /no chat message m_nope/);
}));

test('a chat too long for one answer sends the newest messages that fit, and says how many are left', () => withStore(async (store) => {
  const long = 'x'.repeat(5000);
  for (let i = 1; i <= 40; i += 1) say(store, 'claude', `${i} ${long}`);
  const tools = createToolRunner(store);
  const view = await tools.call('view_chat', {});
  assert.ok(JSON.stringify(view).length <= MAX_CHAT_CHARS);
  assert.ok(view.messages.length > 0 && view.messages.length < 40);
  assert.equal(view.messages.at(-1).text.split(' ')[0], '40');
  assert.equal(view.more, 40 - view.messages.length);
  const older = await tools.call('view_chat', { before: view.messages[0].id });
  assert.equal(older.messages.at(-1).text.split(' ')[0], String(40 - view.messages.length));
  // Even a limit can't push it past what fits.
  assert.ok(JSON.stringify(await tools.call('view_chat', { limit: 40 })).length <= MAX_CHAT_CHARS);
}));

test('view_chat from picks one author: host, an id, or part of a name', () => withStore(async (store) => {
  store.board.colab.claudeName = 'Claude · Foreman';
  addQa(store);
  say(store, 'user', 'hi', { owed: [] });
  say(store, 'claude', 'from the foreman');
  say(store, 'agent:x=qa', 'from qa');
  const tools = createToolRunner(store);
  assert.deepEqual((await tools.call('view_chat', { from: 'host' })).messages.map((m) => m.text), ['hi']);
  assert.deepEqual((await tools.call('view_chat', { from: 'FOREMAN' })).messages.map((m) => m.text), ['from the foreman']);
  assert.deepEqual((await tools.call('view_chat', { from: 'agent:x=qa' })).messages.map((m) => m.text), ['from qa']);
}));

test('view_chat unanswered_only lists the host messages still waiting on the caller', () => withStore(async (store) => {
  addQa(store);
  say(store, 'user', 'for claude', { owed: ['claude'] });
  say(store, 'user', 'for qa', { owed: ['agent:x=qa'], to: ['agent:x=qa'], context: [{ kind: 'object', id: 'o_1', label: 'Wizards' }] });
  const mine = await createToolRunner(store, null, { author: 'agent:x=qa' }).call('view_chat', { unanswered_only: true });
  assert.deepEqual(Object.keys(mine), ['messages', 'more']);
  assert.deepEqual(mine.messages.map((m) => m.text), ['for qa']);
  assert.deepEqual(mine.messages[0].to, ['agent:x=qa']);
  assert.equal(mine.messages[0].pointing_at[0].label, 'Wizards');
}));

test('view_board still works but says it is deprecated, first', () => withStore(async (store) => {
  const view = await createToolRunner(store).call('view_board', {});
  assert.equal(Object.keys(view)[0], 'notice');
  assert.equal(view.notice, DEPRECATED);
  assert.ok('brainstorm' in view && 'unanswered_chat' in view);
  assert.ok(TOOLS.find((t) => t.name === 'view_board').description.startsWith('Deprecated'));
}));

test('the board readers count as looking at the board; all four stay open during audits and prunes', () => withStore(async (store) => {
  let seen = 0;
  const tools = createToolRunner(store, { markSeen: () => (seen += 1) });
  const auditing = createToolRunner(store, null, { audit: true });
  store.beginPrune();
  for (const name of ['view_brief', 'view_brainstorm', 'view_flow', 'view_chat']) {
    assert.ok(!AUDIT_DENIED.has(name), name);
    await tools.call(name, {});
    await auditing.call(name, {});
  }
  store.endPrune();
  // view_chat shows none of the board, so it leaves the board changes to be reported.
  assert.equal(seen, 3);
}));

test('a request step in the chat says whose request it passes on', () => withStore(async (store) => {
  addQa(store);
  store.board.colab.claudeName = 'Claude · Foreman';
  say(store, 'user', 'check it', { to: ['agent:x=qa'], owed: ['agent:x=qa'], request: { by: 'claude', step: 1, of: 1 } });
  const view = await createToolRunner(store, null, { author: 'agent:x=qa' }).call('view_chat', {});
  assert.equal(view.messages[0].request_from, 'Claude · Foreman');
  assert.equal(view.unanswered[0].request_from, 'Claude · Foreman');
  say(store, 'user', 'for claude', { owed: ['claude'], request: { by: 'agent:x=qa', step: 1, of: 1 } });
  assert.equal(unansweredChat(store.board)[0].request_from, 'X · QA');
}));
