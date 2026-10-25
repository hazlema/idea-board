import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_IMAGE_MODEL, OpError, applyOp, emptyBoard, migrateBoard } from '../lib/board.mjs';

test('addNode places a connected node beside its parent without overlap', () => {
  const board = emptyBoard();
  const { node: root } = applyOp(board, { type: 'addNode', title: 'Root', x: 0, y: 0 }, 'user');
  const { node: a } = applyOp(board, { type: 'addNode', title: 'A', near: root.id }, 'claude');
  const { node: b } = applyOp(board, { type: 'addNode', title: 'B', near: root.id }, 'claude');
  assert.equal(a.x, b.x);
  assert.ok(a.x > root.x);
  assert.notEqual(a.y, b.y);
  assert.equal(a.author, 'claude');
  assert.equal(a.status, 'idea');
});

test('updateNode patches props and only changes passed fields', () => {
  const board = emptyBoard();
  const { node } = applyOp(board, { type: 'addNode', title: 'Fireball', props: [{ key: 'cost', value: '3' }, { key: 'range', value: 'far' }], x: 0, y: 0 }, 'user');
  applyOp(board, { type: 'updateNode', id: node.id, setProps: { cost: '4', school: 'fire' }, removeProps: ['range'] }, 'claude');
  assert.deepEqual(node.props, [{ key: 'cost', value: '4' }, { key: 'school', value: 'fire' }]);
  assert.equal(node.title, 'Fireball');
  assert.equal(node.updatedBy, 'claude');
});

test('moving a node does not count as an edit', () => {
  const board = emptyBoard();
  const { node } = applyOp(board, { type: 'addNode', title: 'X', x: 0, y: 0 }, 'user');
  applyOp(board, { type: 'updateNode', id: node.id, x: 50, y: 60 }, 'claude');
  assert.equal(node.updatedBy, 'user');
  assert.equal(node.x, 50);
});

test('deleting a node removes its connections', () => {
  const board = emptyBoard();
  const { node: a } = applyOp(board, { type: 'addNode', title: 'A', x: 0, y: 0 }, 'user');
  const { node: b } = applyOp(board, { type: 'addNode', title: 'B', x: 400, y: 0 }, 'user');
  applyOp(board, { type: 'addEdge', from: a.id, to: b.id, label: 'leads to' }, 'user');
  applyOp(board, { type: 'deleteNode', id: b.id }, 'user');
  assert.equal(board.flow.edges.length, 0);
});

test('invalid input is rejected with OpError', () => {
  const board = emptyBoard();
  assert.throws(() => applyOp(board, { type: 'addNode', title: '  ' }, 'user'), OpError);
  assert.throws(() => applyOp(board, { type: 'updateNode', id: 'nope', title: 'x' }, 'user'), OpError);
  const { node } = applyOp(board, { type: 'addNode', title: 'A', x: 0, y: 0 }, 'user');
  assert.throws(() => applyOp(board, { type: 'updateNode', id: node.id, status: 'maybe' }, 'user'), OpError);
  assert.throws(() => applyOp(board, { type: 'addEdge', from: node.id, to: node.id }, 'user'), OpError);
  assert.throws(() => applyOp(board, { type: 'explode' }, 'user'), OpError);
});

test('a Claude reply marks earlier user messages as answered', () => {
  const board = emptyBoard();
  applyOp(board, { type: 'chat', text: 'one', owed: ['claude'] }, 'user');
  applyOp(board, { type: 'chat', text: 'two', owed: ['claude'] }, 'user');
  assert.equal(board.chat.filter((m) => m.owed?.length).length, 2);
  applyOp(board, { type: 'chat', text: 'done' }, 'claude');
  assert.equal(board.chat.filter((m) => m.owed?.length).length, 0);
});

