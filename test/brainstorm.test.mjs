import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpError, applyOp, emptyBoard } from '../lib/board.mjs';
import { findObject, objectLabel, placeObject, DEFAULT_SIZE, KINDS, COLORS, CHECKS } from '../lib/brainstorm.mjs';

const A = 'a'.repeat(32) + '.png';
const B = 'b'.repeat(32) + '.jpg';
const C = '0123456789abcdef'.repeat(2) + '.webp';
const page = (b) => b.brainstorm.pages[0];
const add = (b, op, who = 'user') => applyOp(b, { type: 'addObject', ...op }, who).object;

test('constants match the shared board shape', () => {
  assert.deepEqual(KINDS, ['group', 'note', 'picture', 'topic']);
  assert.deepEqual(COLORS, ['slate', 'violet', 'green', 'amber', 'rose', 'sky']);
  assert.deepEqual(CHECKS, ['none', 'open', 'done']);
  assert.deepEqual(DEFAULT_SIZE.note, { w: 220, h: 140 });
});

test('a Claude-added group is marked; its starting entries are not', () => {
  const b = emptyBoard();
  const { object: g, changed } = applyOp(b, { type: 'addObject', kind: 'group', title: 'Wizards', entries: [{ label: 'Familiars', text: 'conjured with soul points', check: 'done' }] }, 'claude');
  assert.equal(g.claudeAdded, true);
  assert.equal(g.author, 'claude');
  assert.equal(g.entries[0].claudeAdded, false);
  assert.equal(g.entries[0].check, 'done');
  assert.equal(g.entries[0].ruledOut, false);
  assert.equal(g.w, 320);
  assert.equal(g.color, 'slate');
  assert.equal(page(b).objects.length, 1);
  assert.ok(changed.includes(g.id));
  assert.equal(add(emptyBoard(), { kind: 'note', text: 'x' }, 'user').claudeAdded, false);
});

test('objects of every kind get their own fields and timestamps', () => {
  const b = emptyBoard();
  const n = add(b, { kind: 'note', text: ' idea ', color: 'rose', x: 1, y: 2 });
  assert.deepEqual([n.text, n.color, n.w, n.h, n.x, n.y], ['idea', 'rose', 220, 140, 1, 2]);
  assert.ok(n.createdAt && n.updatedAt);
  assert.equal(n.updatedBy, 'user');
  const p = add(b, { kind: 'picture', asset: A, caption: 'map', preview: B });
  assert.deepEqual([p.asset, p.caption, p.preview, p.w, p.h], [A, 'map', B, 240, 0]);
  const t = add(b, { kind: 'topic', text: 'Combat' });
  assert.deepEqual([t.text, t.w, t.h], ['Combat', 0, 0]);
});

test('entries can be added, edited, ticked, moved between groups and deleted', () => {
  const b = emptyBoard();
  const a = applyOp(b, { type: 'addObject', kind: 'group', title: 'A', x: 0, y: 0 }, 'user').object;
  const c = applyOp(b, { type: 'addObject', kind: 'group', title: 'C', x: 600, y: 0 }, 'user').object;
  const { entry } = applyOp(b, { type: 'addEntry', groupId: a.id, label: 'Magic', text: 'shields' }, 'claude');
  assert.equal(entry.claudeAdded, true);
  assert.equal(entry.check, 'none');
  applyOp(b, { type: 'updateEntry', groupId: a.id, entryId: entry.id, text: 'shields, mind control', check: 'open' }, 'user');
  applyOp(b, { type: 'moveEntry', entryId: entry.id, toGroupId: c.id, index: 0 }, 'user');
  assert.equal(a.entries.length, 0);
  assert.equal(c.entries[0].text, 'shields, mind control');
  assert.equal(c.entries[0].check, 'open');
  applyOp(b, { type: 'deleteEntry', groupId: c.id, entryId: entry.id }, 'user');
  assert.equal(c.entries.length, 0);
});

test('addEntry honours index and moveEntry can reorder within a group', () => {
  const b = emptyBoard();
  const g = add(b, { kind: 'group', title: 'G', x: 0, y: 0 });
  const e = (label, index) => applyOp(b, { type: 'addEntry', groupId: g.id, label, text: '', index }, 'user').entry;
  const one = e('one');
  e('two');
  e('zero', 0);
  assert.deepEqual(g.entries.map((x) => x.label), ['zero', 'one', 'two']);
  applyOp(b, { type: 'moveEntry', entryId: one.id, toGroupId: g.id, index: 2 }, 'user');
  assert.deepEqual(g.entries.map((x) => x.label), ['zero', 'two', 'one']);
});

