import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { emptyBoard } from '../test-board';
import type { BLink, BObject, Board, Group, Note, Picture, Topic } from '$lib/types';

vi.mock('$lib/api', () => ({ op: vi.fn(), uploadPicture: vi.fn(), ingestUrl: vi.fn() }));
vi.mock('$lib/pictures', async (original) => ({
  ...(await original<typeof import('$lib/pictures')>()),
  makePreview: vi.fn().mockResolvedValue(new Blob(['jpeg'], { type: 'image/jpeg' })),
}));

import * as api from '$lib/api';
import { live } from '$lib/live.svelte';
import BrainstormView from './BrainstormView.svelte';

const ASSET = `${'a'.repeat(32)}.png`;
const PREVIEW = `${'b'.repeat(32)}.jpg`;

const base = (id: string) => ({
  id,
  x: 100,
  y: 50,
  w: 320,
  h: 0,
  author: 'user' as const,
  claudeAdded: false,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  updatedBy: 'user' as const,
});
const group = (id: string, title: string, extra: Partial<Group> = {}): Group => ({ ...base(id), kind: 'group', title, color: 'slate', entries: [], ...extra });
const note = (id: string, text: string, extra: Partial<Note> = {}): Note => ({ ...base(id), kind: 'note', text, color: 'slate', w: 220, h: 140, ...extra });
const topic = (id: string, text: string): Topic => ({ ...base(id), kind: 'topic', text, w: 0, h: 0 });
const picture = (id: string, extra: Partial<Picture> = {}): Picture => ({ ...base(id), kind: 'picture', asset: ASSET, preview: PREVIEW, caption: '', w: 240, ...extra });

function boardWith(objects: BObject[], links: BLink[] = []): Board {
  const board = emptyBoard();
  board.brainstorm.pages[0].objects = objects;
  board.brainstorm.pages[0].links = links;
  return board;
}

const box = (container: HTMLElement, id: string) => container.querySelector(`[data-object-id="${id}"]`) as HTMLElement;
const canvasOf = () => screen.getByRole('application', { name: 'Brainstorm canvas' });

function pasteEvent(data: { file?: File; text?: string }): Event {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  const files = data.file ? [data.file] : [];
  Object.defineProperty(event, 'clipboardData', {
    value: {
      files,
      items: files.map((f) => ({ kind: 'file', type: f.type, getAsFile: () => f })),
      getData: (type: string) => (type === 'text/plain' ? (data.text ?? '') : ''),
    },
  });
  return event;
}

