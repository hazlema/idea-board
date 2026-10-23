import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { emptyBoard } from '../test-board';
import type { Board, Section } from '$lib/types';

vi.mock('$lib/api', () => ({ op: vi.fn().mockResolvedValue({}) }));

import * as api from '$lib/api';
import { live } from '$lib/live.svelte';
import BriefView from './BriefView.svelte';

const section = (id: string, title: string, text: string, extra: Partial<Section> = {}): Section => ({
  id,
  title,
  text,
  updatedBy: 'user',
  updatedAt: new Date().toISOString(),
  ...extra,
});

function boardWith(...sections: Section[]): Board {
  const board = emptyBoard();
  board.brief.sections = sections;
  return board;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(api.op).mockReset();
  vi.mocked(api.op).mockResolvedValue({});
  live.board = boardWith(section('s_1', 'Goal', 'Original'));
  live.pointing = null;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test('editing a section sends updateSection and an incoming update does not clobber the focused field', async () => {
  render(BriefView);
  const area = screen.getByPlaceholderText('Write anything…') as HTMLTextAreaElement;
  area.focus();
  await fireEvent.input(area, { target: { value: 'My typing' } });

  // Claude edits the same section while the user is still in the field.
  live.board = boardWith(section('s_1', 'Goal', 'Claude wrote this', { updatedBy: 'claude' }));
  await vi.advanceTimersByTimeAsync(0);
  expect(area.value).toBe('My typing');

  await vi.advanceTimersByTimeAsync(600);
  expect(api.op).toHaveBeenCalledWith({ type: 'updateSection', id: 's_1', text: 'My typing' });
  // Still focused: keep showing what the user typed.
  expect(area.value).toBe('My typing');
});

test('other sections and fields still update while one field has focus', async () => {
  live.board = boardWith(section('s_1', 'Goal', 'One'), section('s_2', 'Scope', 'Two'));
  render(BriefView);
  const [titleOne, titleTwo] = screen.getAllByPlaceholderText('Heading') as HTMLInputElement[];
  const [areaOne] = screen.getAllByPlaceholderText('Write anything…') as HTMLTextAreaElement[];
  areaOne.focus();
  await fireEvent.input(areaOne, { target: { value: 'typing' } });

  live.board = boardWith(section('s_1', 'Renamed', 'Server one'), section('s_2', 'Scope 2', 'Two'));
  await vi.advanceTimersByTimeAsync(0);
  expect(areaOne.value).toBe('typing');
  expect(titleOne.value).toBe('Renamed');
  expect(titleTwo.value).toBe('Scope 2');
});

test('after focus leaves, the field shows the latest server value', async () => {
  render(BriefView);
  const area = screen.getByPlaceholderText('Write anything…') as HTMLTextAreaElement;
  area.focus();
  await fireEvent.input(area, { target: { value: 'My typing' } });
  live.board = boardWith(section('s_1', 'Goal', 'Server text'));

  area.blur();
  await vi.advanceTimersByTimeAsync(0);
  // Blur flushes the save straight away, without waiting out the debounce.
  expect(api.op).toHaveBeenCalledWith({ type: 'updateSection', id: 's_1', text: 'My typing' });
  expect(area.value).toBe('Server text');
});

test('the heading saves after 400 ms', async () => {
  render(BriefView);
  const title = screen.getByPlaceholderText('Heading');
  await fireEvent.input(title, { target: { value: 'New goal' } });
  await vi.advanceTimersByTimeAsync(399);
  expect(api.op).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(api.op).toHaveBeenCalledWith({ type: 'updateSection', id: 's_1', title: 'New goal' });
});

test('clicking a box points chat at it, with a fallback label and a 60 character limit', async () => {
  live.board = boardWith(section('s_1', 'x'.repeat(100), ''), section('s_2', '', ''));
  render(BriefView);
  const boxes = screen.getAllByRole('group');
  await fireEvent.click(boxes[1]);
  expect(live.pointing).toEqual({ kind: 'section', id: 's_2', label: 'Untitled section' });
  await fireEvent.click(boxes[0]);
  expect(live.pointing?.label).toBe('x'.repeat(60));
});

test('move buttons send moveSection and the ends are disabled', async () => {
  live.board = boardWith(section('s_1', 'A', ''), section('s_2', 'B', ''));
  render(BriefView);
  const up = screen.getAllByRole('button', { name: 'Move up' });
  const down = screen.getAllByRole('button', { name: 'Move down' });
  expect(up[0]).toBeDisabled();
  expect(down[1]).toBeDisabled();
  await fireEvent.click(down[0]);
  expect(api.op).toHaveBeenCalledWith({ type: 'moveSection', id: 's_1', by: 1 });
  await fireEvent.click(up[1]);
  expect(api.op).toHaveBeenCalledWith({ type: 'moveSection', id: 's_2', by: -1 });
});

test('removing a non-empty box asks first; an empty one does not', async () => {
  live.board = boardWith(section('s_1', 'Goal', 'Text'), section('s_2', '', ''));
  const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
  render(BriefView);
  const [removeFull, removeEmpty] = screen.getAllByRole('button', { name: 'Remove this box' });

  await fireEvent.click(removeFull);
  expect(confirmSpy).toHaveBeenCalledWith('Remove "Goal"?');
  expect(api.op).not.toHaveBeenCalled();

  confirmSpy.mockReturnValue(true);
  await fireEvent.click(removeFull);
  expect(api.op).toHaveBeenCalledWith({ type: 'deleteSection', id: 's_1' });

  confirmSpy.mockClear();
  await fireEvent.click(removeEmpty);
  expect(confirmSpy).not.toHaveBeenCalled();
  expect(api.op).toHaveBeenCalledWith({ type: 'deleteSection', id: 's_2' });
});

test('removing the section chat is pointed at clears the pointer', async () => {
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  render(BriefView);
  await fireEvent.click(screen.getByRole('group'));
  expect(live.pointing?.id).toBe('s_1');
  await fireEvent.click(screen.getByRole('button', { name: 'Remove this box' }));
  expect(api.op).toHaveBeenCalledWith({ type: 'deleteSection', id: 's_1' });
  expect(live.pointing).toBeNull();
});

test('+ Add text box adds a section and focuses its heading', async () => {
  vi.mocked(api.op).mockResolvedValue({ section: section('s_new', '', '') });
  render(BriefView);
  await fireEvent.click(screen.getByRole('button', { name: '+ Add text box' }));
  expect(api.op).toHaveBeenCalledWith({ type: 'addSection', title: '', text: '' });

  live.board = boardWith(section('s_1', 'Goal', 'Original'), section('s_new', '', ''));
  await vi.advanceTimersByTimeAsync(0);
  await waitFor(() => expect(screen.getAllByPlaceholderText('Heading')[1]).toHaveFocus());
});

test('shows who made the last edit', () => {
  live.board = boardWith(section('s_1', 'Goal', '', { updatedBy: 'claude' }));
  render(BriefView);
  expect(screen.getByText('Last edit: Claude · just now')).toBeInTheDocument();
});
