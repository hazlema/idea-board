import { beforeEach, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
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

// Cards already in the line-up (as a saved board would have them), with no model chosen yet.
function withCards(count: number): void {
  const board = emptyBoard();
  board.colab.lineup = { agents: Array.from({ length: count }, () => ({ model: '', roleId: 'creative', settings: {} })), rounds: 5, budget: 5, turnLimit: 30 };
  live.board = board;
}

test('+ Add agent opens a dialog: search, pick a model and a role, Add puts the card in the sidebar', async () => {
  render(AgentsPanel);
  await waitFor(() => expect(colabState.models).not.toBeNull());
  await fireEvent.click(screen.getByRole('button', { name: '+ Add agent' }));
  const dialog = screen.getByRole('dialog', { name: 'Add an agent' });
  const add = within(dialog).getByRole('button', { name: 'Add' });
  expect(add).toBeDisabled();

  await fireEvent.input(within(dialog).getByRole('searchbox', { name: 'Search models' }), { target: { value: 'sol' } });
  expect(within(dialog).queryByRole('option', { name: /Gemini 4 Argon/ })).toBeNull();
  await fireEvent.click(within(dialog).getByRole('option', { name: /GPT 6.1 Sol/ }));
  await fireEvent.change(within(dialog).getByRole('combobox', { name: 'Role' }), { target: { value: 'qa' } });
  await fireEvent.click(add);

  expect(screen.queryByRole('dialog', { name: 'Add an agent' })).toBeNull();
  expect(lastLineup()).toEqual({ type: 'setColabLineup', agents: [{ model: 'openai/gpt-6.1-sol', roleId: 'qa', settings: {} }], rounds: 5, budget: 5, turnLimit: 30 });
});

test('the dialog takes the keyboard (arrows and Enter), and Escape closes it without adding', async () => {
  render(AgentsPanel);
  await waitFor(() => expect(colabState.models).not.toBeNull());
  await fireEvent.click(screen.getByRole('button', { name: '+ Add agent' }));
  const search = screen.getByRole('searchbox', { name: 'Search models' });
  await fireEvent.keyDown(search, { key: 'Escape' });
  expect(screen.queryByRole('dialog', { name: 'Add an agent' })).toBeNull();
  expect(api.op).not.toHaveBeenCalled();

  await fireEvent.click(screen.getByRole('button', { name: '+ Add agent' }));
  const again = screen.getByRole('searchbox', { name: 'Search models' });
  await fireEvent.keyDown(again, { key: 'ArrowDown' });
  await fireEvent.keyDown(again, { key: 'Enter' });
  expect(lastLineup()).toMatchObject({ agents: [{ model: 'openai/gpt-6.1-sol', roleId: 'creative' }] });
});

test('choosing models and roles on the cards sends the line-up in order', async () => {
  withCards(2);
  render(AgentsPanel);
  await waitFor(() => expect(colabState.models).not.toBeNull());

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
    turnLimit: 30,
  });
});

