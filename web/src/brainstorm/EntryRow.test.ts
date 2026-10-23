import { expect, test } from 'vitest';
import type { Entry, Group } from '$lib/types';
import { entryMove } from './EntryRow.svelte';

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
