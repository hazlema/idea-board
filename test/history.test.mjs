import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyOp, emptyBoard } from '../lib/board.mjs';
import { BoardStore } from '../lib/store.mjs';
import { HistoryLog, applyChanges, collections, describeOp, diffContent } from '../lib/history.mjs';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'idea-board-'));

// A store on a temp dir; the history log is flushed and the dir removed afterwards.
function withStore(fn, options) {
  const dir = tmpDir();
  const file = path.join(dir, 'board.json');
  const store = new BoardStore(file, options);
  try {
    return fn(store, file);
  } finally {
    store.historyLog.flush();
    fs.rmSync(dir, { recursive: true });
  }
}

const page = (board) => board.brainstorm.pages[0];
const object = (board, id) => page(board).objects.find((o) => o.id === id);
const lastTurn = (store) => store.history().entries[0].turn;

test('diff and undo restore a deleted object together with its links', () => {
  const b = emptyBoard();
  const { object: g } = applyOp(b, { type: 'addObject', kind: 'group', title: 'G' }, 'user');
  const { object: t } = applyOp(b, { type: 'addObject', kind: 'topic', text: 'T' }, 'user');
  applyOp(b, { type: 'addObject', kind: 'note', text: 'after T' }, 'user');
  applyOp(b, { type: 'addLink', from: g.id, to: t.id }, 'user');
  const before = structuredClone(b);
  applyOp(b, { type: 'deleteObject', id: t.id }, 'user');
  const changes = diffContent(before, b);
  const { applied, skipped } = applyChanges(b, changes, 'undo');
  assert.equal(applied.length, 2);
  assert.equal(skipped.length, 0);
  assert.equal(page(b).objects[1].id, t.id);
  assert.deepEqual(b.brainstorm, before.brainstorm);
  // and redo deletes them again
  applyChanges(b, changes, 'redo');
  assert.equal(object(b, t.id), undefined);
  assert.equal(page(b).links.length, 0);
});

test('undo skips an item that changed since', () => withStore((store) => {
  const { object: g } = store.apply({ type: 'addObject', kind: 'group', title: 'Wizards' }, 'user');
  const { entry } = store.apply({ type: 'addEntry', groupId: g.id, label: 'Magic' }, 'claude');
  const turn = lastTurn(store);
  assert.match(turn, /^t_[0-9a-f]{8}$/);
  store.apply({ type: 'updateEntry', groupId: g.id, entryId: entry.id, text: 'mine' }, 'user');
  const result = store.undoTurn(turn);
  assert.equal(result.undone, 0);
  assert.deepEqual(result.skipped.map((s) => s.summary), ['added “Magic” to Wizards']);
  assert.equal(object(store.board, g.id).entries[0].text, 'mine');
}));

test('typing coalesces into one undo step', () => {
  let t = 0;
  withStore((store) => {
    const [section] = store.board.brief.sections;
    for (const [at, value] of [[0, 'a'], [500, 'ab'], [900, 'abc']]) {
      t = at;
      store.apply({ type: 'updateSection', id: section.id, text: value }, 'user');
    }
    const { entries } = store.history();
    assert.equal(entries.length, 1);
    const [change] = store.historyLog.entries()[0].changes;
    assert.equal(change.before.text, '');
    assert.equal(change.after.text, 'abc');
    store.undo();
    assert.equal(store.board.brief.sections[0].text, '');
  }, { now: () => t });
});

test('coalescing stops at a different target, a gap, or another entry, and pending entries reach disk on flush', () => {
  let t = 0;
  const dir = tmpDir();
  const file = path.join(dir, 'h.history.jsonl');
  const log = new HistoryLog(file, { now: () => t, coalesceMs: 2000 });
  const change = (id, before, after) => [{ key: 'flow.nodes', id, before: { id, title: before }, after: { id, title: after }, index: 0 }];
  const edit = (id, before, after) => log.record({ author: 'user', op: { type: 'updateNode', id, title: after }, summary: `edited card “${after}”`, changes: change(id, before, after) });
  edit('n1', 'a', 'b');
  t = 100; edit('n1', 'b', 'c');
  assert.equal(log.entries().length, 1);
  assert.equal(fs.existsSync(file), false); // still pending
  t = 200; edit('n2', 'x', 'y'); // other target
  t = 3000; edit('n2', 'y', 'z'); // past the window
  t = 3100; log.record({ author: 'claude', turn: 't_00000000', op: { type: 'updateNode', id: 'n2' }, summary: 's', changes: change('n2', 'z', 'q') });
  t = 3200; edit('n2', 'q', 'r'); // a Claude entry came in between
  assert.deepEqual(log.entries().map((e) => e.changes[0].after.title), ['c', 'y', 'z', 'q', 'r']);
  assert.equal(log.entries()[0].changes[0].before.title, 'a');
  assert.equal(log.entries()[0].summary, 'edited card “c”');
  assert.deepEqual(log.entries().map((e) => e.turn), ['u1', 'u2', 'u3', 't_00000000', 'u5']);
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 4);
  log.flush();
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 5);
  fs.rmSync(dir, { recursive: true });
});

