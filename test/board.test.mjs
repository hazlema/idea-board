import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpError, applyOp, emptyBoard, migrateBoard } from '../lib/board.mjs';

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
  applyOp(board, { type: 'chat', text: 'one' }, 'user');
  applyOp(board, { type: 'chat', text: 'two' }, 'user');
  assert.equal(board.chat.filter((m) => !m.handled).length, 2);
  applyOp(board, { type: 'chat', text: 'done' }, 'claude');
  assert.equal(board.chat.filter((m) => !m.handled).length, 0);
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