test('a Claude reply with answers marks only those messages answered', () => {
  const board = emptyBoard();
  const { message: one } = applyOp(board, { type: 'chat', text: 'one', owed: ['claude'] }, 'user');
  const { message: two } = applyOp(board, { type: 'chat', text: 'two', owed: ['claude'] }, 'user');
  applyOp(board, { type: 'chat', text: 'done', answers: [one.id] }, 'claude');
  assert.deepEqual(board.chat.filter((m) => m.owed?.length).map((m) => m.id), [two.id]);
  // The user cannot mark messages answered this way.
  applyOp(board, { type: 'chat', text: 'three', answers: [two.id] }, 'user');
  assert.deepEqual(board.chat.find((m) => m.id === two.id).owed, ['claude']);
  assert.throws(() => applyOp(board, { type: 'chat', text: 'x', answers: 'all' }, 'claude'), /answers/);
});

test('tidy lays nodes out left to right by connection depth, even with a cycle', () => {
  const board = emptyBoard();
  const add = (title) => applyOp(board, { type: 'addNode', title, x: Math.round(Math.random() * 500), y: Math.round(Math.random() * 500) }, 'user').node;
  const [a, b, c, d, lone] = ['A', 'B', 'C', 'D', 'Lone'].map(add);
  // In a loop every node has a parent; the topmost card becomes the start.
  a.y = -100;
  for (const [from, to] of [[a, b], [a, c], [b, d], [c, d], [d, a]]) applyOp(board, { type: 'addEdge', from: from.id, to: to.id }, 'user');
  applyOp(board, { type: 'tidy' }, 'user');
  assert.ok(a.x < b.x && b.x === c.x && c.x < d.x, 'columns follow depth');
  assert.notEqual(b.y, c.y);
  assert.ok(lone.x > d.x, 'unconnected nodes go last');
  const spots = new Set(board.flow.nodes.map((n) => `${n.x},${n.y}`));
  assert.equal(spots.size, board.flow.nodes.length, 'no two nodes share a spot');
});

test('brief sections can be added, edited, reordered and removed', () => {
  const board = emptyBoard();
  assert.equal(board.brief.sections.length, 1, 'new boards start with one box');
  const first = board.brief.sections[0];
  const { section: goals } = applyOp(board, { type: 'addSection', title: 'Goals', text: '  keep\nspacing  ' }, 'claude');
  assert.equal(goals.text, '  keep\nspacing  ');
  assert.equal(goals.updatedBy, 'claude');
  applyOp(board, { type: 'updateSection', id: first.id, text: 'A warlock roguelite' }, 'user');
  assert.equal(first.text, 'A warlock roguelite');
  applyOp(board, { type: 'moveSection', id: goals.id, by: -1 }, 'user');
  assert.deepEqual(board.brief.sections.map((x) => x.title), ['Goals', "What we're building"]);
  applyOp(board, { type: 'deleteSection', id: goals.id }, 'user');
  assert.equal(board.brief.sections.length, 1);
  assert.throws(() => applyOp(board, { type: 'updateSection', id: 'nope', text: 'x' }, 'user'), OpError);
});

test('boards saved before the brief existed migrate with a default brief', () => {
  const b = migrateBoard({ version: 3, title: 'Old', nodes: [], edges: [], chat: [] });
  assert.equal(b.brief.sections.length, 1);
});

test('new boards use schema 2 with one brainstorm page', () => {
  const b = emptyBoard('X');
  assert.equal(b.schema, 2);
  assert.deepEqual(b.flow, { nodes: [], edges: [] });
  assert.equal(b.brainstorm.pages[0].id, 'p_main');
  assert.deepEqual(b.ruledOut, []);
});

const v1Board = () => ({
  version: 9, title: 'Old', brief: { sections: [{ id: 's_1', title: 'T', text: 'x', updatedBy: 'user', updatedAt: 'a' }] },
  nodes: [{ id: 'n_1', title: 'A', notes: '', props: [], status: 'accepted', author: 'user', x: 0, y: 0 }],
  edges: [{ id: 'e_1', from: 'n_1', to: 'n_1', label: '', author: 'user' }],
  chat: [{ id: 'm_1', role: 'user', text: 'hi', at: 'a', handled: true }], claudeSessionId: 'sess-1',
});