test('undo works after a restart', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'board.json');
  const a = new BoardStore(file);
  const { object: note } = a.apply({ type: 'addObject', kind: 'note', text: 'Remember me' }, 'user');
  a.historyLog.flush();
  const b = new BoardStore(file);
  assert.equal(b.undo().undone.summary, 'added note “Remember me”');
  assert.equal(object(b.board, note.id), undefined);
  // the undone flag survives another restart, so redo still works
  const c = new BoardStore(file);
  assert.equal(c.history().entries[1].undone, true);
  c.redo();
  assert.equal(object(c.board, note.id).text, 'Remember me');
  assert.equal(new BoardStore(file).history().entries[2].undone, false);
  fs.rmSync(dir, { recursive: true });
});

test('undoTurn reverts every change of one Claude reply and nothing else', () => withStore((store) => {
  const { object: u } = store.apply({ type: 'addObject', kind: 'group', title: 'U' }, 'user');
  const { object: n1 } = store.apply({ type: 'addObject', kind: 'note', text: 'N1' }, 'claude');
  const { entry: e1 } = store.apply({ type: 'addEntry', groupId: u.id, label: 'E1' }, 'claude');
  const turn1 = lastTurn(store);
  store.apply({ type: 'chat', text: 'done' }, 'claude');
  const { object: n2 } = store.apply({ type: 'addObject', kind: 'note', text: 'N2' }, 'claude');
  assert.notEqual(lastTurn(store), turn1);
  const events = [];
  store.subscribe((e) => events.push(e));
  assert.deepEqual(store.undoTurn(turn1), { undone: 2, skipped: [] });
  assert.equal(object(store.board, n1.id), undefined);
  assert.deepEqual(object(store.board, u.id).entries, []);
  assert.ok(object(store.board, u.id));
  assert.ok(object(store.board, n2.id));
  assert.deepEqual(events.map((e) => e.type), ['board', 'history']);
  assert.equal(events[0].op, 'undoTurn');
  assert.ok(events[0].changed.includes(n1.id) && events[0].changed.includes(e1.id));
  const [row] = store.history().entries;
  assert.equal(row.kind, 'undo');
  assert.equal(row.changes, undefined);
  assert.equal(store.history().entries.filter((r) => r.undone).length, 2);
}));

test('undoing a Claude reply ignores later edits elsewhere in the same group', () => withStore((store) => {
  const { object: g } = store.apply({ type: 'addObject', kind: 'group', title: 'Wizards' }, 'user');
  const { entry: mine } = store.apply({ type: 'addEntry', groupId: g.id, label: 'Familiars' }, 'user');
  store.apply({ type: 'addEntry', groupId: g.id, label: 'Magic' }, 'claude');
  const turn = lastTurn(store);
  store.apply({ type: 'updateObject', id: g.id, title: 'Mages' }, 'user');
  store.apply({ type: 'updateEntry', groupId: g.id, entryId: mine.id, check: 'done' }, 'user');
  store.apply({ type: 'addEntry', groupId: g.id, label: 'Robes' }, 'user');
  assert.deepEqual(store.undoTurn(turn), { undone: 1, skipped: [] });
  const group = object(store.board, g.id);
  assert.equal(group.title, 'Mages');
  assert.deepEqual(group.entries.map((e) => [e.label, e.check]), [['Familiars', 'done'], ['Robes', 'none']]);
  assert.equal(group.updatedBy, 'user');
}));

