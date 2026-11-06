import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOp, emptyBoard, OpError } from '../lib/board.mjs';
import { lockGuard } from '../lib/locks.mjs';

function sample() {
  const b = emptyBoard('Locks');
  const group = applyOp(b, { type: 'addObject', kind: 'group', title: 'Pitches', x: 0, y: 0, entries: [{ label: 'Fact' }, { label: 'Box', check: 'open' }] }, 'user').object;
  const other = applyOp(b, { type: 'addObject', kind: 'group', title: 'Other', x: 400, y: 0 }, 'user').object;
  const [fact, box] = group.entries;
  return { b, group, other, fact, box };
}

test('the host adding a plain bullet locks it; with a checkbox it does not', () => {
  const { b, group, fact, box } = sample();
  assert.equal(fact.locked, true);
  assert.equal(box.locked, false);
  const added = applyOp(b, { type: 'addEntry', groupId: group.id, label: 'Typed' }, 'user').entry;
  assert.equal(added.locked, true);
});

test('the host removing a checkbox locks; adding one back unlocks', () => {
  const { b, group, box } = sample();
  applyOp(b, { type: 'updateEntry', groupId: group.id, entryId: box.id, check: 'none' }, 'user');
  assert.equal(box.locked, true);
  applyOp(b, { type: 'updateEntry', groupId: group.id, entryId: box.id, check: 'open' }, 'user');
  assert.equal(box.locked, false);
});

test('an AI author making its own entry plain does not lock it', () => {
  const { b, group } = sample();
  const mine = applyOp(b, { type: 'addEntry', groupId: group.id, label: 'Agent note' }, 'claude').entry;
  assert.equal(mine.locked, false);
  const boxed = applyOp(b, { type: 'addEntry', groupId: group.id, label: 'Agent box', check: 'open' }, 'claude').entry;
  applyOp(b, { type: 'updateEntry', groupId: group.id, entryId: boxed.id, check: 'none' }, 'claude');
  assert.equal(boxed.locked, false);
});

test('lockGuard refuses every AI op that touches a locked entry', () => {
  const { b, group, other, fact } = sample();
  const at = { groupId: group.id, entryId: fact.id };
  for (const op of [
    { type: 'updateEntry', ...at, text: 'x' },
    { type: 'updateEntry', ...at, check: 'open' },
    { type: 'deleteEntry', ...at },
    { type: 'moveEntry', entryId: fact.id, toGroupId: other.id },
    { type: 'ruleOut', target: { kind: 'entry', ...at }, reason: 'no' },
    { type: 'deleteObject', id: group.id },
  ]) assert.throws(() => lockGuard(b, op), (e) => e instanceof OpError && /locked/.test(e.message) && e.message.includes('Fact'), JSON.stringify(op));
});

test('lockGuard allows ops on unlocked entries and adding entries to a group with a locked one', () => {
  const { b, group, other, box } = sample();
  for (const op of [
    { type: 'updateEntry', groupId: group.id, entryId: box.id, text: 'x' },
    { type: 'deleteEntry', groupId: group.id, entryId: box.id },
    { type: 'addEntry', groupId: group.id, label: 'New' },
    { type: 'deleteObject', id: other.id },
    { type: 'updateEntry', groupId: group.id, entryId: 'en_nope', text: 'x' },
  ]) assert.doesNotThrow(() => lockGuard(b, op), JSON.stringify(op));
});
