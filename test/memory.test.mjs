import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpError, applyOp, emptyBoard } from '../lib/board.mjs';
import { enforceRuledOut, findRuledOutMatches } from '../lib/memory.mjs';

const page = (b) => b.brainstorm.pages[0];
const group = (b, title, entries = [], who = 'user') =>
  applyOp(b, { type: 'addObject', kind: 'group', title, x: 0, y: 0, entries }, who).object;

test('ruling out an entry keeps it in its group, struck, and records the reason', () => {
  const b = emptyBoard();
  const g = applyOp(b, { type: 'addObject', kind: 'group', title: 'Wizards', x: 0, y: 0, entries: [{ label: 'Fireballs', text: 'damage spells' }] }, 'user').object;
  const e = g.entries[0];
  const { record, changed } = applyOp(b, { type: 'ruleOut', target: { kind: 'entry', groupId: g.id, entryId: e.id }, reason: "wizards aren't damage dealers" }, 'user');
  assert.equal(e.ruledOut, true);
  assert.equal(g.entries.length, 1);
  assert.equal(record.text, 'Fireballs: damage spells');
  assert.equal(record.reason, "wizards aren't damage dealers");
  assert.equal(record.source.label, 'Wizards');
  assert.equal(record.source.view, 'brainstorm');
  assert.equal(record.by, 'user');
  assert.match(record.id, /^r_/);
  assert.deepEqual(b.ruledOut, [record]);
  assert.ok(changed.includes(record.id) && changed.includes(g.id) && changed.includes(e.id));
  const back = applyOp(b, { type: 'bringBack', id: record.id }, 'user');
  assert.equal(e.ruledOut, false);
  assert.equal(b.ruledOut.length, 0);
  assert.ok(back.changed.includes(e.id));
});

test('an entry with no text is recorded by its label; long text is capped at 160', () => {
  const b = emptyBoard();
  const g = group(b, 'G', [{ label: 'Plain' }, { label: 'Long', text: 'x'.repeat(500) }]);
  const a = applyOp(b, { type: 'ruleOut', target: { kind: 'entry', groupId: g.id, entryId: g.entries[0].id } }, 'user').record;
  const l = applyOp(b, { type: 'ruleOut', target: { kind: 'entry', groupId: g.id, entryId: g.entries[1].id } }, 'user').record;
  assert.equal(a.text, 'Plain');
  assert.equal(a.reason, '');
  assert.equal(l.text.length, 160);
});

test('dismissing a Claude object removes it; Bring back restores it and its links', () => {
  const b = emptyBoard();
  const g = group(b, 'G');
  const n = applyOp(b, { type: 'addObject', kind: 'note', text: 'Mana from kills\nmore', near: g.id }, 'claude').object;
  const link = applyOp(b, { type: 'addLink', from: g.id, to: n.id, label: 'idea' }, 'user').link;
  const { record } = applyOp(b, { type: 'ruleOut', target: { kind: 'object', id: n.id }, reason: 'stalls' }, 'user');
  assert.equal(record.text, 'Mana from kills');
  assert.equal(record.source.label, 'Mana from kills');
  assert.equal(page(b).objects.some((o) => o.id === n.id), false);
  assert.deepEqual(page(b).links, []);
  applyOp(b, { type: 'bringBack', id: record.id }, 'user');
  assert.ok(page(b).objects.find((o) => o.id === n.id));
  assert.deepEqual(page(b).links, [link]);
  assert.equal(b.ruledOut.length, 0);
});

test('bring back drops links whose other end is gone', () => {
  const b = emptyBoard();
  const g = group(b, 'G');
  const n = applyOp(b, { type: 'addObject', kind: 'topic', text: 'T', x: 300, y: 0 }, 'user').object;
  applyOp(b, { type: 'addLink', from: g.id, to: n.id }, 'user');
  const { record } = applyOp(b, { type: 'ruleOut', target: { kind: 'object', id: n.id } }, 'user');
  applyOp(b, { type: 'deleteObject', id: g.id }, 'user');
  applyOp(b, { type: 'bringBack', id: record.id }, 'user');
  assert.equal(page(b).objects.length, 1);
  assert.deepEqual(page(b).links, []);
});

