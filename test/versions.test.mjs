import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BoardStore } from '../lib/store.mjs';
import { VersionStore } from '../lib/versions.mjs';

function withStore(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-board-'));
  const store = new BoardStore(path.join(dir, 'board.json'));
  try {
    return fn(store, dir);
  } finally {
    store.historyLog.flush();
    fs.rmSync(dir, { recursive: true });
  }
}

const objects = (store) => store.board.brainstorm.pages[0].objects;

// A board with group "Wizards" > "Fireballs", saved as version "first"; then
// the user rules out Fireballs and chats, and Claude adds a note.
function setUp(store) {
  const { object: group } = store.apply({ type: 'addObject', kind: 'group', title: 'Wizards' }, 'user');
  const { entry } = store.apply({ type: 'addEntry', groupId: group.id, label: 'Fireballs' }, 'user');
  const first = store.saveVersion('first', 'user');
  store.apply({ type: 'ruleOut', target: { kind: 'entry', groupId: group.id, entryId: entry.id }, reason: 'too flashy' }, 'user');
  store.apply({ type: 'chat', text: 'hello' }, 'user');
  const { object: note } = store.apply({ type: 'addObject', kind: 'note', text: 'N' }, 'claude');
  return { group, entry, first, note };
}

test('restoring a version brings content back but keeps memory and chat', () => withStore((store) => {
  const { group, entry, first, note } = setUp(store);
  const { restored, backup } = store.restoreVersion(first.id, 'user');
  assert.equal(restored.id, first.id);
  assert.equal(objects(store).find((o) => o.id === note.id), undefined);
  const fireballs = objects(store).find((o) => o.id === group.id).entries.find((e) => e.id === entry.id);
  assert.equal(fireballs.ruledOut, true);
  assert.equal(store.board.ruledOut.length, 1);
  assert.ok(store.board.chat.some((m) => m.text === 'hello'));
  assert.equal(backup.auto, true);
  assert.equal(backup.name, 'Before restoring “first”');
  assert.ok(store.versions.list().some((v) => v.id === backup.id));
  assert.equal(store.versions.read(backup.id).content.brainstorm.pages[0].objects.some((o) => o.id === note.id), true);
}));

test('restoring a version saved while an item was ruled out, after bringing it back, does not leave it stuck', () => withStore((store) => {
  const { object: group } = store.apply({ type: 'addObject', kind: 'group', title: 'Wizards' }, 'user');
  const { entry } = store.apply({ type: 'addEntry', groupId: group.id, label: 'Fireballs' }, 'user');
  const { node } = store.apply({ type: 'addNode', title: 'Pay to win', x: 0, y: 0 }, 'user');
  store.apply({ type: 'ruleOut', target: { kind: 'entry', groupId: group.id, entryId: entry.id } }, 'user');
  store.apply({ type: 'ruleOut', target: { kind: 'node', id: node.id } }, 'user');
  const saved = store.saveVersion('ruled out', 'user');
  for (const record of [...store.board.ruledOut]) store.apply({ type: 'bringBack', id: record.id }, 'user');
  store.restoreVersion(saved.id, 'user');
  const fireballs = objects(store).find((o) => o.id === group.id).entries.find((e) => e.id === entry.id);
  assert.equal(fireballs.ruledOut, false);
  assert.equal(store.board.flow.nodes.find((n) => n.id === node.id).status, 'idea');
  store.apply({ type: 'updateNode', id: node.id, status: 'accepted' }, 'user');
}));

test('a restore can be undone', () => withStore((store) => {
  const { first, note } = setUp(store);
  store.restoreVersion(first.id, 'user');
  assert.equal(store.historyLog.entries().at(-1).kind, 'restore');
  assert.match(store.history().entries[0].summary, /restored version “first”/);
  store.undo();
  assert.ok(objects(store).find((o) => o.id === note.id));
}));

test('a restore by Claude belongs to Claude’s turn and can be undone as a reply', () => withStore((store) => {
  const { first, note } = setUp(store);
  store.apply({ type: 'chat', text: 'done with that' }, 'claude'); // ends Claude's earlier turn
  store.restoreVersion(first.id, 'claude');
  const row = store.history().entries[0];
  assert.equal(row.author, 'claude');
  assert.equal(row.kind, 'restore');
  assert.equal(objects(store).find((o) => o.id === note.id), undefined);
  store.undoTurn(row.turn);
  assert.ok(objects(store).find((o) => o.id === note.id));
}));

test('restoring an unknown or malformed id fails with 404 and changes nothing', () => withStore((store) => {
  const before = JSON.stringify(store.board);
  for (const id of ['v_20200101-000000_abcd', '../board', 'nope']) {
    assert.throws(() => store.restoreVersion(id, 'user'), (error) => error.status === 404);
  }
  assert.equal(JSON.stringify(store.board), before);
  assert.deepEqual(store.versions.list(), []);
}));

test('versions survive a restart and list newest first with stats', () => withStore((store, dir) => {
  const { object: group } = store.apply({ type: 'addObject', kind: 'group', title: 'G' }, 'user');
  store.apply({ type: 'addEntry', groupId: group.id, label: 'one' }, 'user');
  store.apply({ type: 'addEntry', groupId: group.id, label: 'two' }, 'user');
  store.apply({ type: 'addObject', kind: 'note', text: 'n' }, 'user');
  store.saveVersion('a', 'user');
  store.apply({ type: 'addObject', kind: 'group', title: 'H' }, 'user');
  store.saveVersion('b', 'claude');
  const reopened = new VersionStore(path.join(dir, 'board.versions'));
  const list = reopened.list();
  assert.deepEqual(list.map((v) => v.name), ['b', 'a']);
  assert.deepEqual(list[1].stats, { groups: 1, entries: 2, notes: 1, pictures: 0, cards: 0 });
  assert.equal(list[0].stats.groups, 2);
  assert.equal(list[0].author, 'claude');
  assert.equal(list[0].auto, false);
  assert.match(list[0].id, /^v_\d{8}-\d{6}_[0-9a-f]{4}$/);
  assert.deepEqual(Object.keys(reopened.read(list[0].id).content).sort(), ['brainstorm', 'brief', 'flow', 'title']);
}));
