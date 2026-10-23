import { beforeEach, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { emptyBoard } from '../test-board';
import type { Model, RunStatus } from '$lib/types';

vi.mock('$lib/api', () => ({
  op: vi.fn().mockResolvedValue({}),
  colab: vi.fn(),
  colabModels: vi.fn(),
  startColab: vi.fn(),
  stopColab: vi.fn(),
}));

import * as api from '$lib/api';
import { live } from '$lib/live.svelte';
import { colabState } from './colab.svelte';
import AgentsPanel from './AgentsPanel.svelte';

const library = {
  rules: '',
  roles: [
    { id: 'creative', name: 'Creative', job: '' },
    { id: 'qa', name: 'QA', job: '' },
  ],
};
const models: Model[] = [
  { id: 'google/gemini-4-argon', name: 'Gemini 4 Argon', promptPrice: 1, completionPrice: 4, context: 1000 },
  { id: 'openai/gpt-6.1-sol', name: 'GPT 6.1 Sol', promptPrice: 2, completionPrice: 8, context: 1000 },
];
const idle: RunStatus = { state: 'idle', round: 0, rounds: 5, current: null, spent: 0, budget: 5 };

beforeEach(() => {
  vi.clearAllMocks();
  live.board = emptyBoard();
  live.colab = idle;
  colabState.models = null;
  colabState.modelsError = null;
  colabState.loaded = false;
  vi.mocked(api.colab).mockResolvedValue({ status: idle, hasKey: true, library });
  vi.mocked(api.colabModels).mockResolvedValue(models);
});

const lastLineup = () => vi.mocked(api.op).mock.calls.at(-1)?.[0];

test('adding two agents and choosing models and roles sends the line-up in order', async () => {
  render(AgentsPanel);
  await waitFor(() => expect(colabState.models).not.toBeNull());
  await fireEvent.click(screen.getByRole('button', { name: '+ Add agent' }));
  await fireEvent.click(screen.getByRole('button', { name: '+ Add agent' }));

  const pickers = screen.getAllByLabelText('Model');
  await fireEvent.focus(pickers[0]);
  await fireEvent.click(await screen.findByRole('button', { name: /Gemini 4 Argon/ }));
  await fireEvent.focus(screen.getAllByLabelText('Model')[1]);
  await fireEvent.input(screen.getAllByLabelText('Model')[1], { target: { value: 'sol' } });
  await fireEvent.click(await screen.findByRole('button', { name: /GPT 6.1 Sol/ }));
  await fireEvent.change(screen.getAllByLabelText('Role')[1], { target: { value: 'qa' } });

  expect(lastLineup()).toEqual({
    type: 'setColabLineup',
    agents: [
      { model: 'google/gemini-4-argon', roleId: 'creative', settings: {} },
      { model: 'openai/gpt-6.1-sol', roleId: 'qa', settings: {} },
    ],
    rounds: 5,
    budget: 5,
  });
});

test('Start is disabled with no key, naming the key file, and with a card without a model', async () => {
  vi.mocked(api.colab).mockResolvedValue({ status: idle, hasKey: false, library });
  render(AgentsPanel);
  expect(await screen.findByText('~/.config/openrouter/key')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Start' })).toBeDisabled();

  colabState.hasKey = true;
  await fireEvent.click(screen.getByRole('button', { name: '+ Add agent' }));
  expect(screen.getByRole('button', { name: 'Start' })).toBeDisabled();
  expect(await screen.findByText('Agent 1 has no model.')).toBeInTheDocument();
});

test('while running the inputs are locked, the current card is marked, and Stop stops', async () => {
  const board = emptyBoard();
  board.colab.lineup.agents = [{ model: 'openai/gpt-6.1-sol', roleId: 'qa', settings: {} }];
  board.colab.roster = [{ id: 'agent:openai/gpt-6.1-sol=qa', model: 'openai/gpt-6.1-sol', roleId: 'qa', name: 'QA', modelName: 'GPT 6.1 Sol', color: 'sky' }];
  live.board = board;
  const running: RunStatus = { ...idle, state: 'running', round: 1, current: 'agent:openai/gpt-6.1-sol=qa', spent: 0.42 };
  vi.mocked(api.colab).mockResolvedValue({ status: running, hasKey: true, library });
  live.colab = running;
  render(AgentsPanel);

  expect(screen.getByLabelText('Model')).toBeDisabled();
  expect(screen.getByLabelText('Role')).toBeDisabled();
  expect(screen.getByLabelText('Rounds')).toBeDisabled();
  expect(screen.getByRole('button', { name: '+ Add agent' })).toBeDisabled();
  expect(screen.getByRole('listitem')).toHaveAttribute('aria-current', 'true');
  expect(screen.getByText('$0.42 of $5')).toBeInTheDocument();

  vi.mocked(api.stopColab).mockResolvedValue({ ...running, state: 'stopping' });
  await fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
  expect(api.stopColab).toHaveBeenCalled();
  expect(await screen.findByRole('button', { name: 'Stopping…' })).toBeDisabled();
});

test('a model list that will not load is said so, and a typed model still works', async () => {
  vi.mocked(api.colabModels).mockRejectedValue(new Error('502'));
  const board = emptyBoard();
  board.colab.lineup.agents = [{ model: 'openai/gpt-6.1-sol', roleId: 'creative', settings: {} }];
  live.board = board;
  render(AgentsPanel);

  expect(await screen.findByText(/Couldn't load the model list/)).toBeInTheDocument();
  expect(screen.getByLabelText('Model')).toHaveValue('openai/gpt-6.1-sol');
  expect(screen.getByRole('button', { name: 'Start' })).toBeEnabled();
});

test('an out-of-range rounds value is clamped, sent, and shown clamped', async () => {
  render(AgentsPanel);
  const rounds = screen.getByLabelText('Rounds');
  await fireEvent.change(rounds, { target: { value: '99' } });
  expect(rounds).toHaveValue(50);
  expect(lastLineup()).toMatchObject({ type: 'setColabLineup', rounds: 50 });
});

test('dragging a grip onto another card reorders the line-up', async () => {
  live.board = emptyBoard();
  live.board.colab.lineup.agents = [
    { model: 'google/gemini-4-argon', roleId: 'creative', settings: {} },
    { model: 'openai/gpt-6.1-sol', roleId: 'qa', settings: {} },
  ];
  render(AgentsPanel);
  const grips = screen.getAllByTitle('Drag to reorder');
  const cards = screen.getAllByRole('listitem');
  const dataTransfer = { setData: vi.fn() };
  await fireEvent.dragStart(grips[0], { dataTransfer });
  await fireEvent.dragOver(cards[1], { dataTransfer });
  await fireEvent.drop(cards[1], { dataTransfer });
  expect(dataTransfer.setData).toHaveBeenCalledWith('text/plain', '0');
  expect(lastLineup()).toMatchObject({ agents: [{ model: 'openai/gpt-6.1-sol' }, { model: 'google/gemini-4-argon' }] });
});