beforeEach(() => {
  localStorage.clear();
  vi.mocked(api.op).mockReset();
  vi.mocked(api.op).mockResolvedValue({});
  vi.mocked(api.uploadPicture).mockReset();
  vi.mocked(api.ingestUrl).mockReset();
  live.board = boardWith([group('o_wiz', 'Wizards\nand more'), note('o_note', 'Scene idea: a flooded library')]);
  live.pointing = null;
  live.toasts = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

test('▤ Group adds "New group" at the middle of the view and focuses its title', async () => {
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  vi.mocked(api.op).mockResolvedValue({ object: group('o_new', 'New group') });
  render(BrainstormView);
  await fireEvent.click(screen.getByRole('button', { name: '▤ Group' }));
  // jsdom's canvas is 0×0, so the middle of the default view is world (-80, -80).
  expect(api.op).toHaveBeenCalledWith({ type: 'addObject', kind: 'group', title: 'New group', x: -240, y: -140 });

  live.board = boardWith([group('o_wiz', 'Wizards'), group('o_new', 'New group', { x: -240, y: -140 })]);
  await waitFor(() => expect(screen.getByDisplayValue('New group')).toHaveFocus());
});

test('a new object or picture moves the Talking about chip to itself when it arrives', async () => {
  const { container } = render(BrainstormView);
  await fireEvent.pointerDown(box(container, 'o_wiz'), { button: 0 });
  expect(live.pointing?.id).toBe('o_wiz');

  const added: BObject[] = [];
  const arrive = async (o: BObject) => {
    added.push(o);
    live.board = boardWith([group('o_wiz', 'Wizards'), ...added]);
    await waitFor(() => expect(live.pointing?.id).toBe(o.id));
  };

  vi.mocked(api.op).mockResolvedValueOnce({ object: note('o_n', '') });
  await fireEvent.click(screen.getByRole('button', { name: '✎ Note' }));
  // Until the board shows it, the chip stays where it was.
  expect(live.pointing?.id).toBe('o_wiz');
  await arrive(note('o_n', '', { x: 900 }));
  expect(live.pointing).toEqual({ kind: 'object', id: 'o_n', label: 'Note' });

  vi.mocked(api.op).mockResolvedValueOnce({ object: topic('o_t', 'New topic') });
  await fireEvent.click(screen.getByRole('button', { name: '● Topic' }));
  await arrive({ ...topic('o_t', 'New topic'), x: 1400 });
  expect(live.pointing?.label).toBe('New topic');

  vi.mocked(api.uploadPicture).mockResolvedValue(ASSET);
  vi.mocked(api.op).mockImplementation(async (o) => (o.type === 'addObject' ? { object: picture('o_p') } : {}));
  window.dispatchEvent(pasteEvent({ file: new File(['png'], 'sketch.png', { type: 'image/png' }) }));
  await waitFor(() => expect(api.op).toHaveBeenCalledWith(expect.objectContaining({ type: 'addObject', kind: 'picture' })));
  await arrive(picture('o_p', { x: 2000 }));
});

test('clicking an object points chat at its first line; empty canvas clears it', async () => {
  live.board = boardWith([group('o_wiz', `${'W'.repeat(70)}\nsecond line`)]);
  const { container } = render(BrainstormView);
  await fireEvent.pointerDown(box(container, 'o_wiz'), { button: 0 });
  expect(live.pointing).toEqual({ kind: 'object', id: 'o_wiz', label: 'W'.repeat(60) });

  await fireEvent.pointerDown(canvasOf(), { button: 0 });
  await fireEvent.pointerUp(canvasOf(), { button: 0 });
  expect(live.pointing).toBeNull();
});

test('Delete removes the selected object after asking, and clears the pointer', async () => {
  const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
  const { container } = render(BrainstormView);
  await fireEvent.pointerDown(box(container, 'o_note'), { button: 0 });
  expect(live.pointing?.id).toBe('o_note');

  await fireEvent.keyDown(window, { key: 'Delete' });
  expect(confirmSpy).toHaveBeenCalledWith('Delete "Scene idea: a flooded library"?');
  expect(api.op).toHaveBeenCalledWith({ type: 'deleteObject', id: 'o_note' });
  expect(live.pointing).toBeNull();
});

test('an empty object is deleted without asking; typing in a field never deletes', async () => {
  live.board = boardWith([note('o_empty', '')]);
  const confirmSpy = vi.spyOn(window, 'confirm');
  const { container } = render(BrainstormView);
  await fireEvent.pointerDown(box(container, 'o_empty'), { button: 0 });

  const field = screen.getByLabelText('Note');
  await fireEvent.keyDown(field, { key: 'Backspace' });
  expect(api.op).not.toHaveBeenCalled();

  await fireEvent.keyDown(window, { key: 'Backspace' });
  expect(confirmSpy).not.toHaveBeenCalled();
  expect(api.op).toHaveBeenCalledWith({ type: 'deleteObject', id: 'o_empty' });
});

test('Escape deselects', async () => {
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  const { container } = render(BrainstormView);
  await fireEvent.pointerDown(box(container, 'o_note'), { button: 0 });
  expect(box(container, 'o_note')).toHaveClass('outline-accent');
  await fireEvent.keyDown(window, { key: 'Escape' });
  expect(box(container, 'o_note')).not.toHaveClass('outline-accent');
  await fireEvent.keyDown(window, { key: 'Delete' });
  expect(api.op).not.toHaveBeenCalled();
});

test('when Claude deletes the object chat points at, the pointer goes', async () => {
  const { container } = render(BrainstormView);
  await fireEvent.pointerDown(box(container, 'o_note'), { button: 0 });
  live.board = boardWith([group('o_wiz', 'Wizards')]);
  await waitFor(() => expect(live.pointing).toBeNull());
});

test('dragging a title bar sends moveObject on release, scaled by the zoom', async () => {
  localStorage.setItem('idea-board-view-brainstorm', JSON.stringify({ x: 0, y: 0, k: 2 }));
  const { container } = render(BrainstormView);
  const header = box(container, 'o_wiz').querySelector('header') as HTMLElement;
  await fireEvent.pointerDown(header, { button: 0, clientX: 10, clientY: 10, pointerId: 1 });
  await fireEvent.pointerMove(header, { clientX: 50, clientY: 30, pointerId: 1 });
  expect(box(container, 'o_wiz').style.left).toBe('120px');
  expect(api.op).not.toHaveBeenCalled();
  await fireEvent.pointerUp(header, { clientX: 50, clientY: 30, pointerId: 1 });
  expect(api.op).toHaveBeenCalledWith({ type: 'moveObject', id: 'o_wiz', x: 120, y: 60 });
});

test('the resize grip sends moveObject with w and h, never below the minimum', async () => {
  const { container } = render(BrainstormView);
  const grip = box(container, 'o_note').querySelector('[data-no-drag]') as HTMLElement;
  await fireEvent.pointerDown(grip, { button: 0, clientX: 0, clientY: 0, pointerId: 1 });
  await fireEvent.pointerMove(grip, { clientX: 30, clientY: 200, pointerId: 1 });
  await fireEvent.pointerUp(grip, { clientX: 30, clientY: 200, pointerId: 1 });
  // jsdom lays nothing out, so the box starts at 0×0: the width is held at the note minimum.
  expect(api.op).toHaveBeenCalledWith({ type: 'moveObject', id: 'o_note', w: 160, h: 200 });
});

test('a width-only resize keeps an auto-height box auto; dragging taller sets a height', async () => {
  // Pretend every box lays out 150 px tall (its content) and starts 300 px wide.
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(150);
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(300);
  const { container } = render(BrainstormView);
  const grip = box(container, 'o_wiz').querySelector('[data-no-drag]') as HTMLElement;
  await fireEvent.pointerDown(grip, { button: 0, clientX: 0, clientY: 0, pointerId: 1 });
  await fireEvent.pointerMove(grip, { clientX: 60, clientY: 0, pointerId: 1 });
  await fireEvent.pointerUp(grip, { clientX: 60, clientY: 0, pointerId: 1 });
  expect(api.op).toHaveBeenLastCalledWith({ type: 'moveObject', id: 'o_wiz', w: 360, h: 0 });

  await fireEvent.pointerDown(grip, { button: 0, clientX: 0, clientY: 0, pointerId: 1 });
  await fireEvent.pointerMove(grip, { clientX: 0, clientY: 50, pointerId: 1 });
  await fireEvent.pointerUp(grip, { clientX: 0, clientY: 50, pointerId: 1 });
  expect(api.op).toHaveBeenLastCalledWith({ type: 'moveObject', id: 'o_wiz', w: 300, h: 200 });
});

test('a pasted image is uploaded, added, and given a preview', async () => {
  vi.mocked(api.uploadPicture).mockResolvedValueOnce(ASSET).mockResolvedValueOnce(PREVIEW);
  vi.mocked(api.op).mockImplementation(async (o) => (o.type === 'addObject' ? { object: picture('o_pic', { preview: null }) } : {}));
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  render(BrainstormView);
  const png = new File(['png'], 'sketch.png', { type: 'image/png' });
  window.dispatchEvent(pasteEvent({ file: png }));

  await waitFor(() => expect(api.op).toHaveBeenCalledWith({ type: 'setPicturePreview', id: 'o_pic', preview: PREVIEW }));
  expect(api.uploadPicture).toHaveBeenNthCalledWith(1, png);
  expect(api.op).toHaveBeenCalledWith({ type: 'addObject', kind: 'picture', asset: ASSET, x: -200, y: -190 });
});

test('a pasted image URL is fetched by the server; its error shows in a toast', async () => {
  vi.mocked(api.ingestUrl).mockRejectedValue(new Error('That address is not a picture'));
  render(BrainstormView);
  window.dispatchEvent(pasteEvent({ text: 'https://example.com/page' }));
  await waitFor(() => expect(live.toasts.map((t) => t.text)).toContain('That address is not a picture'));
  expect(api.ingestUrl).toHaveBeenCalledWith('https://example.com/page');
  expect(api.op).not.toHaveBeenCalled();
});

test('pasting into a text field is left alone', async () => {
  render(BrainstormView);
  const field = screen.getByLabelText('Note');
  field.dispatchEvent(pasteEvent({ text: 'https://example.com/a.png' }));
  await Promise.resolve();
  expect(api.ingestUrl).not.toHaveBeenCalled();
});

test('a picture without a preview gets one the first time it shows', async () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new Blob(['png'], { type: 'image/png' })));
  vi.mocked(api.uploadPicture).mockResolvedValue(PREVIEW);
  live.board = boardWith([picture('o_old', { preview: null })]);
  render(BrainstormView);
  await waitFor(() => expect(api.op).toHaveBeenCalledWith({ type: 'setPicturePreview', id: 'o_old', preview: PREVIEW }));
  expect(fetchSpy).toHaveBeenCalledWith(`/assets/${ASSET}`);
});

