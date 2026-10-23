import { beforeEach, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { emptyBoard } from '../test-board';

vi.mock('$lib/api', () => ({
  undo: vi.fn(),
  redo: vi.fn(),
  saveVersion: vi.fn(),
  exportDoc: vi.fn(),
}));

import * as api from '$lib/api';
import { live } from '$lib/live.svelte';
import TopBar from './TopBar.svelte';

beforeEach(() => {
  vi.mocked(api.undo).mockReset().mockResolvedValue({ undone: null, skipped: [] });
  vi.mocked(api.redo).mockReset().mockResolvedValue({ undone: null, skipped: [] });
  vi.mocked(api.saveVersion).mockReset();
  vi.mocked(api.exportDoc).mockReset();
  live.board = emptyBoard();
  live.toasts = [];
});

test('Ctrl+Z undoes, Ctrl+Shift+Z and Ctrl+Y redo', async () => {
  render(TopBar);

  await fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
  expect(api.undo).toHaveBeenCalledTimes(1);

  await fireEvent.keyDown(document.body, { key: 'Z', ctrlKey: true, shiftKey: true });
  await fireEvent.keyDown(document.body, { key: 'y', ctrlKey: true });
  expect(api.redo).toHaveBeenCalledTimes(2);
  expect(api.undo).toHaveBeenCalledTimes(1);
});

test('the shortcuts leave the browser\'s own undo alone while typing', async () => {
  render(TopBar);
  const fields = [document.createElement('input'), document.createElement('textarea'), document.createElement('div')];
  fields[2].setAttribute('contenteditable', 'true');
  for (const field of fields) document.body.append(field);

  for (const field of fields) {
    await fireEvent.keyDown(field, { key: 'z', ctrlKey: true });
    await fireEvent.keyDown(field, { key: 'y', ctrlKey: true });
  }
  expect(api.undo).not.toHaveBeenCalled();
  expect(api.redo).not.toHaveBeenCalled();
  for (const field of fields) field.remove();
});

test('the buttons undo and redo', async () => {
  render(TopBar);

  await fireEvent.click(screen.getByRole('button', { name: '↶ Undo' }));
  await fireEvent.click(screen.getByRole('button', { name: 'Redo' }));
  expect(api.undo).toHaveBeenCalledTimes(1);
  expect(api.redo).toHaveBeenCalledTimes(1);
});

test('Save version offers a dated default name', async () => {
  vi.mocked(api.saveVersion).mockResolvedValue({ id: 'v_1', name: 'x', at: '', author: 'user', auto: false, stats: { groups: 0, entries: 0, notes: 0, pictures: 0, cards: 0 } });
  render(TopBar);

  await fireEvent.click(screen.getByRole('button', { name: '★ Save version' }));
  const input = screen.getByLabelText('Name this version') as HTMLInputElement;
  expect(input.value).toMatch(/^Version \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);

  await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(api.saveVersion).toHaveBeenCalledWith(input.value);
});

test('Export design doc toasts where it was saved', async () => {
  vi.mocked(api.exportDoc).mockResolvedValue('/tmp/board.design.md');
  render(TopBar);

  await fireEvent.click(screen.getByRole('button', { name: 'More' }));
  await fireEvent.click(screen.getByRole('menuitem', { name: 'Export design doc' }));
  await waitFor(() => expect(live.toasts.map((t) => t.text)).toEqual(['Saved /tmp/board.design.md']));
});

test('the save status says Not saved while a field\'s text is unsaved, even after other edits succeed', async () => {
  render(TopBar);
  expect(screen.getByText('All changes saved')).toBeInTheDocument();
  const field = {};
  live.markUnsaved(field, () => Promise.resolve());
  live.saveFailed = false; // a later edit went through
  await waitFor(() => expect(screen.getByText('Not saved')).toBeInTheDocument());
  live.markSaved(field);
  await waitFor(() => expect(screen.getByText('All changes saved')).toBeInTheDocument());
});
