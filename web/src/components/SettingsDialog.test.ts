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
