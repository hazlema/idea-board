import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OpError } from '../lib/board.mjs';
import { BoardStore } from '../lib/store.mjs';
import { boardPaths } from '../lib/paths.mjs';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'idea-board-'));

test('boardPaths derives sibling files from the board path', () => {
  const p = boardPaths('/tmp/x/plans/game.json');
  assert.equal(p.board, '/tmp/x/plans/game.json');
  assert.equal(p.base, '/tmp/x/plans/game');
  assert.equal(p.assets, '/tmp/x/plans/game.assets');
  assert.equal(p.versions, '/tmp/x/plans/game.versions');
  assert.equal(p.history, '/tmp/x/plans/game.history.jsonl');
  assert.equal(p.design, '/tmp/x/plans/game.design.md');
});

test('BoardStore persists to disk and reloads', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'board.json');
  const store = new BoardStore(file);
  store.apply({ type: 'addNode', title: 'Saved', x: 0, y: 0 }, 'user');
  const reloaded = new BoardStore(file);
  assert.equal(reloaded.board.flow.nodes[0].title, 'Saved');
  assert.equal(reloaded.board.version, 1);
  assert.equal(reloaded.paths.base, path.join(dir, 'board'));
  fs.rmSync(dir, { recursive: true });
});

test('board events carry changed as an array of ids', () => {
  const dir = tmpDir();
  const store = new BoardStore(path.join(dir, 'board.json'));
  const events = [];
  const off = store.subscribe((e) => e.type === 'board' && events.push(e));
  const { node } = store.apply({ type: 'addNode', title: 'A', x: 0, y: 0 }, 'claude');
  store.apply({ type: 'setTitle', title: 'T' }, 'user');
  off();
  store.apply({ type: 'setTitle', title: 'U' }, 'user');
  assert.equal(events.length, 2);
  assert.deepEqual(events[0].changed, [node.id]);
  assert.deepEqual(events[1].changed, []);
  assert.equal(events[0].type, 'board');
  fs.rmSync(dir, { recursive: true });
});

test('a recorded change announces history, so the History list reloads', () => {
  const dir = tmpDir();
  const store = new BoardStore(path.join(dir, 'board.json'));
  const types = [];
  store.subscribe((e) => types.push(e.type));
  store.apply({ type: 'addNode', title: 'A', x: 0, y: 0 }, 'user');
  assert.deepEqual(types, ['board', 'history']);
  fs.rmSync(dir, { recursive: true });
});

test('a v1 board file on disk loads, and saves back as v2', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'board.json');
  fs.writeFileSync(file, JSON.stringify({
    version: 9, title: 'Old', brief: { sections: [{ id: 's_1', title: 'T', text: 'x', updatedBy: 'user', updatedAt: 'a' }] },
    nodes: [{ id: 'n_1', title: 'A', notes: '', props: [], status: 'accepted', author: 'user', x: 0, y: 0 }],
    edges: [], chat: [{ id: 'm_1', role: 'user', text: 'hi', at: 'a', handled: true }], claudeSessionId: 'sess-1',
  }));
  const store = new BoardStore(file);
  assert.equal(store.board.flow.nodes.length, 1);
  store.apply({ type: 'setTitle', title: 'New' }, 'user');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.schema, 2);
  assert.equal(saved.title, 'New');
  assert.equal(saved.flow.nodes[0].title, 'A');
  assert.equal(saved.chat[0].text, 'hi');
  assert.equal(saved.claudeSessionId, 'sess-1');
  assert.equal('nodes' in saved, false);
  fs.rmSync(dir, { recursive: true });
});

test('each AI author gets its own undo turn', () => {
  const dir = tmpDir();
  const store = new BoardStore(path.join(dir, 'board.json'));
  store.board.colab.roster.push({ id: 'agent:a=b', model: 'a', roleId: 'b', name: 'A', modelName: 'A', color: 'amber' });
  const note = (text) => ({ type: 'addObject', kind: 'note', text, x: 0, y: 0 });
  const notes = () => store.board.brainstorm.pages[0].objects.filter((o) => o.kind === 'note');
  store.apply(note('one'), 'claude');
  store.apply(note('two'), 'agent:a=b');
  store.apply(note('three'), 'claude');
  store.apply(note('four'), 'agent:a=b');
  const turns = store.historyLog.entries().map((e) => e.turn);
  assert.equal(turns[0], turns[2]);
  assert.equal(turns[1], turns[3]);
  assert.notEqual(turns[0], turns[1]);
  store.undoTurn(turns[0]);
  assert.deepEqual(notes().map((n) => n.text), ['two', 'four']);
  store.historyLog.flush();
  fs.rmSync(dir, { recursive: true });
});