test('group entries diff as their own collection', () => {
  const b = emptyBoard();
  const { object: g } = applyOp(b, { type: 'addObject', kind: 'group', title: 'G', entries: [{ label: 'one' }] }, 'user');
  assert.deepEqual(collections(b).map((c) => c.key), [
    'brief.sections', 'flow.nodes', 'flow.edges',
    'brainstorm.p_main.objects', 'brainstorm.p_main.links', `brainstorm.p_main.entries.${g.id}`, 'ruledOut',
  ]);
  const before = structuredClone(b);
  applyOp(b, { type: 'addEntry', groupId: g.id, label: 'two' }, 'claude');
  const changes = diffContent(before, b);
  const objectChange = changes.find((c) => c.key === 'brainstorm.p_main.objects');
  assert.equal('entries' in objectChange.after, false);
  const entryChange = changes.find((c) => c.key === `brainstorm.p_main.entries.${g.id}`);
  assert.equal(entryChange.after.label, 'two');
  assert.equal(entryChange.index, 1);
  // a new group carries its entries, with no separate entry changes
  const before2 = structuredClone(b);
  applyOp(b, { type: 'addObject', kind: 'group', title: 'H', entries: [{ label: 'x' }] }, 'user');
  const added = diffContent(before2, b);
  assert.equal(added.length, 1);
  assert.equal(added[0].after.entries[0].label, 'x');
  // chat, version and session id are not content
  const before3 = structuredClone(b);
  applyOp(b, { type: 'chat', text: 'hi' }, 'user');
  b.version = 99;
  b.claudeSessionId = 'abc';
  assert.deepEqual(diffContent(before3, b), []);
});

test('undoing a move between groups puts the entry back in its first group', () => withStore((store) => {
  const { object: a } = store.apply({ type: 'addObject', kind: 'group', title: 'A', entries: [{ label: 'x' }, { label: 'y' }] }, 'user');
  const { object: b } = store.apply({ type: 'addObject', kind: 'group', title: 'B', entries: [{ label: 'z' }] }, 'user');
  const [x] = object(store.board, a.id).entries;
  store.apply({ type: 'moveEntry', entryId: x.id, toGroupId: b.id, index: 1 }, 'user');
  assert.equal(store.history().entries[0].summary, 'moved “x” to B');
  store.undo();
  assert.deepEqual(object(store.board, a.id).entries.map((e) => e.label), ['x', 'y']);
  assert.deepEqual(object(store.board, b.id).entries.map((e) => e.label), ['z']);
  store.redo();
  assert.deepEqual(object(store.board, b.id).entries.map((e) => e.label), ['z', 'x']);
  // and the other way round, into a group listed earlier
  store.apply({ type: 'moveEntry', entryId: x.id, toGroupId: a.id, index: 0 }, 'user');
  store.undo();
  assert.deepEqual(object(store.board, b.id).entries.map((e) => e.label), ['z', 'x']);
  store.redo();
  assert.deepEqual(object(store.board, a.id).entries.map((e) => e.label), ['x', 'y']);
  assert.deepEqual(object(store.board, b.id).entries.map((e) => e.label), ['z']);
}));

test('entry changes are skipped when their group is gone, and never duplicate an entry', () => {
  const b = emptyBoard();
  const { object: g } = applyOp(b, { type: 'addObject', kind: 'group', title: 'G' }, 'user');
  const { object: h } = applyOp(b, { type: 'addObject', kind: 'group', title: 'H' }, 'user');
  const { object: k } = applyOp(b, { type: 'addObject', kind: 'group', title: 'K' }, 'user');
  const { entry } = applyOp(b, { type: 'addEntry', groupId: g.id, label: 'e' }, 'user');
  let before = structuredClone(b);
  applyOp(b, { type: 'moveEntry', entryId: entry.id, toGroupId: h.id }, 'user');
  const move = diffContent(before, b);
  applyOp(b, { type: 'moveEntry', entryId: entry.id, toGroupId: k.id }, 'user');
  applyChanges(b, move, 'undo');
  const all = page(b).objects.flatMap((o) => o.entries.map((e) => e.id));
  assert.deepEqual(all.filter((id) => id === entry.id).length, 1);
  before = structuredClone(b);
  applyOp(b, { type: 'addEntry', groupId: g.id, label: 'f' }, 'user');
  const add = diffContent(before, b);
  applyOp(b, { type: 'deleteObject', id: g.id }, 'user');
  const { applied, skipped } = applyChanges(b, add, 'undo');
  assert.equal(applied.length, 0);
  assert.ok(skipped.some((c) => c.key === `brainstorm.p_main.entries.${g.id}`));
});