test('Start is disabled with no key, naming the key file, and with a card without a model', async () => {
  vi.mocked(api.colab).mockResolvedValue({ status: idle, hasKey: false, library });
  render(AgentsPanel);
  expect(await screen.findByText('~/.config/openrouter/key')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Start' })).toBeDisabled();

  colabState.hasKey = true;
  withCards(1);
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

test('the turn limit starts at 30 minutes and is clamped to 1 to 120', async () => {
  render(AgentsPanel);
  const limit = screen.getByLabelText('Turn limit (min)');
  expect(limit).toHaveValue(30);
  await fireEvent.change(limit, { target: { value: '500' } });
  expect(limit).toHaveValue(120);
  expect(lastLineup()).toMatchObject({ type: 'setColabLineup', turnLimit: 120 });
  await fireEvent.change(limit, { target: { value: '12.6' } });
  expect(lastLineup()).toMatchObject({ turnLimit: 13 });
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

test('a typed model is saved with Enter (the top match) or when it is an exact id and you leave the box', async () => {
  withCards(2);
  render(AgentsPanel);
  await waitFor(() => expect(colabState.models).not.toBeNull());

  const first = screen.getAllByLabelText('Model')[0];
  await fireEvent.focus(first);
  await fireEvent.input(first, { target: { value: 'argon' } });
  await fireEvent.keyDown(first, { key: 'Enter' });
  expect(lastLineup()).toMatchObject({ agents: [{ model: 'google/gemini-4-argon' }, { model: '' }] });

  const second = screen.getAllByLabelText('Model')[1];
  await fireEvent.focus(second);
  await fireEvent.input(second, { target: { value: 'openai/gpt-6.1-sol' } });
  await fireEvent.blur(second);
  expect(lastLineup()).toMatchObject({ agents: [{ model: 'google/gemini-4-argon' }, { model: 'openai/gpt-6.1-sol' }] });
});


test('the suggestion list stays put until the press that left the box is over, so a click on "+ Add agent" lands', async () => {
  withCards(1);
  render(AgentsPanel);
  await waitFor(() => expect(colabState.models).not.toBeNull());
  const box = screen.getAllByLabelText('Model')[0];
  await fireEvent.focus(box);
  await fireEvent.input(box, { target: { value: 'google/gemini-4-argon' } });

  // Pressing the mouse on another control takes focus from the box first.
  await fireEvent.pointerDown(window);
  await fireEvent.blur(box);
  expect(screen.getByRole('listbox', { name: 'Models' })).toBeInTheDocument();
  expect(lastLineup()).toMatchObject({ agents: [{ model: 'google/gemini-4-argon' }] });

  await fireEvent.pointerUp(window);
  await waitFor(() => expect(screen.queryByRole('listbox', { name: 'Models' })).toBeNull());
});

test('a card keeps room for the price line before a model is chosen, so choosing one moves nothing below it', async () => {
  withCards(1);
  render(AgentsPanel);
  await waitFor(() => expect(colabState.models).not.toBeNull());
  expect(screen.getByTestId('model-price')).toBeInTheDocument();
});

test('the agent taking its turn says so on its card, in its colour; spend sits beside the heading', async () => {
  const board = emptyBoard();
  board.colab.lineup = { agents: [{ model: 'google/gemini-4-argon', roleId: 'qa', settings: {} }, { model: 'openai/gpt-6.1-sol', roleId: 'creative', settings: {} }], rounds: 5, budget: 5, turnLimit: 30 };
  board.colab.roster = [
    { id: 'agent:google/gemini-4-argon=qa', model: 'google/gemini-4-argon', roleId: 'qa', name: 'Gemini 4 Argon · QA', modelName: 'Gemini 4 Argon', color: 'green' },
    { id: 'agent:openai/gpt-6.1-sol=creative', model: 'openai/gpt-6.1-sol', roleId: 'creative', name: 'GPT 6.1 Sol · Creative', modelName: 'GPT 6.1 Sol', color: 'sky' },
  ];
  live.board = board;
  const running: RunStatus = { state: 'running', round: 2, rounds: 5, current: 'agent:google/gemini-4-argon=qa', spent: 0.42, budget: 5 };
  vi.mocked(api.colab).mockResolvedValue({ status: running, hasKey: true, library });
  live.colab = running;
  render(AgentsPanel);
  await waitFor(() => expect(colabState.models).not.toBeNull());

  const cards = screen.getAllByRole('listitem').filter((li) => li.closest('[aria-label="Agents"]') && li.querySelector('[aria-label="Role"]'));
  expect(cards[0]).toHaveAttribute('aria-current', 'true');
  expect(cards[0]).toHaveTextContent('taking its turn…');
  expect(cards[1]).not.toHaveTextContent('taking its turn…');
  // Shown by name, not by id, when the list knows the model.
  expect((screen.getAllByLabelText('Model')[0] as HTMLInputElement).value).toBe('Gemini 4 Argon');
  expect(screen.getByRole('heading', { name: 'Agents' }).parentElement).toHaveTextContent('$0.42 of $5');
});

test('spend under ten cents shows tenths of a cent, so a run that has spent something never reads $0.00', async () => {
  const running: RunStatus = { ...idle, state: 'running', round: 1, current: null, spent: 0.0043, budget: 0.5 };
  vi.mocked(api.colab).mockResolvedValue({ status: running, hasKey: true, library });
  live.colab = running;
  render(AgentsPanel);
  await waitFor(() => expect(screen.getByText('$0.004 of $0.50')).toBeInTheDocument());
});
