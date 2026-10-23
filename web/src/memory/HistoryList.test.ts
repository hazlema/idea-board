import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import type { HistoryRow, VersionMeta } from '$lib/types';

vi.mock('$lib/api', () => ({
  history: vi.fn(),
  versions: vi.fn(),
  undoTurn: vi.fn(),
  restoreVersion: vi.fn(),
  readVersion: vi.fn(),
}));

import * as api from '$lib/api';
import { live } from '$lib/live.svelte';
import HistoryList from './HistoryList.svelte';

const row = (seq: number, author: 'user' | 'claude', summary: string, extra: Partial<HistoryRow> = {}): HistoryRow => ({
  seq,
  at: new Date(Date.now() - (10 - seq) * 60_000).toISOString(),
  author,
  turn: author === 'claude' ? 't_1' : `u_${seq}`,
  op: 'addObject',
  summary,
  undone: false,
  ...extra,
});

const version = (extra: Partial<VersionMeta> = {}): VersionMeta => ({
  id: 'v_1',
  name: 'Before the rewrite',
  at: new Date(Date.now() - 5 * 60_000 - 30_000).toISOString(),
  author: 'user',
  auto: false,
  stats: { groups: 3, entries: 12, notes: 1, pictures: 2, cards: 4 },
  ...extra,
});

beforeEach(() => {
  vi.mocked(api.history).mockReset();
  vi.mocked(api.versions).mockReset();
  vi.mocked(api.undoTurn).mockReset();
  vi.mocked(api.versions).mockResolvedValue([]);
  vi.mocked(api.undoTurn).mockResolvedValue({ undone: 3, skipped: [] });
  live.toasts = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

test('a Claude reply groups into one row with Undo this reply', async () => {
  vi.mocked(api.history).mockResolvedValue([
    row(4, 'claude', 'added group Wizards'),
    row(3, 'claude', 'added note Idea'),
    row(2, 'claude', 'added topic Magic'),
    row(1, 'user', 'moved Towers'),
  ]);
  render(HistoryList);

  expect(await screen.findByText('moved Towers')).toBeInTheDocument();
  expect(screen.getAllByRole('button', { name: 'Undo this reply' })).toHaveLength(1);
  expect(screen.getByText('added group Wizards')).toBeInTheDocument();
  expect(screen.getByText('added topic Magic')).toBeInTheDocument();

  await fireEvent.click(screen.getByRole('button', { name: 'Undo this reply' }));
  expect(api.undoTurn).toHaveBeenCalledWith('t_1');
  await waitFor(() => expect(live.toasts.map((t) => t.text)).toEqual(['Undone. ↷ brings it back.']));
});

test('a skipped item is reported when a reply is undone', async () => {
  vi.mocked(api.history).mockResolvedValue([row(2, 'claude', 'added group A'), row(1, 'claude', 'added group B')]);
  vi.mocked(api.undoTurn).mockResolvedValue({ undone: 1, skipped: [{ seq: 1, summary: 'added group B' }] });
  render(HistoryList);

  await fireEvent.click(await screen.findByRole('button', { name: 'Undo this reply' }));
  await waitFor(() => expect(live.toasts.map((t) => t.text)).toEqual(['Kept 1 item you changed since.']));
});

test('undone entries are greyed and a reply with nothing left to undo has no button', async () => {
  vi.mocked(api.history).mockResolvedValue([row(2, 'claude', 'added group A', { undone: true }), row(1, 'user', 'renamed X', { undone: true })]);
  render(HistoryList);

  await screen.findByText('renamed X');
  expect(screen.getAllByText('(undone)')).toHaveLength(2);
  expect(screen.queryByRole('button', { name: 'Undo this reply' })).toBeNull();
});

test('versions are interleaved by time with Preview and Restore', async () => {
  vi.mocked(api.history).mockResolvedValue([row(2, 'user', 'newer change'), row(1, 'user', 'older change')]);
  vi.mocked(api.versions).mockResolvedValue([version({ at: new Date(Date.now() - 8.5 * 60_000).toISOString() })]);
  render(HistoryList);

  const mark = await screen.findByText('★ Version: “Before the rewrite”');
  expect(screen.getByText(/3 groups, 12 entries, 2 pictures/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Preview' })).toBeInTheDocument();
  const [newer, older] = [screen.getByText('newer change'), screen.getByText('older change')];
  expect(newer.compareDocumentPosition(mark) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(mark.compareDocumentPosition(older) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

test('Restore asks first and restores the version', async () => {
  vi.mocked(api.history).mockResolvedValue([]);
  vi.mocked(api.versions).mockResolvedValue([version()]);
  vi.mocked(api.restoreVersion).mockResolvedValue({ restored: version(), backup: version({ id: 'v_2' }) });
  const confirmed = vi.spyOn(window, 'confirm');

  render(HistoryList);
  const button = await screen.findByRole('button', { name: 'Restore' });

  confirmed.mockReturnValueOnce(false);
  await fireEvent.click(button);
  expect(api.restoreVersion).not.toHaveBeenCalled();

  confirmed.mockReturnValueOnce(true);
  await fireEvent.click(button);
  expect(api.restoreVersion).toHaveBeenCalledWith('v_1');
});

test('Load more asks for entries before the oldest one shown', async () => {
  const page = Array.from({ length: 50 }, (_, i) => row(100 - i, 'user', `change ${100 - i}`));
  vi.mocked(api.history).mockResolvedValueOnce(page).mockResolvedValueOnce([row(50, 'user', 'change 50')]);
  render(HistoryList);

  await fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));
  expect(api.history).toHaveBeenLastCalledWith(50, 51);
  expect(await screen.findByText('change 50')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
});

test('the list reloads when the server records history', async () => {
  vi.mocked(api.history).mockResolvedValue([row(1, 'user', 'first')]);
  render(HistoryList);
  await screen.findByText('first');

  vi.mocked(api.history).mockResolvedValue([row(2, 'user', 'second'), row(1, 'user', 'first')]);
  live.historyTick += 1;
  expect(await screen.findByText('second')).toBeInTheDocument();
});

test('an edit reloads the history but not the saved versions; a new version reloads them', async () => {
  vi.mocked(api.history).mockResolvedValue([row(1, 'user', 'first')]);
  render(HistoryList);
  await screen.findByText('first');
  await waitFor(() => expect(api.versions).toHaveBeenCalledTimes(1));

  vi.mocked(api.history).mockResolvedValue([row(2, 'user', 'second'), row(1, 'user', 'first')]);
  live.historyTick += 1;
  expect(await screen.findByText('second')).toBeInTheDocument();
  expect(api.versions).toHaveBeenCalledTimes(1);
  const historyCalls = vi.mocked(api.history).mock.calls.length;

  live.versionsTick += 1;
  await waitFor(() => expect(api.versions).toHaveBeenCalledTimes(2));
  expect(api.history).toHaveBeenCalledTimes(historyCalls);
});