test('bring back recreates the group when the group was deleted meanwhile', () => {
  const b = emptyBoard();
  const g = group(b, 'Trolls', [{ label: 'Regenerate', text: 'heal fast' }]);
  const entryId = g.entries[0].id;
  const { record } = applyOp(b, { type: 'ruleOut', target: { kind: 'entry', groupId: g.id, entryId }, reason: 'too strong' }, 'user');
  applyOp(b, { type: 'deleteObject', id: g.id }, 'user');
  applyOp(b, { type: 'bringBack', id: record.id }, 'user');
  const made = page(b).objects.find((o) => o.kind === 'group' && o.title === 'Trolls');
  assert.ok(made);
  assert.equal(made.entries.length, 1);
  assert.equal(made.entries[0].id, entryId);
  assert.equal(made.entries[0].ruledOut, false);
});

test('bring back re-inserts a deleted entry into its surviving group', () => {
  const b = emptyBoard();
  const g = group(b, 'Trolls', [{ label: 'Regenerate' }]);
  const entryId = g.entries[0].id;
  const { record } = applyOp(b, { type: 'ruleOut', target: { kind: 'entry', groupId: g.id, entryId } }, 'user');
  applyOp(b, { type: 'deleteEntry', groupId: g.id, entryId }, 'user');
  applyOp(b, { type: 'bringBack', id: record.id }, 'user');
  assert.deepEqual(g.entries.map((e) => [e.id, e.ruledOut]), [[entryId, false]]);
});

test('flowchart cards are rejected only through ruleOut', () => {
  const b = emptyBoard();
  const { node } = applyOp(b, { type: 'addNode', title: 'Mana only on kills', x: 0, y: 0 }, 'user');
  assert.throws(() => applyOp(b, { type: 'updateNode', id: node.id, status: 'rejected' }, 'user'), /ruleOut/);
  assert.equal(node.status, 'idea');
  const { record } = applyOp(b, { type: 'ruleOut', target: { kind: 'node', id: node.id }, reason: 'stalls' }, 'user');
  assert.equal(node.status, 'rejected');
  assert.equal(record.text, 'Mana only on kills');
  assert.equal(record.source.view, 'flowchart');
  assert.equal(record.source.label, 'Mana only on kills');
  assert.throws(() => applyOp(b, { type: 'updateNode', id: node.id, status: 'idea' }, 'user'), /bringBack/);
  assert.throws(() => applyOp(b, { type: 'updateNode', id: node.id, title: 'X', status: 'accepted' }, 'user'), /bringBack/);
  assert.equal(node.title, 'Mana only on kills');
  applyOp(b, { type: 'updateNode', id: node.id, notes: 'still editable' }, 'user');
  applyOp(b, { type: 'bringBack', id: record.id }, 'user');
  assert.equal(node.status, 'idea');
});

test('bring back re-adds a deleted card as an idea', () => {
  const b = emptyBoard();
  const { node } = applyOp(b, { type: 'addNode', title: 'Gone', x: 5, y: 6 }, 'user');
  const { record } = applyOp(b, { type: 'ruleOut', target: { kind: 'node', id: node.id } }, 'user');
  applyOp(b, { type: 'deleteNode', id: node.id }, 'user');
  applyOp(b, { type: 'bringBack', id: record.id }, 'user');
  assert.equal(b.flow.nodes.length, 1);
  assert.deepEqual([b.flow.nodes[0].id, b.flow.nodes[0].status, b.flow.nodes[0].x], [node.id, 'idea', 5]);
});

test('a chat idea is remembered with its text; bring back only forgets it', () => {
  const b = emptyBoard();
  const { record } = applyOp(b, { type: 'ruleOut', target: { kind: 'idea' }, text: 'Pay to win', reason: 'unfair' }, 'user');
  assert.equal(record.text, 'Pay to win');
  assert.equal(record.source.view, 'chat');
  assert.equal(record.source.label, 'chat');
  assert.equal(record.snapshot, null);
  applyOp(b, { type: 'bringBack', id: record.id }, 'user');
  assert.deepEqual(b.ruledOut, []);
  assert.throws(() => applyOp(b, { type: 'ruleOut', target: { kind: 'idea' } }, 'user'), OpError);
});