test('migrateBoard turns a v1 board into v2 without losing anything', () => {
  const b = migrateBoard(v1Board());
  assert.equal(b.schema, 2);
  assert.equal(b.flow.nodes[0].title, 'A');
  assert.equal(b.flow.edges[0].id, 'e_1');
  assert.equal(b.brief.sections[0].text, 'x');
  assert.equal(b.chat[0].text, 'hi');
  assert.equal(b.claudeSessionId, 'sess-1');
  assert.equal(b.version, 9);
  assert.equal('nodes' in b, false);
  assert.equal('edges' in b, false);
  assert.equal(b.brainstorm.pages[0].id, 'p_main');
  assert.deepEqual(b.ruledOut, []);
});

test('migrateBoard is idempotent and fills missing keys', () => {
  const once = migrateBoard(v1Board());
  assert.deepEqual(migrateBoard(structuredClone(once)), once);
  const partial = migrateBoard({ schema: 2, title: 'P', flow: { nodes: [], edges: [] } });
  assert.equal(partial.brainstorm.pages[0].id, 'p_main');
  assert.deepEqual(partial.chat, []);
  assert.equal(partial.claudeSessionId, null);
  assert.equal(partial.brief.sections.length, 1);
});

test('an AI chat message may carry turn stats; a user message may not, and junk is refused', () => {
  const board = emptyBoard();
  applyOp(board, { type: 'chat', text: 'done', stats: { seconds: 42.4, cost: 0.031, calls: 3, promptTokens: 9000, cachedTokens: 6000 } }, 'claude');
  assert.deepEqual(board.chat.at(-1).stats, { seconds: 42.4, cost: 0.031, calls: 3, promptTokens: 9000, cachedTokens: 6000 });
  applyOp(board, { type: 'chat', text: 'hi', stats: { seconds: 1, cost: 0, calls: 1, promptTokens: 1, cachedTokens: 0 } }, 'user');
  assert.equal(board.chat.at(-1).stats, undefined);
  assert.throws(() => applyOp(board, { type: 'chat', text: 'x', stats: { seconds: 'a' } }, 'claude'), /stats/);
});

test('a board saved before the turn limit existed gets the 30 minute default', () => {
  const b = migrateBoard({ ...emptyBoard(), colab: { roster: [], lineup: { agents: [], rounds: 3, budget: 2 }, extras: { rules: '', roles: {} }, run: null } });
  assert.deepEqual(b.colab.lineup, { agents: [], rounds: 3, budget: 2, turnLimit: 30, claudeRoleId: 'foreman', imageModel: DEFAULT_IMAGE_MODEL, pruneLimit: 5, pruneAggressiveness: 'normal' });
});

test('user chat stores owed/to/start', () => {
  const board = emptyBoard();
  const { message } = applyOp(board, { type: 'chat', text: 'hi', owed: ['claude'], to: ['claude'], start: true }, 'user');
  assert.deepEqual(message.owed, ['claude']);
  assert.deepEqual(message.to, ['claude']);
  assert.equal(message.start, true);
  assert.equal('handled' in message, false);
  const { message: plain } = applyOp(board, { type: 'chat', text: 'yo' }, 'user');
  assert.deepEqual(plain.owed, []);
  assert.equal('to' in plain, false);
  assert.equal('start' in plain, false);
});

test('unknown ids in owed are refused', () => {
  const board = emptyBoard();
  assert.throws(() => applyOp(board, { type: 'chat', text: 'hi', owed: ['agent:nobody'] }, 'user'), /unknown connection/);
  assert.throws(() => applyOp(board, { type: 'chat', text: 'hi', to: ['agent:nobody'] }, 'user'), /unknown connection/);
});