test('Keep and Dismiss… on an object Claude added', async () => {
  live.board = boardWith([topic('o_top', 'Factions'), { ...note('o_cl', 'Claude idea'), author: 'claude', claudeAdded: true }]);
  vi.spyOn(window, 'prompt').mockReturnValue('');
  render(BrainstormView);
  await fireEvent.click(screen.getByRole('button', { name: 'Keep' }));
  expect(api.op).toHaveBeenCalledWith({ type: 'keep', id: 'o_cl' });
  await fireEvent.click(screen.getByRole('button', { name: 'Dismiss…' }));
  expect(api.op).toHaveBeenCalledWith({ type: 'ruleOut', target: { kind: 'object', id: 'o_cl' }, reason: '' });
});

test('↗ Link joins the next two objects clicked', async () => {
  vi.mocked(api.op).mockResolvedValue({ link: { id: 'l_1' } });
  const { container } = render(BrainstormView);
  await fireEvent.click(screen.getByRole('button', { name: '↗ Link' }));
  expect(screen.getByText(/Click the first object/)).toBeInTheDocument();
  await fireEvent.pointerDown(box(container, 'o_wiz'), { button: 0 });
  await fireEvent.pointerDown(box(container, 'o_note'), { button: 0 });
  expect(api.op).toHaveBeenCalledWith({ type: 'addLink', from: 'o_wiz', to: 'o_note' });
});

