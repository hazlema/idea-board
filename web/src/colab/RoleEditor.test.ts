import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';
import { emptyBoard } from '../test-board';
import type { RunStatus } from '$lib/types';

vi.mock('$lib/api', () => ({
  op: vi.fn().mockResolvedValue({}),
  colab: vi.fn(),
  colabModels: vi.fn().mockResolvedValue([]),
  saveLibrary: vi.fn(),
  stopColab: vi.fn(),
}));

import * as api from '$lib/api';
import { live } from '$lib/live.svelte';
import { colabState } from './colab.svelte';
import ConnectionsPanel from './ConnectionsPanel.svelte';
import RoleEditor from './RoleEditor.svelte';

const idle: RunStatus = { state: 'idle', round: 0, rounds: 5, current: null, spent: 0, budget: 5, claude: 'binary', connections: {} };
const library = () => ({
  rules: 'Be kind.',
  roles: [
    { id: 'creative', name: 'Creative', job: 'Dream.' },
    { id: 'foreman', name: 'Foreman', job: 'Build.' },
  ],
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  const board = emptyBoard();
  board.colab.extras = { rules: 'Board rules', roles: { creative: 'Be bold', foreman: 'Old extra' } };
  live.board = board;
  live.colab = idle;
  colabState.library = library();
  colabState.loaded = true;
  colabState.hasKey = true;
  vi.mocked(api.saveLibrary).mockImplementation(async (l) => l);
});

afterEach(() => vi.useRealTimers());

const open = async (name: string) => fireEvent.click(screen.getByRole('button', { name }));

test("editing the Foreman's job saves the library after the pause", async () => {
  render(RoleEditor, { onclose: () => {} });
  await open('Foreman');
  await fireEvent.input(screen.getByLabelText('Job, every board'), { target: { value: 'Build well.' } });
  expect(api.saveLibrary).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(600);
  expect(api.saveLibrary).toHaveBeenCalledWith({
    rules: 'Be kind.',
    roles: [
      { id: 'creative', name: 'Creative', job: 'Dream.' },
      { id: 'foreman', name: 'Foreman', job: 'Build well.' },
    ],
  });
  expect(colabState.library.roles[1].job).toBe('Build well.');
});

test('editing the extra for a role sends all the extras with that role changed', async () => {
  render(RoleEditor, { onclose: () => {} });
  await open('Foreman');
  await fireEvent.input(screen.getByLabelText('Extra for this board'), { target: { value: 'New extra' } });
  await vi.advanceTimersByTimeAsync(600);
  expect(api.op).toHaveBeenCalledWith({ type: 'setColabExtras', rules: 'Board rules', roles: { creative: 'Be bold', foreman: 'New extra' } });
});

test('editing the shared rules extra sends rules and keeps the role extras', async () => {
  render(RoleEditor, { onclose: () => {} });
  await open('Shared rules');
  await fireEvent.input(screen.getByLabelText('Extra for this board'), { target: { value: 'Rules now' } });
  await vi.advanceTimersByTimeAsync(600);
  expect(api.op).toHaveBeenCalledWith({ type: 'setColabExtras', rules: 'Rules now', roles: { creative: 'Be bold', foreman: 'Old extra' } });
});

test('+ New role adds a role and selects it', async () => {
  render(RoleEditor, { onclose: () => {} });
  await open('+ New role');
  await vi.advanceTimersByTimeAsync(0);
  expect(api.saveLibrary).toHaveBeenCalledWith(expect.objectContaining({ roles: expect.arrayContaining([{ id: 'new-role', name: 'New role', job: '' }]) }));
  expect(screen.getByRole('button', { name: 'New role' })).toHaveAttribute('aria-current', 'true');
  expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('New role');
});

test('Escape and the close button close the editor', async () => {
  const onclose = vi.fn();
  render(RoleEditor, { onclose });
  await fireEvent.keyDown(window, { key: 'Escape' });
  await fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  expect(onclose).toHaveBeenCalledTimes(2);
});

test('the last role cannot be deleted', async () => {
  colabState.library = { rules: '', roles: [{ id: 'creative', name: 'Creative', job: '' }] };
  render(RoleEditor, { onclose: () => {} });
  await open('Creative');
  expect(screen.getByRole('button', { name: 'Delete role' })).toBeDisabled();
});

test('deleting a role a card uses makes the card show Role missing', async () => {
  const board = live.board!;
  board.colab.lineup.agents = [{ model: 'm/x', roleId: 'foreman', settings: {} }];
  vi.mocked(api.colab).mockResolvedValue({ status: idle, hasKey: true, connections: [], library: library() });
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  render(ConnectionsPanel);
  await vi.advanceTimersByTimeAsync(0);
  expect(screen.queryByText('Role missing')).not.toBeInTheDocument();

  await fireEvent.click(screen.getByRole('button', { name: 'Edit roles…' }));
  await open('Foreman');
  await fireEvent.click(screen.getByRole('button', { name: 'Delete role' }));
  await vi.advanceTimersByTimeAsync(0);
  expect(api.saveLibrary).toHaveBeenCalledWith({ rules: 'Be kind.', roles: [{ id: 'creative', name: 'Creative', job: 'Dream.' }] });
  expect(screen.getByText('Role missing')).toBeInTheDocument();
});