test('section order and the board title undo and redo', () => withStore((store) => {
  const [first] = store.board.brief.sections;
  const { section } = store.apply({ type: 'addSection', title: 'Second' }, 'user');
  store.apply({ type: 'moveSection', id: section.id, by: -1 }, 'user');
  store.apply({ type: 'setTitle', title: 'Renamed' }, 'user');
  const changes = store.historyLog.entries()[1].changes;
  assert.deepEqual(changes, [{ key: 'brief.sections', order: { before: [first.id, section.id], after: [section.id, first.id] } }]);
  store.undo();
  store.undo();
  assert.notEqual(store.board.title, 'Renamed');
  assert.deepEqual(store.board.brief.sections.map((s) => s.id), [first.id, section.id]);
  store.redo();
  store.redo();
  assert.equal(store.board.title, 'Renamed');
  assert.deepEqual(store.board.brief.sections.map((s) => s.id), [section.id, first.id]);
  assert.equal(store.redo().undone, null);
}));

test('redo replays the most recent undo first, and a new edit clears redo', () => withStore((store) => {
  const { node: a } = store.apply({ type: 'addNode', title: 'A', x: 0, y: 0 }, 'user');
  const { node: b } = store.apply({ type: 'addNode', title: 'B', x: 0, y: 100 }, 'user');
  store.apply({ type: 'addNode', title: 'Claude card', x: 0, y: 200 }, 'claude');
  assert.equal(store.undo().undone.summary, 'added card “B”');
  assert.equal(store.undo().undone.summary, 'added card “A”');
  assert.equal(store.redo().undone.summary, 'added card “A”');
  assert.deepEqual(store.board.flow.nodes.map((n) => n.title), ['A', 'Claude card']);
  store.apply({ type: 'setTitle', title: 'new edit' }, 'user');
  assert.deepEqual(store.redo(), { undone: null, skipped: [] });
  assert.ok(store.board.flow.nodes.some((n) => n.id === a.id));
  assert.ok(!store.board.flow.nodes.some((n) => n.id === b.id));
  // Claude's own entries are never the target of plain undo
  store.undo();
  store.undo();
  assert.deepEqual(store.board.flow.nodes.map((n) => n.title), ['Claude card']);
  assert.deepEqual(store.undo(), { undone: null, skipped: [] });
}));

test('ops with no content change record nothing; a Claude reply starts a new turn', () => withStore((store) => {
  store.apply({ type: 'chat', text: 'hello' }, 'user');
  store.apply({ type: 'tidy' }, 'user');
  assert.deepEqual(store.history().entries, []);
  const turn = store.claudeTurn;
  store.apply({ type: 'chat', text: 'reply' }, 'claude');
  assert.notEqual(store.claudeTurn, turn);
  assert.match(store.claudeTurn, /^t_[0-9a-f]{8}$/);
  assert.throws(() => store.apply({ type: 'deleteNode', id: 'missing' }, 'user'));
  assert.deepEqual(store.history().entries, []);
}));

test('history pages newest first with limit and before', () => withStore((store) => {
  for (const title of ['a', 'b', 'c', 'd']) store.apply({ type: 'addNode', title, x: 0, y: 0 }, 'user');
  const { entries } = store.history({ limit: 2 });
  assert.deepEqual(entries.map((e) => e.seq), [4, 3]);
  assert.deepEqual(store.history({ limit: 2, before: 3 }).entries.map((e) => e.seq), [2, 1]);
  assert.deepEqual(Object.keys(entries[0]).sort(), ['at', 'author', 'op', 'seq', 'summary', 'turn', 'undone']);
}));