test('an AI answer clears only its own owed', () => {
  const board = emptyBoard();
  board.colab.roster.push({ id: 'agent:a=b', model: 'a', roleId: 'b', name: 'A', modelName: 'A', color: 'amber' });
  const { message } = applyOp(board, { type: 'chat', text: 'q', owed: ['claude', 'agent:a=b'] }, 'user');
  applyOp(board, { type: 'chat', text: 'x', answers: [message.id] }, 'claude');
  assert.deepEqual(board.chat[0].owed, ['agent:a=b']);
});

test('migration turns handled into owed', () => {
  const b = migrateBoard({ chat: [{ id: 'm_1', role: 'user', text: 'a', at: 'a', handled: false }, { id: 'm_2', role: 'user', text: 'b', at: 'a', handled: true }] });
  assert.deepEqual(b.chat.map((m) => m.owed), [['claude'], []]);
  assert.ok(b.chat.every((m) => !('handled' in m)));
  assert.equal(b.colab.spent, 0);
  assert.equal(b.colab.claudeName, 'Claude');
  assert.equal(b.colab.lineup.claudeRoleId, 'foreman');
});

test('setColabLineup keeps or sets claudeRoleId', () => {
  const board = emptyBoard();
  const lineup = { type: 'setColabLineup', agents: [], rounds: 3, budget: 2 };
  assert.equal(applyOp(board, lineup, 'user').lineup.claudeRoleId, 'foreman');
  assert.equal(applyOp(board, { ...lineup, claudeRoleId: 'qa' }, 'user').lineup.claudeRoleId, 'qa');
  assert.equal(applyOp(board, lineup, 'user').lineup.claudeRoleId, 'qa');
  assert.throws(() => applyOp(board, { ...lineup, claudeRoleId: '' }, 'user'), OpError);
});

test('lineup keeps image and Claude models', () => {
  const board = emptyBoard();
  const lineup = { type: 'setColabLineup', agents: [], rounds: 3, budget: 2 };
  assert.equal(board.colab.lineup.imageModel, DEFAULT_IMAGE_MODEL);
  const set = applyOp(board, { ...lineup, imageModel: ' google/x-image ', claudeModel: ' opus ' }, 'user').lineup;
  assert.equal(set.imageModel, 'google/x-image');
  assert.equal(set.claudeModel, 'opus');
  const kept = applyOp(board, lineup, 'user').lineup;
  assert.equal(kept.imageModel, 'google/x-image');
  assert.equal(kept.claudeModel, 'opus');
  assert.throws(() => applyOp(board, { ...lineup, claudeModel: '' }, 'user'), OpError);
  assert.throws(() => applyOp(board, { ...lineup, imageModel: 'x'.repeat(201) }, 'user'), OpError);
  assert.equal(migrateBoard({ colab: { lineup: { agents: [] } } }).colab.lineup.claudeModel, undefined);
  assert.equal(migrateBoard({ colab: { lineup: { agents: [] } } }).colab.lineup.imageModel, DEFAULT_IMAGE_MODEL);
  // A board saved with no image model chosen gets the default; clearing the field goes back to it.
  assert.equal(migrateBoard({ colab: { lineup: { agents: [], imageModel: '' } } }).colab.lineup.imageModel, DEFAULT_IMAGE_MODEL);
  assert.equal(applyOp(board, { ...lineup, imageModel: '  ' }, 'user').lineup.imageModel, DEFAULT_IMAGE_MODEL);
});

test('resetColabSpent and setClaudeName', () => {
  const board = emptyBoard();
  board.colab.spent = 3;
  applyOp(board, { type: 'resetColabSpent' }, 'user');
  applyOp(board, { type: 'setClaudeName', name: 'Opus' }, 'user');
  assert.equal(board.colab.spent, 0);
  assert.equal(board.colab.claudeName, 'Opus');
});

