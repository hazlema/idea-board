import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { emptyBoard } from '../test-board';
import type { Entry, Group, RuledOut } from '$lib/types';

vi.mock('$lib/api', () => ({ op: vi.fn().mockResolvedValue({}) }));

import * as api from '$lib/api';
import { live } from '$lib/live.svelte';
import GroupBox from './GroupBox.svelte';

const entry = (id: string, label: string, text: string, extra: Partial<Entry> = {}): Entry => ({
  id,
  label,
  text,
  check: 'none',
  ruledOut: false,
  author: 'user',
  claudeAdded: false,
  ...extra,
});

const group = (entries: Entry[], extra: Partial<Group> = {}): Group => ({
  id: 'o_wiz',
  kind: 'group',
  title: 'Wizards',
  color: 'violet',
  entries,
  x: 0,
  y: 0,
  w: 320,
  h: 0,
  author: 'user',
  claudeAdded: false,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  updatedBy: 'user',
  ...extra,
});

// GroupBox reads the board to find where an entry lives when it saves.
function onBoard(g: Group, ruledOut: RuledOut[] = []): Group {
  const board = emptyBoard();
  board.brainstorm.pages[0].objects = [g];
  board.ruledOut = ruledOut;
  live.board = board;
  return g;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(api.op).mockReset();
  vi.mocked(api.op).mockResolvedValue({});
  live.pointing = null;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test('a focused entry keeps what you are typing when Claude updates the group', async () => {
  const g = onBoard(group([entry('en_magic', 'Magic', 'shields')]));
  const { rerender } = render(GroupBox, { group: g });
  const text = screen.getByDisplayValue('shields') as HTMLTextAreaElement;
  text.focus();
  await fireEvent.input(text, { target: { value: 'shields and wards' } });

  // Claude renames the group; the entry text on the server is still the old one.
  await rerender({ group: onBoard(group([entry('en_magic', 'Magic', 'shields')], { title: 'Mages', updatedBy: 'claude' })) });
  await vi.advanceTimersByTimeAsync(0);
  expect(text.value).toBe('shields and wards');
  expect(screen.getByDisplayValue('Mages')).toBeInTheDocument();

  // The save goes out, and the field still shows the typing while it has focus.
  await vi.advanceTimersByTimeAsync(600);
  expect(api.op).toHaveBeenCalledWith({ type: 'updateEntry', groupId: 'o_wiz', entryId: 'en_magic', text: 'shields and wards' });
  await rerender({ group: onBoard(group([entry('en_magic', 'Magic', 'shields')], { title: 'Mages again' })) });
  expect(text.value).toBe('shields and wards');
});

test('after focus leaves, an entry shows the server value again', async () => {
  const g = onBoard(group([entry('en_magic', 'Magic', 'shields')]));
  const { rerender } = render(GroupBox, { group: g });
  const text = screen.getByDisplayValue('shields') as HTMLTextAreaElement;
  text.focus();
  await fireEvent.input(text, { target: { value: 'shields and wards' } });
  text.blur();
  await vi.advanceTimersByTimeAsync(0);
  // Blur saves straight away.
  expect(api.op).toHaveBeenCalledWith({ type: 'updateEntry', groupId: 'o_wiz', entryId: 'en_magic', text: 'shields and wards' });

  await rerender({ group: onBoard(group([entry('en_magic', 'Magic', 'shields and wards')])) });
  await rerender({ group: onBoard(group([entry('en_magic', 'Magic', 'Claude rewrote it')])) });
  expect(text.value).toBe('Claude rewrote it');
});

test('a change Claude made while you were typing shows once focus leaves (your text was already saved)', async () => {
  const g = onBoard(group([entry('en_magic', 'Magic', 'shields')]));
  const { rerender } = render(GroupBox, { group: g });
  const text = screen.getByDisplayValue('shields') as HTMLTextAreaElement;
  text.focus();
  await fireEvent.input(text, { target: { value: 'shields and wards' } });
  await vi.advanceTimersByTimeAsync(600);
  expect(api.op).toHaveBeenCalledTimes(1);

  await rerender({ group: onBoard(group([entry('en_magic', 'Magic', 'shields and wards')])) });
  await rerender({ group: onBoard(group([entry('en_magic', 'Magic', 'Claude rewrote it')])) });
  expect(text.value).toBe('shields and wards');
  text.blur();
  await vi.advanceTimersByTimeAsync(0);
  expect(text.value).toBe('Claude rewrote it');
  expect(api.op).toHaveBeenCalledTimes(1);
});

test('a failed save keeps the typing and tries again when focus next leaves', async () => {
  const g = onBoard(group([entry('en_magic', 'Magic', 'shields')]));
  vi.mocked(api.op).mockRejectedValueOnce(new Error('Could not reach the board server'));
  render(GroupBox, { group: g });
  const text = screen.getByDisplayValue('shields') as HTMLTextAreaElement;
  text.focus();
  await fireEvent.input(text, { target: { value: 'shields and wards' } });
  text.blur();
  await vi.advanceTimersByTimeAsync(0);
  expect(text.value).toBe('shields and wards');

  text.focus();
  text.blur();
  await vi.advanceTimersByTimeAsync(0);
  expect(api.op).toHaveBeenCalledTimes(2);
  expect(api.op).toHaveBeenLastCalledWith({ type: 'updateEntry', groupId: 'o_wiz', entryId: 'en_magic', text: 'shields and wards' });
});

test('Keep and Dismiss send keep and ruleOut', async () => {
  const g = onBoard(group([entry('en_duel', 'Staff duels', 'ritual duels', { author: 'claude', claudeAdded: true })]));
  render(GroupBox, { group: g });
  expect(screen.getByText('Claude added')).toBeInTheDocument();

  await fireEvent.click(screen.getByRole('button', { name: 'Keep' }));
  expect(api.op).toHaveBeenCalledWith({ type: 'keep', id: 'o_wiz', entryId: 'en_duel' });

  const prompt = vi.spyOn(window, 'prompt').mockReturnValue('too violent');
  await fireEvent.click(screen.getByRole('button', { name: 'Dismiss…' }));
  expect(prompt).toHaveBeenCalledWith('Why not?');
  expect(api.op).toHaveBeenCalledWith({ type: 'ruleOut', target: { kind: 'entry', groupId: 'o_wiz', entryId: 'en_duel' }, reason: 'too violent' });
});

test('cancelling Dismiss… sends nothing', async () => {
  const g = onBoard(group([entry('en_duel', 'Staff duels', '', { claudeAdded: true })]));
  render(GroupBox, { group: g });
  vi.spyOn(window, 'prompt').mockReturnValue(null);
  await fireEvent.click(screen.getByRole('button', { name: 'Dismiss…' }));
  expect(api.op).not.toHaveBeenCalled();
});

test('ruled-out entries fold into "1 ruled out"', async () => {
  const record: RuledOut = {
    id: 'r_fire',
    text: 'Fireballs',
    reason: 'not damage dealers',
    by: 'user',
    at: new Date().toISOString(),
    source: { view: 'brainstorm', label: 'Wizards', groupId: 'o_wiz', entryId: 'en_fire' },
    snapshot: null,
  };
  const g = onBoard(group([entry('en_magic', 'Magic', 'shields'), entry('en_fire', 'Fireballs', 'boom', { ruledOut: true })]), [record]);
  render(GroupBox, { group: g });
  expect(screen.getByText('1 ruled out')).toBeInTheDocument();
  expect(screen.queryByDisplayValue('Fireballs')).toBeNull();
  const folded = screen.getByText('Fireballs');
  expect(folded).toHaveClass('line-through');

  await fireEvent.click(screen.getByRole('button', { name: 'Bring back' }));
  expect(api.op).toHaveBeenCalledWith({ type: 'bringBack', id: 'r_fire' });
});

test('the checkbox toggles open and done; the row menu adds and removes it', async () => {
  const g = onBoard(group([entry('en_a', 'Familiars', '', { check: 'open' }), entry('en_b', 'Towers', '')]));
  render(GroupBox, { group: g });
  await fireEvent.click(screen.getByRole('checkbox', { name: 'Agreed' }));
  expect(api.op).toHaveBeenCalledWith({ type: 'updateEntry', groupId: 'o_wiz', entryId: 'en_a', check: 'done' });

  const [menuA, menuB] = screen.getAllByRole('button', { name: 'Item menu' });
  await fireEvent.click(menuB);
  await fireEvent.click(screen.getByRole('menuitem', { name: 'Add checkbox' }));
  expect(api.op).toHaveBeenCalledWith({ type: 'updateEntry', groupId: 'o_wiz', entryId: 'en_b', check: 'open' });

  await fireEvent.click(menuA);
  await fireEvent.click(screen.getByRole('menuitem', { name: 'Remove checkbox' }));
  expect(api.op).toHaveBeenCalledWith({ type: 'updateEntry', groupId: 'o_wiz', entryId: 'en_a', check: 'none' });
});

test('Rule out… asks Why not? and sends ruleOut for the entry', async () => {
  const g = onBoard(group([entry('en_a', 'Familiars', '')]));
  render(GroupBox, { group: g });
  const prompt = vi.spyOn(window, 'prompt').mockReturnValue('  no pets  ');
  await fireEvent.click(screen.getByRole('button', { name: 'Item menu' }));
  await fireEvent.click(screen.getByRole('menuitem', { name: 'Rule out…' }));
  expect(prompt).toHaveBeenCalledWith('Why not?');
  expect(api.op).toHaveBeenCalledWith({ type: 'ruleOut', target: { kind: 'entry', groupId: 'o_wiz', entryId: 'en_a' }, reason: 'no pets' });
});

test('clicking a row points chat at the entry; deleting it clears the pointer', async () => {
  const g = onBoard(group([entry('en_a', 'x'.repeat(80), '')]));
  render(GroupBox, { group: g });
  const row = screen.getByTestId('entry-en_a');
  await fireEvent.pointerDown(row);
  expect(live.pointing).toEqual({ kind: 'entry', id: 'en_a', groupId: 'o_wiz', label: 'x'.repeat(60) });

  await fireEvent.pointerDown(screen.getByRole('button', { name: 'Item menu' }));
  await fireEvent.click(screen.getByRole('button', { name: 'Item menu' }));
  await fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
  expect(api.op).toHaveBeenCalledWith({ type: 'deleteEntry', groupId: 'o_wiz', entryId: 'en_a' });
  expect(live.pointing).toBeNull();
});

test('editing the title saves after 400 ms; an empty label is not sent', async () => {
  const g = onBoard(group([entry('en_a', 'Familiars', '')]));
  render(GroupBox, { group: g });
  await fireEvent.input(screen.getByDisplayValue('Wizards'), { target: { value: 'Mages' } });
  await vi.advanceTimersByTimeAsync(399);
  expect(api.op).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(api.op).toHaveBeenCalledWith({ type: 'updateObject', id: 'o_wiz', title: 'Mages' });

  vi.mocked(api.op).mockClear();
  const label = screen.getByDisplayValue('Familiars') as HTMLInputElement;
  label.focus();
  await fireEvent.input(label, { target: { value: ' ' } });
  label.blur();
  await vi.advanceTimersByTimeAsync(1000);
  expect(api.op).not.toHaveBeenCalled();
  expect(label.value).toBe('Familiars');
});

test('+ add item adds an entry once it has a label', async () => {
  const g = onBoard(group([]));
  vi.mocked(api.op).mockResolvedValue({ entry: entry('en_new', 'Spells', '') });
  render(GroupBox, { group: g });
  await fireEvent.click(screen.getByRole('button', { name: '+ add item' }));
  const label = screen.getByPlaceholderText('Label');
  await waitFor(() => expect(label).toHaveFocus());
  await fireEvent.input(label, { target: { value: 'Spells' } });
  await fireEvent.keyDown(label, { key: 'Enter' });
  expect(api.op).toHaveBeenCalledWith({ type: 'addEntry', groupId: 'o_wiz', label: 'Spells', text: '' });
});

test('a wiggle on the drag handle, or a drop back on its own row, moves nothing', async () => {
  const g = onBoard(group([entry('en_a', 'Familiars', ''), entry('en_b', 'Magic', ''), entry('en_c', 'Towers', '')]));
  render(GroupBox, { group: g });
  const row = screen.getByTestId('entry-en_a');
  // jsdom has no layout: whatever is "under the pointer" is the row being dragged.
  document.elementFromPoint = () => row;
  const handle = row.querySelector('[title^="Drag to reorder"]') as HTMLElement;

  await fireEvent.pointerDown(handle, { button: 0, clientX: 10, clientY: 10, pointerId: 1 });
  await fireEvent.pointerMove(handle, { clientX: 11, clientY: 10, pointerId: 1 });
  await fireEvent.pointerUp(handle, { clientX: 11, clientY: 10, pointerId: 1 });

  await fireEvent.pointerDown(handle, { button: 0, clientX: 10, clientY: 10, pointerId: 1 });
  await fireEvent.pointerMove(handle, { clientX: 10, clientY: 30, pointerId: 1 });
  await fireEvent.pointerUp(handle, { clientX: 10, clientY: 30, pointerId: 1 });
  expect(api.op).not.toHaveBeenCalled();
});

test('dragging an entry onto another row sends moveEntry', async () => {
  const g = onBoard(group([entry('en_a', 'Familiars', ''), entry('en_b', 'Magic', ''), entry('en_c', 'Towers', '')]));
  render(GroupBox, { group: g });
  const target = screen.getByTestId('entry-en_c');
  document.elementFromPoint = () => target;
  const handle = screen.getByTestId('entry-en_a').querySelector('[title^="Drag to reorder"]') as HTMLElement;
  await fireEvent.pointerDown(handle, { button: 0, clientX: 10, clientY: 10, pointerId: 1 });
  // jsdom rows have no height, so any pointer below the row top counts as "after".
  await fireEvent.pointerMove(handle, { clientX: 10, clientY: 40, pointerId: 1 });
  await fireEvent.pointerUp(handle, { clientX: 10, clientY: 40, pointerId: 1 });
  expect(api.op).toHaveBeenCalledWith({ type: 'moveEntry', entryId: 'en_a', toGroupId: 'o_wiz', index: 2 });
});

test('the ⋯ menu recolours and deletes the group', async () => {
  const g = onBoard(group([entry('en_a', 'Familiars', '')]));
  const ondelete = vi.fn();
  render(GroupBox, { group: g, ondelete });
  await fireEvent.click(screen.getByRole('button', { name: 'Group menu' }));
  const menu = screen.getByRole('menu');
  await fireEvent.click(within(menu).getByRole('menuitem', { name: 'green' }));
  expect(api.op).toHaveBeenCalledWith({ type: 'updateObject', id: 'o_wiz', color: 'green' });

  await fireEvent.click(screen.getByRole('button', { name: 'Group menu' }));
  await fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
  expect(ondelete).toHaveBeenCalled();
});
