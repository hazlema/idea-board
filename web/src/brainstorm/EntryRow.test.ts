import { expect, test } from 'vitest';
import type { Entry, Group } from '$lib/types';
import { addedColon, entryMove, labelStacks } from './EntryRow.svelte';

const entry = (id: string): Entry => ({ id, label: id, text: '', check: 'none', ruledOut: false, author: 'user', claudeAdded: false });
const group = (id: string, ids: string[]): Group => ({
  id,
  kind: 'group',
  title: id,
  color: 'slate',
  entries: ids.map(entry),
  x: 0,
  y: 0,
  w: 320,
  h: 0,
  author: 'user',
  claudeAdded: false,
  createdAt: '',
  updatedAt: '',
  updatedBy: 'user',
});

const groups = [group('wiz', ['familiars', 'magic', 'towers']), group('trolls', ['regen', 'tolls'])];

test('dropping an entry on its own row leaves it where it is', () => {
  expect(entryMove(groups, 'familiars', { groupId: 'wiz', entryId: 'familiars', after: false })).toBeNull();
  expect(entryMove(groups, 'familiars', { groupId: 'wiz', entryId: 'familiars', after: true })).toBeNull();
});

test('dropping next to where it already is changes nothing', () => {
  expect(entryMove(groups, 'familiars', { groupId: 'wiz', entryId: 'magic', after: false })).toBeNull();
  expect(entryMove(groups, 'magic', { groupId: 'wiz', entryId: 'familiars', after: true })).toBeNull();
  // The end of its own group, when it is already last.
  expect(entryMove(groups, 'towers', { groupId: 'wiz', entryId: null, after: false })).toBeNull();
});

test('moving within a group accounts for the entry leaving its old place', () => {
  // Familiars after Towers: removed from 0, so "after index 2" becomes index 2.
  expect(entryMove(groups, 'familiars', { groupId: 'wiz', entryId: 'towers', after: true })).toEqual({ toGroupId: 'wiz', index: 2 });
  expect(entryMove(groups, 'familiars', { groupId: 'wiz', entryId: 'towers', after: false })).toEqual({ toGroupId: 'wiz', index: 1 });
  // Moving up needs no correction.
  expect(entryMove(groups, 'towers', { groupId: 'wiz', entryId: 'familiars', after: false })).toEqual({ toGroupId: 'wiz', index: 0 });
  expect(entryMove(groups, 'familiars', { groupId: 'wiz', entryId: null, after: false })).toEqual({ toGroupId: 'wiz' });
});

test('moving to another group lands before or after the row under the pointer, or at its end', () => {
  expect(entryMove(groups, 'towers', { groupId: 'trolls', entryId: 'regen', after: true })).toEqual({ toGroupId: 'trolls', index: 1 });
  expect(entryMove(groups, 'towers', { groupId: 'trolls', entryId: 'regen', after: false })).toEqual({ toGroupId: 'trolls', index: 0 });
  expect(entryMove(groups, 'towers', { groupId: 'trolls', entryId: null, after: false })).toEqual({ toGroupId: 'trolls' });
});

test('no drop target, or one that has gone, means no move', () => {
  expect(entryMove(groups, 'towers', { groupId: null, entryId: null, after: false })).toBeNull();
  expect(entryMove(groups, 'towers', { groupId: 'gone', entryId: null, after: false })).toBeNull();
  expect(entryMove(groups, 'towers', { groupId: 'trolls', entryId: 'gone', after: false })).toBeNull();
});

test('only a colon just typed or pasted into a label ends it', () => {
  // Typed at the end, or pasted with the text after it.
  expect(addedColon('Skill', 'Skill:', 6)).toBe(5);
  expect(addedColon('', 'Skill: Throw Dart', 17)).toBe(5);
  // A colon already there stays put while the label is edited around it.
  expect(addedColon('Forage: Pick Herbs', 'Forage: Pick Herbsx', 19)).toBe(-1);
  expect(addedColon('Forage: Pick Herbs', 'Xorage: Pick Herbs', 1)).toBe(-1);
  // A new colon after an old one is the one that counts.
  expect(addedColon('Forage: Pick Herbs', 'Forage: Pick Herbs:', 19)).toBe(18);
});

test('a label stacks above its text only while it leaves too little room beside it', () => {
  // Column 300 px: the label needs 4 px gap and 48 px of text room beside it.
  expect(labelStacks(120, 300)).toBe(false);
  expect(labelStacks(248, 300)).toBe(false);
  expect(labelStacks(249, 300)).toBe(true);
  // A long label measured at the full column width stacks...
  expect(labelStacks(300, 300)).toBe(true);
  // ...and once shortened (its own width is measured, not the column's) it goes back inline.
  expect(labelStacks(90, 300)).toBe(false);
  // Not laid out yet (no column width): inline.
  expect(labelStacks(0, 0)).toBe(false);
});