test('describeOp names what changed', () => {
  const b = emptyBoard();
  const run = (op, author = 'user') => {
    const before = structuredClone(b);
    const result = applyOp(b, op, author);
    return describeOp(op, result, before, author);
  };
  const g = { type: 'addObject', kind: 'group', title: 'Wizards' };
  assert.equal(run(g), 'added group “Wizards”');
  const group = page(b).objects[0];
  assert.equal(run({ type: 'addEntry', groupId: group.id, label: 'Magic', text: 'damage spells' }), 'added “Magic” to Wizards');
  const [entry] = group.entries;
  assert.equal(run({ type: 'updateEntry', groupId: group.id, entryId: entry.id, check: 'done' }), 'edited “Magic” in Wizards');
  run({ type: 'addObject', kind: 'topic', text: 'Trolls' });
  const troll = page(b).objects[1];
  assert.equal(run({ type: 'moveObject', id: troll.id, x: 10, y: 10 }), 'moved “Trolls”');
  run({ type: 'addObject', kind: 'note', text: 'Scene idea\nthe dragon arrives at dawn' });
  const note = page(b).objects[2];
  assert.equal(run({ type: 'deleteObject', id: note.id }), 'deleted note “Scene idea…”');
  assert.equal(run({ type: 'ruleOut', target: { kind: 'entry', groupId: group.id, entryId: entry.id }, reason: 'no' }), 'ruled out “Magic: damage spells”');
  assert.equal(run({ type: 'bringBack', id: b.ruledOut[0].id }), 'brought back “Magic: damage spells”');
  assert.equal(run({ type: 'addNode', title: 'Mana', x: 0, y: 0 }), 'added card “Mana”');
  assert.equal(run({ type: 'deleteEntry', groupId: group.id, entryId: entry.id }), 'deleted “Magic” from Wizards');
  assert.equal(run({ type: 'addLink', from: group.id, to: troll.id }), 'linked “Wizards” to “Trolls”');
  assert.equal(run({ type: 'setTitle', title: 'Game' }), 'renamed the board “Game”');
  const long = 'x'.repeat(100);
  assert.equal(run({ type: 'addNode', title: long, x: 0, y: 0 }), `added card “${'x'.repeat(39)}…”`);
  assert.equal(describeOp({ type: 'deleteNode', id: 'gone' }, {}, b, 'user'), 'deleted card “untitled”');
});

test('a line cut short by a crash does not swallow the next entry', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'h.history.jsonl');
  const entry = (log, n) => log.record({ author: 'claude', turn: 't_00000000', op: 'addNode', summary: `s${n}`, changes: [] });
  const first = new HistoryLog(file);
  entry(first, 1);
  entry(first, 2);
  fs.appendFileSync(file, '{"seq":3,"at":"2026-');
  const second = new HistoryLog(file);
  assert.deepEqual(second.entries().map((e) => e.seq), [1, 2]);
  entry(second, 3);
  assert.deepEqual(new HistoryLog(file).entries().map((e) => e.summary), ['s1', 's2', 's3']);
  fs.rmSync(dir, { recursive: true });
});

test('redo brings back a reply undone by mistake, until the user edits again', () => withStore((store) => {
  const { node } = store.apply({ type: 'addNode', title: 'Claude card', x: 0, y: 0 }, 'claude');
  const turn = lastTurn(store);
  const has = () => store.board.flow.nodes.some((n) => n.id === node.id);
  store.undoTurn(turn);
  assert.equal(has(), false);
  assert.equal(store.redo().undone.op, 'undoTurn');
  assert.equal(has(), true);
  const rows = store.history().entries;
  assert.equal(rows.find((r) => r.op === 'addNode').undone, false);
  assert.equal(rows.find((r) => r.op === 'undoTurn').undone, true);
  assert.equal(store.redo().undone, null);
  // the reply can be undone again, and a new edit after that blocks redo
  assert.equal(store.undoTurn(turn).undone, 1);
  store.apply({ type: 'setTitle', title: 'new edit' }, 'user');
  assert.equal(store.redo().undone, null);
  assert.equal(has(), false);
}));

test('redo of a reply survives a restart', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'board.json');
  const a = new BoardStore(file);
  const { node } = a.apply({ type: 'addNode', title: 'Claude card', x: 0, y: 0 }, 'claude');
  a.undoTurn(lastTurn(a));
  const b = new BoardStore(file);
  b.redo();
  assert.ok(b.board.flow.nodes.some((n) => n.id === node.id));
  assert.equal(new BoardStore(file).redo().undone, null);
  fs.rmSync(dir, { recursive: true });
});

test('automatic picture previews record no history and do not block undo', () => withStore((store) => {
  const asset = `${'a'.repeat(32)}.png`;
  const preview = `${'b'.repeat(32)}.webp`;
  const { object: pic } = store.apply({ type: 'addObject', kind: 'picture', asset, caption: 'Map' }, 'user');
  const before = store.history().entries;
  store.apply({ type: 'setPicturePreview', id: pic.id, preview }, 'user');
  assert.deepEqual(store.history().entries, before);
  store.apply({ type: 'updateObject', id: pic.id, caption: 'World map' }, 'user');
  store.undo();
  assert.equal(object(store.board, pic.id).caption, 'Map');
  assert.equal(object(store.board, pic.id).preview, preview);
  assert.deepEqual(store.undo().skipped, []);
  assert.equal(object(store.board, pic.id), undefined);
}));