test('a selected link can be relabelled, made dashed and deleted', async () => {
  vi.useFakeTimers();
  live.board = boardWith([group('o_wiz', 'Wizards'), note('o_note', 'Scene', { x: 600 })], [{ id: 'l_1', from: 'o_wiz', to: 'o_note', label: '', dashed: false, author: 'user' }]);
  render(BrainstormView);
  await fireEvent.pointerDown(screen.getByRole('button', { name: 'Link' }));
  const label = screen.getByLabelText('Link label');
  label.focus();
  await fireEvent.input(label, { target: { value: 'scene' } });
  await vi.advanceTimersByTimeAsync(400);
  expect(api.op).toHaveBeenCalledWith({ type: 'updateLink', id: 'l_1', label: 'scene' });

  await fireEvent.click(screen.getByRole('checkbox', { name: 'Dashed' }));
  expect(api.op).toHaveBeenCalledWith({ type: 'updateLink', id: 'l_1', dashed: true });
  await fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
  expect(api.op).toHaveBeenCalledWith({ type: 'deleteLink', id: 'l_1' });
  vi.useRealTimers();
});

test('a link label typed just before choosing something else is still saved to that link', async () => {
  vi.useFakeTimers();
  live.board = boardWith(
    [group('o_wiz', 'Wizards'), note('o_note', 'Scene', { x: 600 })],
    [
      { id: 'l_1', from: 'o_wiz', to: 'o_note', label: '', dashed: false, author: 'user' },
      { id: 'l_2', from: 'o_note', to: 'o_wiz', label: 'other', dashed: false, author: 'user' },
    ],
  );
  const { container } = render(BrainstormView);
  await fireEvent.pointerDown(screen.getByRole('button', { name: 'Link' }));
  const label = screen.getByLabelText('Link label');
  label.focus();
  await fireEvent.input(label, { target: { value: 'scene' } });
  // Within the 400 ms pause, the user picks the other link, then a box.
  await fireEvent.pointerDown(screen.getByRole('button', { name: 'Link: other' }));
  await vi.advanceTimersByTimeAsync(0);
  expect(api.op).toHaveBeenCalledWith({ type: 'updateLink', id: 'l_1', label: 'scene' });
  expect((screen.getByLabelText('Link label') as HTMLInputElement).value).toBe('other');
  await fireEvent.pointerDown(box(container, 'o_note'), { button: 0 });
  await vi.advanceTimersByTimeAsync(1000);
  expect(api.op).toHaveBeenCalledTimes(1);
  vi.useRealTimers();
});

test('an empty board says how to start', () => {
  live.board = boardWith([]);
  render(BrainstormView);
  expect(screen.getByText('Empty canvas')).toBeInTheDocument();
});

test('a board passed in is shown read-only: no palette, no pointing, no ops', async () => {
  const { container } = render(BrainstormView, { board: boardWith([group('o_old', 'Old group')]) });

  expect(screen.getByDisplayValue('Old group')).toBeInTheDocument();
  expect(screen.queryByDisplayValue('Wizards\nand more')).toBeNull();
  expect(screen.queryByRole('button', { name: '▤ Group' })).toBeNull();

  await fireEvent.pointerDown(box(container, 'o_old'), { button: 0 });
  await fireEvent.keyDown(window, { key: 'Delete' });
  expect(live.pointing).toBeNull();
  expect(api.op).not.toHaveBeenCalled();
});
