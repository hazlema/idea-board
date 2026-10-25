import { beforeEach, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { emptyBoard } from '../test-board';
import type { Model, RunStatus } from '$lib/types';

vi.mock('$lib/api', () => ({
  op: vi.fn().mockResolvedValue({}),
  colab: vi.fn(),
  colabModels: vi.fn(),
  colabImageModels: vi.fn(),
}));

import * as api from '$lib/api';
import { live } from '$lib/live.svelte';
import { colabState } from '../colab/colab.svelte';
import SettingsDialog from './SettingsDialog.svelte';

const imageModels: Model[] = [
  { id: 'google/imagen-9', name: 'Imagen 9', promptPrice: 1, completionPrice: 2, context: 1000 },
  { id: 'openai/gpt-5.4-image-2', name: 'OpenAI: GPT-5.4 Image 2', promptPrice: 8, completionPrice: 15, context: 1000 },
];
const idle = { state: 'idle', round: 0, rounds: 5, current: null, spent: 0, budget: 5 } as unknown as RunStatus;

beforeEach(() => {
  vi.mocked(api.op).mockClear();
  vi.mocked(api.colab).mockResolvedValue({ status: idle, hasKey: true, library: { rules: '', roles: [] }, connections: [] });
  vi.mocked(api.colabModels).mockResolvedValue([]);
  vi.mocked(api.colabImageModels).mockResolvedValue(imageModels);
  colabState.loaded = false;
  colabState.imageModels = null;
  const board = emptyBoard();
  board.colab.lineup.imageModel = 'openai/gpt-5.4-image-2';
  live.board = board;
  live.colab = idle;
});

test('the image model is the default to start, and choosing another saves it with the rest of the line-up', async () => {
  render(SettingsDialog, { onclose: () => {} });
  await waitFor(() => expect(colabState.imageModels).not.toBeNull());
  expect(screen.getByText(/This is the default\./)).toBeInTheDocument();
  await fireEvent.focus(screen.getByLabelText('Image model'));
  await fireEvent.click(await screen.findByRole('button', { name: /Imagen 9/ }));
  expect(api.op).toHaveBeenCalledWith(
    expect.objectContaining({ type: 'setColabLineup', agents: [], rounds: 5, budget: 5, imageModel: 'google/imagen-9', claudeModel: 'sonnet' }),
  );
});

test('another model offers the way back to the default', async () => {
  live.board!.colab.lineup.imageModel = 'google/imagen-9';
  render(SettingsDialog, { onclose: () => {} });
  await fireEvent.click(screen.getByRole('button', { name: 'Use the default (openai/gpt-5.4-image-2)' }));
  expect(api.op).toHaveBeenCalledWith(expect.objectContaining({ type: 'setColabLineup', imageModel: 'openai/gpt-5.4-image-2' }));
});

test('it is locked while agents run, and Escape closes it', async () => {
  live.colab = { ...idle, state: 'running' } as RunStatus;
  const onclose = vi.fn();
  render(SettingsDialog, { onclose });
  expect(screen.getByLabelText('Image model')).toBeDisabled();
  expect(screen.getByText(/Agents are running/)).toBeInTheDocument();
  await fireEvent.keyDown(screen.getByRole('dialog', { name: 'Settings' }), { key: 'Escape' });
  expect(onclose).toHaveBeenCalled();
});

test('Pruning: the mechanics limit saves, and clearing it means no limit', async () => {
  render(SettingsDialog, { onclose: () => {} });
  const input = screen.getByLabelText('Mechanics limit') as HTMLInputElement;
  expect(input.value).toBe('5');
  await fireEvent.change(input, { target: { value: '3' } });
  expect(api.op).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'setColabLineup', pruneLimit: 3, imageModel: 'openai/gpt-5.4-image-2' }));
  await fireEvent.change(input, { target: { value: '99' } });
  expect(api.op).toHaveBeenLastCalledWith(expect.objectContaining({ pruneLimit: 50 }));
  expect(input.value).toBe('50');
  await fireEvent.change(input, { target: { value: '0' } });
  expect(api.op).toHaveBeenLastCalledWith(expect.objectContaining({ pruneLimit: 1 }));
  await fireEvent.change(input, { target: { value: '' } });
  expect(api.op).toHaveBeenLastCalledWith(expect.objectContaining({ pruneLimit: null }));
  expect(input.value).toBe('');
  expect(input).toHaveAttribute('placeholder', 'No limit');
});

test('Pruning: aggressiveness saves', async () => {
  render(SettingsDialog, { onclose: () => {} });
  const select = screen.getByLabelText('Aggressiveness') as HTMLSelectElement;
  expect(select.value).toBe('normal');
  expect([...select.options].map((o) => [o.value, o.text])).toEqual([
    ['gentle', 'Gentle'],
    ['normal', 'Normal'],
    ['aggressive', 'Aggressive'],
  ]);
  await fireEvent.change(select, { target: { value: 'aggressive' } });
  expect(api.op).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'setColabLineup', pruneAggressiveness: 'aggressive' }));
});

test('Pruning is locked while agents run', () => {
  live.colab = { ...idle, state: 'running' } as RunStatus;
  render(SettingsDialog, { onclose: () => {} });
  expect(screen.getByLabelText('Mechanics limit')).toBeDisabled();
  expect(screen.getByLabelText('Aggressiveness')).toBeDisabled();
});
