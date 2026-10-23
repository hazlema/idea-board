import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agentId, authorName, isAi } from '../lib/authors.mjs';
import { emptyBoard, migrateBoard } from '../lib/board.mjs';
import { renderDesignDoc } from '../lib/export.mjs';
import { BoardStore } from '../lib/store.mjs';

const ID = 'agent:x/y=qa';
const ENTRY = { id: ID, model: 'x/y', roleId: 'qa', name: 'Y · QA', modelName: 'Y', color: 'amber' };

function agentStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-board-'));
  const store = new BoardStore(path.join(dir, 'board.json'));
  store.board.colab.roster.push({ ...ENTRY });
  return { store, cleanup: () => fs.rmSync(dir, { recursive: true }) };
}

const group = (title) => ({ type: 'addObject', kind: 'group', title });

test('isAi is true for claude and agents, false for the user', () => {
  assert.equal(isAi('claude'), true);
  assert.equal(isAi('agent:openai/gpt=qa'), true);
  assert.equal(isAi('user'), false);
});

test('agentId joins model and role', () => {
  assert.equal(agentId('x/y', 'qa'), ID);
});

test('empty and migrated boards carry an empty colab', () => {
  const colab = { roster: [], lineup: { agents: [], rounds: 5, budget: 5 }, extras: { rules: '', roles: {} }, run: null };
  assert.deepEqual(migrateBoard({}).colab, colab);
  assert.deepEqual(emptyBoard().colab, colab);
  assert.deepEqual(migrateBoard({ colab: { roster: [ENTRY] } }).colab, { ...colab, roster: [ENTRY] });
});

test('an agent in the roster authors changes as an AI', () => {
  const { store, cleanup } = agentStore();
  const { object } = store.apply(group('G'), ID);
  assert.equal(object.claudeAdded, true);
  assert.equal(object.author, ID);
  const [row] = store.historyLog.entries();
  assert.equal(row.author, ID);
  assert.ok(row.turn && !/^u\d+$/.test(row.turn));
  assert.throws(() => store.apply(group('H'), 'agent:other=qa'), /unknown author/);
  cleanup();
});

test('an agent chat marks user messages handled and ends the turn', () => {
  const { store, cleanup } = agentStore();
  store.apply({ type: 'chat', text: 'hello' }, 'user');
  store.apply(group('A'), ID);
  store.apply(group('B'), ID);
  store.apply({ type: 'chat', text: 'done' }, ID);
  store.apply(group('C'), ID);
  assert.ok(store.board.chat.filter((m) => m.role === 'user').every((m) => m.handled));
  assert.equal(store.board.chat.at(-1).handled, true);
  const [a, b, c] = store.historyLog.entries().filter((e) => e.turn);
  assert.equal(a.turn, b.turn);
  assert.notEqual(b.turn, c.turn);
  cleanup();
});

test('authorName names the user, Claude and roster agents', () => {
  const board = emptyBoard();
  board.colab.roster.push(ENTRY);
  assert.equal(authorName(board, ID), 'Y · QA');
  assert.equal(authorName(board, 'user'), 'You');
  assert.equal(authorName(board, 'claude'), 'Claude');
  assert.equal(authorName(board, 'agent:gone/m=r'), 'gone/m=r');
});

test('the design doc names an agent that ruled something out', () => {
  const board = emptyBoard('T');
  board.colab.roster.push(ENTRY);
  board.ruledOut.push({ id: 'r1', text: 'Idea', reason: 'no', by: ID, at: '2026-10-22T00:00:00Z' });
  assert.match(renderDesignDoc(board, { assetsDirName: 'a', date: '2026-10-22' }), /Y · QA, 2026-10-22/);
});