test('an explicit text overrides the default record text', () => {
  const b = emptyBoard();
  const g = group(b, 'G', [{ label: 'A', text: 'b' }]);
  const { record } = applyOp(b, { type: 'ruleOut', target: { kind: 'entry', groupId: g.id, entryId: g.entries[0].id }, text: 'Custom wording' }, 'claude');
  assert.equal(record.text, 'Custom wording');
  assert.equal(record.by, 'claude');
});

test('invalid ruleOut and bringBack change nothing', () => {
  const b = emptyBoard();
  const g = group(b, 'G', [{ label: 'A' }]);
  const { node } = applyOp(b, { type: 'addNode', title: 'N', x: 0, y: 0 }, 'user');
  const before = JSON.stringify(b);
  for (const op of [
    { type: 'ruleOut' },
    { type: 'ruleOut', target: { kind: 'bogus' } },
    { type: 'ruleOut', target: { kind: 'entry', groupId: g.id, entryId: 'nope' } },
    { type: 'ruleOut', target: { kind: 'entry', groupId: 'nope', entryId: 'x' } },
    { type: 'ruleOut', target: { kind: 'object', id: 'nope' } },
    { type: 'ruleOut', target: { kind: 'node', id: 'nope' } },
    { type: 'ruleOut', target: { kind: 'node', id: node.id }, reason: 5 },
    { type: 'ruleOut', target: { kind: 'object', id: g.id }, reason: 5 },
    { type: 'bringBack', id: 'r_nope' },
    { type: 'bringBack' },
  ]) assert.throws(() => applyOp(b, op, 'user'), OpError, JSON.stringify(op));
  assert.equal(JSON.stringify(b), before);
});

test('ruling out the same thing twice is refused', () => {
  const b = emptyBoard();
  const g = group(b, 'G', [{ label: 'A' }]);
  const target = { kind: 'entry', groupId: g.id, entryId: g.entries[0].id };
  applyOp(b, { type: 'ruleOut', target }, 'user');
  assert.throws(() => applyOp(b, { type: 'ruleOut', target }, 'user'), /already/);
  assert.equal(b.ruledOut.length, 1);
});

test('findRuledOutMatches flags close ideas but not loose ones', () => {
  const records = [{ id: 'r_1', text: 'Wizards cast fireballs and damage spells', reason: 'x' }];
  assert.equal(findRuledOutMatches('Wizards cast fireballs', records).length, 1);
  assert.equal(findRuledOutMatches('Fireball spell for wizards', records).length, 1);
  assert.equal(findRuledOutMatches('Wizards can fly', records).length, 0);
  assert.equal(findRuledOutMatches('', records).length, 0);
  assert.equal(findRuledOutMatches('the and for', records).length, 0);
});

test('enforceRuledOut re-applies records to restored content', () => {
  const b = emptyBoard();
  const g = group(b, 'G', [{ label: 'A' }]);
  const e = g.entries[0];
  applyOp(b, { type: 'ruleOut', target: { kind: 'entry', groupId: g.id, entryId: e.id } }, 'user');
  e.ruledOut = false; // as a restored version would leave it
  const n = applyOp(b, { type: 'addObject', kind: 'note', text: 'N', x: 400, y: 0 }, 'claude').object;
  applyOp(b, { type: 'addLink', from: g.id, to: n.id }, 'user');
  const copy = structuredClone(n);
  applyOp(b, { type: 'ruleOut', target: { kind: 'object', id: n.id } }, 'user');
  page(b).objects.push(copy);
  page(b).links.push({ id: 'l_x', from: g.id, to: n.id, label: '', dashed: false, author: 'user' });
  const { node } = applyOp(b, { type: 'addNode', title: 'C', x: 0, y: 0 }, 'user');
  applyOp(b, { type: 'ruleOut', target: { kind: 'node', id: node.id } }, 'user');
  node.status = 'idea';
  enforceRuledOut(b);
  assert.equal(e.ruledOut, true);
  assert.equal(page(b).objects.some((o) => o.id === n.id), false);
  assert.equal(page(b).links.length, 0);
  assert.equal(node.status, 'rejected');
  assert.equal(b.ruledOut.length, 3);
});