test('addColabSpend and setColabSpent save without history', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'board.json');
  const store = new BoardStore(file);
  store.addColabSpend(0.5);
  store.addColabSpend(0.25);
  assert.equal(store.board.colab.spent, 0.75);
  store.setColabSpent(2);
  assert.equal(new BoardStore(file).board.colab.spent, 2);
  assert.equal(store.historyLog.entries().length, 0);
  fs.rmSync(dir, { recursive: true });
});

test('addColabSpend and setColabSpent ignore a cost that is not a finite, non-negative number', () => {
  const dir = tmpDir();
  const store = new BoardStore(path.join(dir, 'board.json'));
  store.addColabSpend(0.5);
  for (const bad of [NaN, Infinity, -Infinity, -1, undefined, '2']) {
    store.addColabSpend(bad);
    store.setColabSpent(bad);
  }
  assert.equal(store.board.colab.spent, 0.5);
  store.setColabSpent(0);
  assert.equal(store.board.colab.spent, 0);
  store.historyLog.flush();
  fs.rmSync(dir, { recursive: true });
});

test("while pruning, Claude's ops are guarded and keep credit; the user's are not", () => {
  const dir = tmpDir();
  const store = new BoardStore(path.join(dir, 'board.json'));
  const { object } = store.apply({ type: 'addObject', kind: 'group', title: 'G', x: 0, y: 0, entries: [{ label: 'Plain' }] }, 'user');
  const { section } = store.apply({ type: 'addSection', title: 'S', text: 'one' }, 'user');
  const entry = object.entries[0];
  store.beginPrune();
  assert.equal(store.pruning, true);
  const snapshot = JSON.stringify(store.board);
  assert.throws(() => store.apply({ type: 'updateEntry', groupId: object.id, entryId: entry.id, label: 'x' }, 'claude'), OpError);
  assert.equal(JSON.stringify(store.board), snapshot);
  store.apply({ type: 'updateEntry', groupId: object.id, entryId: entry.id, label: 'x' }, 'user');
  store.apply({ type: 'updateSection', id: section.id, text: 'two' }, 'claude');
  const now = store.board.brief.sections.find((s) => s.id === section.id);
  assert.equal(now.text, 'two');
  assert.equal(now.updatedBy, 'user');
  store.endPrune();
  fs.rmSync(dir, { recursive: true });
});

test('a pass is one undo step', () => {
  const dir = tmpDir();
  const store = new BoardStore(path.join(dir, 'board.json'));
  const { section } = store.apply({ type: 'addSection', title: 'S', text: 'one' }, 'user');
  store.beginPrune();
  store.apply({ type: 'updateSection', id: section.id, text: 'two' }, 'claude');
  store.apply({ type: 'addSection', title: 'New', text: 'n' }, 'claude');
  store.endPrune();
  store.apply({ type: 'chat', text: 'done', answers: [] }, 'claude');
  const claude = store.historyLog.entries().filter((e) => e.author === 'claude' && e.op.type !== 'chat');
  assert.equal(claude.length, 2);
  assert.equal(claude[0].turn, claude[1].turn);
  store.undoTurn(claude[0].turn);
  assert.equal(store.board.brief.sections.length, 2);
  assert.equal(store.board.brief.sections.find((x) => x.id === section.id).text, 'one');
  assert.ok(!store.board.brief.sections.some((x) => x.title === 'New'));
  fs.rmSync(dir, { recursive: true });
});

test('after endPrune nothing is guarded', () => {
  const dir = tmpDir();
  const store = new BoardStore(path.join(dir, 'board.json'));
  const { object } = store.apply({ type: 'addObject', kind: 'group', title: 'G', x: 0, y: 0, entries: [{ label: 'Plain' }] }, 'user');
  store.beginPrune();
  store.endPrune();
  assert.equal(store.pruning, false);
  store.apply({ type: 'updateEntry', groupId: object.id, entryId: object.entries[0].id, label: 'x' }, 'claude');
  fs.rmSync(dir, { recursive: true });
});