test('keep clears the Claude added mark on an object or an entry', () => {
  const b = emptyBoard();
  const g = add(b, { kind: 'group', title: 'G', x: 0, y: 0 }, 'claude');
  const { entry } = applyOp(b, { type: 'addEntry', groupId: g.id, label: 'L', text: 't' }, 'claude');
  applyOp(b, { type: 'keep', id: g.id, entryId: entry.id }, 'user');
  assert.equal(entry.claudeAdded, false);
  assert.equal(g.claudeAdded, true);
  applyOp(b, { type: 'keep', id: g.id }, 'user');
  assert.equal(g.claudeAdded, false);
});

test('updateObject edits fields and records who; moveObject does not', () => {
  const b = emptyBoard();
  const n = add(b, { kind: 'note', text: 'a', x: 0, y: 0 }, 'user');
  const before = n.updatedAt;
  applyOp(b, { type: 'moveObject', id: n.id, x: 50, y: 60, w: 300 }, 'claude');
  assert.deepEqual([n.x, n.y, n.w, n.h], [50, 60, 300, 140]);
  assert.equal(n.updatedBy, 'user');
  assert.equal(n.updatedAt, before);
  applyOp(b, { type: 'updateObject', id: n.id, text: 'b', color: 'green' }, 'claude');
  assert.deepEqual([n.text, n.color, n.updatedBy], ['b', 'green', 'claude']);
  assert.throws(() => applyOp(b, { type: 'updateObject', id: n.id, title: 'nope' }, 'user'), OpError);
});

test('setPicturePreview stores a preview on pictures only', () => {
  const b = emptyBoard();
  const p = add(b, { kind: 'picture', asset: A, x: 0, y: 0 });
  assert.equal(p.preview, null);
  applyOp(b, { type: 'setPicturePreview', id: p.id, preview: C }, 'user');
  assert.equal(p.preview, C);
  applyOp(b, { type: 'setPicturePreview', id: p.id, preview: null }, 'user');
  assert.equal(p.preview, null);
  for (const preview of ['data:image/png;base64,AA==', '../x.png', 'evil.svg']) {
    assert.throws(() => applyOp(b, { type: 'setPicturePreview', id: p.id, preview }, 'user'), OpError, preview);
  }
  assert.equal(p.preview, null);
  const n = add(b, { kind: 'note', text: 'x' });
  assert.throws(() => applyOp(b, { type: 'setPicturePreview', id: n.id, preview: 'x' }, 'user'), OpError);
});

test('links: no self links, duplicates return the existing one, label and dashed update', () => {
  const b = emptyBoard();
  const g = add(b, { kind: 'group', title: 'G', x: 0, y: 0 });
  const t = add(b, { kind: 'topic', text: 'T', x: 500, y: 0 });
  const { link } = applyOp(b, { type: 'addLink', from: g.id, to: t.id, label: 'feeds', dashed: true }, 'user');
  assert.deepEqual([link.label, link.dashed, link.author], ['feeds', true, 'user']);
  assert.equal(applyOp(b, { type: 'addLink', from: g.id, to: t.id }, 'claude').link, link);
  assert.equal(page(b).links.length, 1);
  assert.throws(() => applyOp(b, { type: 'addLink', from: g.id, to: g.id }, 'user'), OpError);
  applyOp(b, { type: 'updateLink', id: link.id, label: 'drives', dashed: false }, 'user');
  assert.deepEqual([link.label, link.dashed], ['drives', false]);
  applyOp(b, { type: 'deleteLink', id: link.id }, 'user');
  assert.equal(page(b).links.length, 0);
});

test('deleting an object removes its links', () => {
  const b = emptyBoard();
  const g = add(b, { kind: 'group', title: 'G', x: 0, y: 0 });
  const t = add(b, { kind: 'topic', text: 'T', x: 500, y: 0 });
  const o = add(b, { kind: 'note', text: 'other', x: 0, y: 500 });
  applyOp(b, { type: 'addLink', from: g.id, to: t.id }, 'user');
  applyOp(b, { type: 'addLink', from: o.id, to: g.id }, 'user');
  assert.equal(page(b).links.length, 2);
  applyOp(b, { type: 'deleteObject', id: t.id }, 'user');
  assert.equal(page(b).links.length, 1);
  assert.equal(page(b).objects.length, 2);
  applyOp(b, { type: 'deleteObject', id: g.id }, 'user');
  assert.equal(page(b).links.length, 0);
});

test('placeObject puts new things beside their neighbour without overlap', () => {
  const b = emptyBoard();
  const g = applyOp(b, { type: 'addObject', kind: 'group', title: 'G', x: 0, y: 0 }, 'user').object;
  const n1 = applyOp(b, { type: 'addObject', kind: 'note', text: 'one', near: g.id }, 'claude').object;
  const n2 = applyOp(b, { type: 'addObject', kind: 'note', text: 'two', near: g.id }, 'claude').object;
  assert.equal(n1.x, 380);
  assert.equal(n1.x, n2.x);
  assert.ok(n2.y >= n1.y + 140);
});