const lineupOp = (extra = {}) => ({ type: 'setColabLineup', agents: [], rounds: 3, budget: 2, ...extra });

test('lineup keeps prune settings', () => {
  const board = emptyBoard();
  assert.equal(board.colab.lineup.pruneLimit, 5);
  assert.equal(board.colab.lineup.pruneAggressiveness, 'normal');
  applyOp(board, lineupOp({ pruneLimit: 3, pruneAggressiveness: 'aggressive' }), 'user');
  assert.equal(board.colab.lineup.pruneLimit, 3);
  assert.equal(board.colab.lineup.pruneAggressiveness, 'aggressive');
  applyOp(board, lineupOp(), 'user');
  assert.equal(board.colab.lineup.pruneLimit, 3);
  assert.equal(board.colab.lineup.pruneAggressiveness, 'aggressive');
  applyOp(board, lineupOp({ pruneLimit: null }), 'user');
  assert.equal(board.colab.lineup.pruneLimit, null);
  applyOp(board, lineupOp(), 'user');
  assert.equal(board.colab.lineup.pruneLimit, null);
  for (const bad of [0, 51, 2.5, '5']) assert.throws(() => applyOp(board, lineupOp({ pruneLimit: bad }), 'user'), OpError);
  assert.throws(() => applyOp(board, lineupOp({ pruneAggressiveness: 'wild' }), 'user'), OpError);
});

test('migration fills the prune settings and keeps an explicit null limit', () => {
  const colab = (lineup) => ({ ...emptyBoard(), colab: { roster: [], lineup, extras: { rules: '', roles: {} }, run: null } });
  const filled = migrateBoard(colab({ agents: [], rounds: 3, budget: 2 }));
  assert.equal(filled.colab.lineup.pruneLimit, 5);
  assert.equal(filled.colab.lineup.pruneAggressiveness, 'normal');
  assert.equal(filled.colab.lastPruneAt, null);
  assert.equal(migrateBoard(colab({ agents: [], rounds: 3, budget: 2, pruneLimit: null })).colab.lineup.pruneLimit, null);
});

test('new entries and sections carry createdAt', () => {
  const board = emptyBoard();
  const iso = /^\d{4}-\d\d-\d\dT/;
  const { section } = applyOp(board, { type: 'addSection', title: 'S' }, 'user');
  assert.match(section.createdAt, iso);
  const { object } = applyOp(board, { type: 'addObject', kind: 'group', title: 'G', entries: [{ label: 'a' }] }, 'user');
  assert.match(object.entries[0].createdAt, iso);
  const { entry } = applyOp(board, { type: 'addEntry', groupId: object.id, label: 'b' }, 'user');
  assert.match(entry.createdAt, iso);
});

test('migrateBoard normalizes hand-edited prune settings', () => {
  const fix = (lineup) => migrateBoard({ ...emptyBoard(), colab: { ...emptyBoard().colab, lineup: { ...emptyBoard().colab.lineup, ...lineup } } }).colab.lineup;
  for (const bad of [0, 51, 2.5, '5', NaN]) assert.equal(fix({ pruneLimit: bad }).pruneLimit, 5);
  assert.equal(fix({ pruneLimit: null }).pruneLimit, null);
  assert.equal(fix({ pruneLimit: 7 }).pruneLimit, 7);
  assert.equal(fix({ pruneAggressiveness: 'wild' }).pruneAggressiveness, 'normal');
  assert.equal(fix({ pruneAggressiveness: 'gentle' }).pruneAggressiveness, 'gentle');
  const b = migrateBoard({ ...emptyBoard(), colab: { ...emptyBoard().colab, lineup: { ...emptyBoard().colab.lineup, pruneLimit: 0 } } });
  assert.doesNotThrow(() => applyOp(b, { type: 'setColabLineup', ...b.colab.lineup }, 'user'));
});