test('placeObject with nothing nearby goes to the origin, then right of everything', () => {
  const b = emptyBoard();
  assert.deepEqual(placeObject(page(b), { w: 220, h: 140 }), { x: 0, y: 0 });
  add(b, { kind: 'note', text: 'a', x: 100, y: 40 });
  assert.deepEqual(placeObject(page(b), { w: 220, h: 140 }), { x: 100 + 220 + 60, y: 40 });
});

test('findObject and objectLabel', () => {
  const b = emptyBoard();
  const g = add(b, { kind: 'group', title: 'Wizards', x: 0, y: 0 });
  const n = add(b, { kind: 'note', text: `${'x'.repeat(80)}\nsecond line`, x: 0, y: 300 });
  const p = add(b, { kind: 'picture', asset: A, x: 0, y: 600 });
  const p2 = add(b, { kind: 'picture', asset: B, caption: 'Map', x: 0, y: 900 });
  const t = add(b, { kind: 'topic', text: 'Combat', x: 0, y: 1200 });
  assert.equal(findObject(b, g.id).object, g);
  assert.equal(findObject(b, g.id).page, page(b));
  assert.throws(() => findObject(b, 'nope'), OpError);
  assert.deepEqual([g, n, p, p2, t].map(objectLabel), ['Wizards', 'x'.repeat(60), 'picture', 'Map', 'Combat']);
});

test('changed lists the ids an op touched', () => {
  const b = emptyBoard();
  const a = add(b, { kind: 'group', title: 'A', x: 0, y: 0 });
  const c = add(b, { kind: 'group', title: 'C', x: 600, y: 0 });
  const { entry, changed } = applyOp(b, { type: 'addEntry', groupId: a.id, label: 'L', text: 't' }, 'user');
  assert.ok(changed.includes(entry.id));
  assert.ok(applyOp(b, { type: 'moveObject', id: a.id, x: 5 }, 'user').changed.includes(a.id));
  const moved = applyOp(b, { type: 'moveEntry', entryId: entry.id, toGroupId: c.id }, 'user').changed;
  assert.ok(moved.includes(entry.id) && moved.includes(c.id));
  const { link, changed: lc } = applyOp(b, { type: 'addLink', from: a.id, to: c.id }, 'user');
  assert.ok(lc.includes(link.id));
});

test('bad brainstorm ops are refused', () => {
  const b = emptyBoard();
  const g = add(b, { kind: 'group', title: 'G', x: 0, y: 0 });
  const { entry } = applyOp(b, { type: 'addEntry', groupId: g.id, label: 'L', text: 't' }, 'user');
  const bad = (op) => assert.throws(() => applyOp(b, op, 'user'), OpError, JSON.stringify(op));
  bad({ type: 'addObject', kind: 'video' });
  bad({ type: 'addObject', kind: 'picture' });
  for (const asset of ['data:image/png;base64,AA==', '../x.png', 'evil.svg', 'a.png']) bad({ type: 'addObject', kind: 'picture', asset });
  bad({ type: 'addObject', kind: 'picture', asset: A, preview: 'data:image/png;base64,AA==' });
  bad({ type: 'addObject', kind: 'note', color: 'pink' });
  bad({ type: 'addObject', kind: 'note', near: 'nope' });
  bad({ type: 'addObject', kind: 'note', page: 'p_nope' });
  bad({ type: 'addObject', kind: 'group', title: 'x'.repeat(201) });
  bad({ type: 'addObject', kind: 'picture', asset: A, caption: 'x'.repeat(501) });
  bad({ type: 'addObject', kind: 'group', entries: [{ label: '', text: 't' }] });
  bad({ type: 'addEntry', groupId: 'nope', label: 'L', text: 't' });
  bad({ type: 'addEntry', groupId: g.id, label: 'L', text: 't', check: 'maybe' });
  bad({ type: 'updateEntry', groupId: g.id, entryId: entry.id, check: 'maybe' });
  bad({ type: 'updateEntry', groupId: g.id, entryId: 'nope' });
  bad({ type: 'moveEntry', entryId: entry.id, toGroupId: 'nope' });
  const other = add(b, { kind: 'group', title: 'Other', x: 600, y: 0 });
  bad({ type: 'moveEntry', entryId: entry.id, toGroupId: other.id, index: 'x' });
  assert.deepEqual(g.entries, [entry]);
  assert.equal(other.entries.length, 0);
  bad({ type: 'deleteEntry', groupId: g.id, entryId: 'nope' });
  bad({ type: 'addLink', from: g.id, to: g.id });
  bad({ type: 'addLink', from: g.id, to: 'nope' });
  bad({ type: 'updateLink', id: 'nope', label: 'x' });
  bad({ type: 'deleteLink', id: 'nope' });
  bad({ type: 'deleteObject', id: 'nope' });
  bad({ type: 'moveObject', id: g.id, x: 'far' });
  bad({ type: 'keep', id: 'nope' });
  bad({ type: 'keep', id: g.id, entryId: 'nope' });
  assert.equal(g.entries.length, 1);
});
