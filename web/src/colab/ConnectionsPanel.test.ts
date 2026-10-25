import { beforeEach, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { emptyBoard } from '../test-board';
import type { Model, RunStatus } from '$lib/types';

vi.mock('$lib/api', () => ({
  op: vi.fn().mockResolvedValue({}),
  colab: vi.fn(),
  colabModels: vi.fn(),
  colabImageModels: vi.fn(),
  resetSpent: vi.fn(),
}));

import * as api from '$lib/api';
import { live } from '$lib/live.svelte';
import { colabState } from './colab.svelte';
import ConnectionsPanel from './ConnectionsPanel.svelte';

const library = {
  rules: '',
  roles: [
    { id: 'creative', name: 'Creative', job: '' },
    { id: 'qa', name: 'QA', job: '' },
  ],
};
const models: Model[] = [
  {
    id: 'google/gemini-4-argon',
    name: 'Gemini 4 Argon',
    promptPrice: 1,
    completionPrice: 4,
    context: 1000,
  },
  {
    id: 'openai/gpt-6.1-sol',
    name: 'GPT 6.1 Sol',
    promptPrice: 2,
    completionPrice: 8,
    context: 1000,
  },
];
const imageModels: Model[] = [{ id: 'google/imagen-9', name: 'Imagen 9', promptPrice: 1, completionPrice: 2, context: 1000 }];
const idle: RunStatus = {
  state: 'idle',
  round: 0,
  rounds: 5,
  current: null,
  spent: 0,
  budget: 5,
  claude: 'binary',
  connections: {},
};

beforeEach(() => {
  vi.clearAllMocks();
  live.board = emptyBoard();
  live.colab = idle;
  colabState.models = null;
  colabState.modelsError = null;
  colabState.loaded = false;
  vi.mocked(api.colab).mockResolvedValue({
    status: idle,
    hasKey: true,
    library,
    connections: [],
  });
  vi.mocked(api.colabModels).mockResolvedValue(models);
  vi.mocked(api.colabImageModels).mockResolvedValue(imageModels);
  colabState.imageModels = null;
});

const lastLineup = () => vi.mocked(api.op).mock.calls.at(-1)?.[0];

// Cards already in the line-up (as a saved board would have them), with no model chosen yet.
function withCards(count: number): void {
  const board = emptyBoard();
  board.colab.lineup = {
    agents: Array.from({ length: count }, () => ({
      model: '',
      roleId: 'creative',
      settings: {},
    })),
    rounds: 5,
    budget: 5,
    turnLimit: 30,
    claudeRoleId: 'creative',
    imageModel: '',
    claudeModel: 'sonnet',
    pruneLimit: 5,
    pruneAggressiveness: 'normal',
  };
  live.board = board;
}

test('+ Add connection opens a dialog: search, pick a model and a role, Add puts the card in the sidebar', async () => {
  render(ConnectionsPanel);
  await waitFor(() => expect(colabState.models).not.toBeNull());
  await fireEvent.click(screen.getByRole('button', { name: '+ Add connection' }));
  const dialog = screen.getByRole('dialog', { name: 'Add a connection' });
  const add = within(dialog).getByRole('button', { name: 'Add' });
  expect(add).toBeDisabled();

  await fireEvent.input(within(dialog).getByRole('searchbox', { name: 'Search models' }), { target: { value: 'sol' } });
  expect(within(dialog).queryByRole('option', { name: /Gemini 4 Argon/ })).toBeNull();
  await fireEvent.click(within(dialog).getByRole('option', { name: /GPT 6.1 Sol/ }));
  await fireEvent.change(within(dialog).getByRole('combobox', { name: 'Role' }), { target: { value: 'qa' } });
  await fireEvent.click(add);

  expect(screen.queryByRole('dialog', { name: 'Add a connection' })).toBeNull();
  expect(lastLineup()).toEqual({
    type: 'setColabLineup',
    agents: [{ model: 'openai/gpt-6.1-sol', roleId: 'qa', settings: {} }],
    rounds: 5,
    budget: 5,
    turnLimit: 30,
    claudeRoleId: 'creative',
    claudeModel: 'sonnet',
  });
});

test('the dialog takes the keyboard (arrows and Enter), and Escape closes it without adding', async () => {
  render(ConnectionsPanel);
  await waitFor(() => expect(colabState.models).not.toBeNull());
  await fireEvent.click(screen.getByRole('button', { name: '+ Add connection' }));
  const search = screen.getByRole('searchbox', { name: 'Search models' });
  await fireEvent.keyDown(search, { key: 'Escape' });
  expect(screen.queryByRole('dialog', { name: 'Add a connection' })).toBeNull();
  expect(api.op).not.toHaveBeenCalled();

  await fireEvent.click(screen.getByRole('button', { name: '+ Add connection' }));
  const again = screen.getByRole('searchbox', { name: 'Search models' });
  await fireEvent.keyDown(again, { key: 'ArrowDown' });
  await fireEvent.keyDown(again, { key: 'Enter' });
  expect(lastLineup()).toMatchObject({
    agents: [{ model: 'openai/gpt-6.1-sol', roleId: 'creative' }],
  });
});

test('choosing models and roles on the cards sends the line-up in order', async () => {
  withCards(2);
  render(ConnectionsPanel);
  await waitFor(() => expect(colabState.models).not.toBeNull());

  const pickers = screen.getAllByLabelText('Model');
  await fireEvent.focus(pickers[0]);
  await fireEvent.click(await screen.findByRole('button', { name: /Gemini 4 Argon/ }));
  await fireEvent.focus(screen.getAllByLabelText('Model')[1]);
  await fireEvent.input(screen.getAllByLabelText('Model')[1], {
    target: { value: 'sol' },
  });
  await fireEvent.click(await screen.findByRole('button', { name: /GPT 6.1 Sol/ }));
  await fireEvent.change(screen.getAllByLabelText('Role')[1], {
    target: { value: 'qa' },
  });

  expect(lastLineup()).toEqual({
    type: 'setColabLineup',
    agents: [
      { model: 'google/gemini-4-argon', roleId: 'creative', settings: {} },
      { model: 'openai/gpt-6.1-sol', roleId: 'qa', settings: {} },
    ],
    rounds: 5,
    budget: 5,
    turnLimit: 30,
    claudeRoleId: 'creative',
    claudeModel: 'sonnet',
  });
});

test('while running the inputs are locked and the current card is marked', async () => {
  const board = emptyBoard();
  board.colab.lineup.agents = [{ model: 'openai/gpt-6.1-sol', roleId: 'qa', settings: {} }];
  board.colab.roster = [
    {
      id: 'agent:openai/gpt-6.1-sol=qa',
      model: 'openai/gpt-6.1-sol',
      roleId: 'qa',
      name: 'QA',
      modelName: 'GPT 6.1 Sol',
      color: 'sky',
    },
  ];
  live.board = board;
  const running: RunStatus = {
    ...idle,
    state: 'running',
    round: 1,
    current: 'agent:openai/gpt-6.1-sol=qa',
    spent: 0.42,
  };
  vi.mocked(api.colab).mockResolvedValue({
    status: running,
    hasKey: true,
    library,
    connections: [],
  });
  live.colab = running;
  render(ConnectionsPanel);

  expect(screen.getByLabelText('Model')).toBeDisabled();
  expect(screen.getByLabelText('Role')).toBeDisabled();
  expect(screen.getByLabelText('Claude role')).toBeDisabled();
  expect(screen.getByLabelText('Rounds')).toBeDisabled();
  expect(screen.getByRole('button', { name: '+ Add connection' })).toBeDisabled();
  expect(screen.getByRole('listitem')).toHaveAttribute('aria-current', 'true');
});

test('a model list that will not load is said so, and a typed model still works', async () => {
  vi.mocked(api.colabModels).mockRejectedValue(new Error('502'));
  const board = emptyBoard();
  board.colab.lineup.agents = [{ model: 'openai/gpt-6.1-sol', roleId: 'creative', settings: {} }];
  live.board = board;
  render(ConnectionsPanel);

  expect(await screen.findByText(/Couldn't load the model list/)).toBeInTheDocument();
  expect(screen.getByLabelText('Model')).toHaveValue('openai/gpt-6.1-sol');
});

test('an out-of-range rounds value is clamped, sent, and shown clamped', async () => {
  render(ConnectionsPanel);
  const rounds = screen.getByLabelText('Rounds');
  await fireEvent.change(rounds, { target: { value: '99' } });
  expect(rounds).toHaveValue(50);
  expect(lastLineup()).toMatchObject({ type: 'setColabLineup', rounds: 50 });
});

test('the turn timeout starts at 30 minutes and is clamped to 1 to 120', async () => {
  render(ConnectionsPanel);
  const limit = screen.getByLabelText('Turn timeout (min)');
  expect(limit).toHaveValue(30);
  await fireEvent.change(limit, { target: { value: '500' } });
  expect(limit).toHaveValue(120);
  expect(lastLineup()).toMatchObject({
    type: 'setColabLineup',
    turnLimit: 120,
  });
  await fireEvent.change(limit, { target: { value: '12.6' } });
  expect(lastLineup()).toMatchObject({ turnLimit: 13 });
});

test('dragging a grip onto another card reorders the line-up', async () => {
  live.board = emptyBoard();
  live.board.colab.lineup.agents = [
    { model: 'google/gemini-4-argon', roleId: 'creative', settings: {} },
    { model: 'openai/gpt-6.1-sol', roleId: 'qa', settings: {} },
  ];
  render(ConnectionsPanel);
  const grips = screen.getAllByTitle('Drag to reorder');
  const cards = screen.getAllByRole('listitem');
  const dataTransfer = { setData: vi.fn() };
  await fireEvent.dragStart(grips[0], { dataTransfer });
  await fireEvent.dragOver(cards[1], { dataTransfer });
  await fireEvent.drop(cards[1], { dataTransfer });
  expect(dataTransfer.setData).toHaveBeenCalledWith('text/plain', '0');
  expect(lastLineup()).toMatchObject({
    agents: [{ model: 'openai/gpt-6.1-sol' }, { model: 'google/gemini-4-argon' }],
  });
});

test('a typed model is saved with Enter (the top match) or when it is an exact id and you leave the box', async () => {
  withCards(2);
  render(ConnectionsPanel);
  await waitFor(() => expect(colabState.models).not.toBeNull());

  const first = screen.getAllByLabelText('Model')[0];
  await fireEvent.focus(first);
  await fireEvent.input(first, { target: { value: 'argon' } });
  await fireEvent.keyDown(first, { key: 'Enter' });
  expect(lastLineup()).toMatchObject({
    agents: [{ model: 'google/gemini-4-argon' }, { model: '' }],
  });

  const second = screen.getAllByLabelText('Model')[1];
  await fireEvent.focus(second);
  await fireEvent.input(second, { target: { value: 'openai/gpt-6.1-sol' } });
  await fireEvent.blur(second);
  expect(lastLineup()).toMatchObject({
    agents: [{ model: 'google/gemini-4-argon' }, { model: 'openai/gpt-6.1-sol' }],
  });
});

test('the suggestion list stays put until the press that left the box is over, so a click on "+ Add connection" lands', async () => {
  withCards(1);
  render(ConnectionsPanel);
  await waitFor(() => expect(colabState.models).not.toBeNull());
  const box = screen.getAllByLabelText('Model')[0];
  await fireEvent.focus(box);
  await fireEvent.input(box, { target: { value: 'google/gemini-4-argon' } });

  // Pressing the mouse on another control takes focus from the box first.
  await fireEvent.pointerDown(window);
  await fireEvent.blur(box);
  expect(screen.getByRole('listbox', { name: 'Models' })).toBeInTheDocument();
  expect(lastLineup()).toMatchObject({
    agents: [{ model: 'google/gemini-4-argon' }],
  });

  await fireEvent.pointerUp(window);
  await waitFor(() => expect(screen.queryByRole('listbox', { name: 'Models' })).toBeNull());
});

test('a card keeps room for the price line before a model is chosen, so choosing one moves nothing below it', async () => {
  withCards(1);
  render(ConnectionsPanel);
  await waitFor(() => expect(colabState.models).not.toBeNull());
  expect(screen.getAllByTestId('model-price')[0]).toBeInTheDocument();
});

test('a card shows its activity, in its colour, and the current card is marked', async () => {
  const board = emptyBoard();
  board.colab.lineup.agents = [
    { model: 'google/gemini-4-argon', roleId: 'qa', settings: {} },
    { model: 'openai/gpt-6.1-sol', roleId: 'creative', settings: {} },
  ];
  board.colab.roster = [
    {
      id: 'agent:google/gemini-4-argon=qa',
      model: 'google/gemini-4-argon',
      roleId: 'qa',
      name: 'Gemini 4 Argon · QA',
      modelName: 'Gemini 4 Argon',
      color: 'green',
    },
    {
      id: 'agent:openai/gpt-6.1-sol=creative',
      model: 'openai/gpt-6.1-sol',
      roleId: 'creative',
      name: 'GPT 6.1 Sol · Creative',
      modelName: 'GPT 6.1 Sol',
      color: 'sky',
    },
  ];
  live.board = board;
  const running: RunStatus = {
    ...idle,
    state: 'running',
    round: 2,
    current: 'agent:google/gemini-4-argon=qa',
    connections: {
      'agent:google/gemini-4-argon=qa': {
        state: 'thinking',
        activity: 'adding note',
        done: [],
      },
      'agent:openai/gpt-6.1-sol=creative': {
        state: 'over-budget',
        activity: null,
        done: [],
      },
    },
  };
  vi.mocked(api.colab).mockResolvedValue({ status: running, hasKey: true, library, connections: [] });
  live.colab = running;
  render(ConnectionsPanel);
  await waitFor(() => expect(colabState.models).not.toBeNull());

  const cards = screen.getAllByRole('listitem');
  expect(cards[0]).toHaveAttribute('aria-current', 'true');
  expect(cards[0]).toHaveTextContent('adding note…');
  expect(cards[1]).not.toHaveAttribute('aria-current');
  expect(cards[1]).toHaveTextContent('Over budget');
  expect((screen.getAllByLabelText('Model')[0] as HTMLInputElement).value).toBe('Gemini 4 Argon');
});

test('a card with nothing to do says Waiting', () => {
  withCards(1);
  render(ConnectionsPanel);
  expect(screen.getByRole('listitem')).toHaveTextContent('Waiting');
});

test('shows Claude as connection 1 via binary with Waiting', () => {
  render(ConnectionsPanel);
  expect(screen.getByRole('button', { name: '1. Claude · Sonnet' }).parentElement).toHaveTextContent('1. Claude · Sonnet (via binary)');
  expect(screen.getByText('(via binary)')).toBeInTheDocument();
  expect(screen.getByText('Waiting')).toBeInTheDocument();
  expect(screen.getByText('None yet.')).toBeInTheDocument();
});

test('Claude shows Thinking while the background Claude works or it holds the turn', () => {
  live.agent = 'working';
  render(ConnectionsPanel);
  expect(screen.getByText('Thinking…')).toBeInTheDocument();
  live.agent = 'idle';
});

test('Claude via MCP says so', () => {
  live.colab = { ...idle, claude: 'mcp' };
  render(ConnectionsPanel);
  expect(screen.getByText('(via MCP)')).toBeInTheDocument();
});

test('shows the MCP warning when Claude is not connected', () => {
  live.colab = { ...idle, claude: 'none' };
  const { container } = render(ConnectionsPanel);
  expect(screen.getByText(/claude command wasn't found/)).toBeInTheDocument();
  expect(screen.getByText('(not connected)')).toBeInTheDocument();
  expect(container.querySelector('pre')).toHaveTextContent('claude mcp add --transport http idea-board');
  expect(container.querySelector('pre')).toHaveTextContent('/mcp');
});

test('OpenRouter cards are numbered from 2', () => {
  withCards(2);
  render(ConnectionsPanel);
  expect(screen.getByText('2 ·')).toBeInTheDocument();
  expect(screen.getByText('3 ·')).toBeInTheDocument();
});

test("changing Claude's role saves claudeRoleId", async () => {
  render(ConnectionsPanel);
  await waitFor(() => expect(colabState.loaded).toBe(true));
  await fireEvent.change(screen.getByLabelText('Claude role'), {
    target: { value: 'qa' },
  });
  expect(lastLineup()).toEqual(expect.objectContaining({ type: 'setColabLineup', claudeRoleId: 'qa' }));
});

test('spent and Reset', async () => {
  live.board = emptyBoard();
  live.board.colab.spent = 0.42;
  live.colab = { ...idle, spent: 0.42, budget: 5 };
  vi.mocked(api.resetSpent).mockResolvedValue({ ...idle, spent: 0, budget: 5 });
  vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));
  render(ConnectionsPanel);
  expect(screen.getByText('Spent $0.42 of $5')).toBeInTheDocument();
  await fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
  expect(confirm).toHaveBeenCalledWith('Reset spent to $0.00?');
  expect(api.resetSpent).toHaveBeenCalled();
  vi.unstubAllGlobals();
});

test('declining the Reset confirmation resets nothing', async () => {
  vi.stubGlobal('confirm', vi.fn().mockReturnValue(false));
  render(ConnectionsPanel);
  await fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
  expect(api.resetSpent).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

test('spend under ten cents shows tenths of a cent, so money spent never reads $0.00', () => {
  live.colab = { ...idle, spent: 0.0043, budget: 0.5 };
  live.board = emptyBoard();
  live.board.colab.spent = 0.0043;
  render(ConnectionsPanel);
  expect(screen.getByText('Spent $0.004 of $0.50')).toBeInTheDocument();
});

test('no Start or Stop button', () => {
  render(ConnectionsPanel);
  expect(screen.queryByRole('button', { name: 'Start' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
});

test("a line-up with no Claude role falls back to the Foreman, as the server does", async () => {
  vi.mocked(api.colab).mockResolvedValue({
    status: idle,
    hasKey: true,
    library: { rules: '', roles: [...library.roles, { id: 'foreman', name: 'Foreman', job: '' }] },
    connections: [],
  });
  const board = emptyBoard();
  const { claudeRoleId: _unset, ...lineup } = board.colab.lineup;
  board.colab.lineup = lineup as typeof board.colab.lineup;
  live.board = board;
  render(ConnectionsPanel);
  await waitFor(() => expect(colabState.library.roles.some((r) => r.id === 'foreman')).toBe(true));
  expect(screen.getByRole('combobox', { name: 'Claude role' })).toHaveValue('foreman');
});

function withClaudeModel(claudeModel: string): void {
  const board = emptyBoard();
  board.colab.lineup.claudeModel = claudeModel;
  live.board = board;
}

test("Claude's card shows its model and opens the popup", async () => {
  withClaudeModel('opus');
  render(ConnectionsPanel);
  await waitFor(() => expect(colabState.loaded).toBe(true));
  const button = screen.getByRole('button', { name: '1. Claude · Opus' });
  await fireEvent.click(button);
  expect(screen.getByRole('radio', { name: 'Opus' })).toBeChecked();
  await waitFor(() => expect(screen.getByRole('radio', { name: 'Opus' })).toHaveFocus());
  await fireEvent.click(screen.getByRole('radio', { name: 'Haiku' }));
  await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(api.op).toHaveBeenCalledWith(expect.objectContaining({ type: 'setColabLineup', claudeModel: 'haiku' }));
  expect(screen.queryByRole('group', { name: "Claude's model" })).toBeNull();
  expect(button).toHaveFocus();
});

test('Cancel and Escape close the popup without saving; it is disabled during a run', async () => {
  render(ConnectionsPanel);
  await waitFor(() => expect(colabState.loaded).toBe(true));
  await fireEvent.click(screen.getByRole('button', { name: '1. Claude · Sonnet' }));
  await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByRole('group', { name: "Claude's model" })).toBeNull();
  await fireEvent.click(screen.getByRole('button', { name: '1. Claude · Sonnet' }));
  await fireEvent.keyDown(screen.getByRole('radio', { name: 'Sonnet' }), { key: 'Escape' });
  expect(screen.queryByRole('group', { name: "Claude's model" })).toBeNull();
  expect(api.op).not.toHaveBeenCalled();
  live.colab = { ...idle, state: 'running' };
  await waitFor(() => expect(screen.getByRole('button', { name: '1. Claude · Sonnet' })).toBeDisabled());
});

test('Other… saves a custom id, and a custom id shows as the label', async () => {
  render(ConnectionsPanel);
  await waitFor(() => expect(colabState.loaded).toBe(true));
  await fireEvent.click(screen.getByRole('button', { name: '1. Claude · Sonnet' }));
  await fireEvent.click(screen.getByRole('radio', { name: 'Other…' }));
  await fireEvent.input(screen.getByRole('textbox', { name: 'Model id' }), { target: { value: 'claude-opus-5-5' } });
  await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(api.op).toHaveBeenCalledWith(expect.objectContaining({ type: 'setColabLineup', claudeModel: 'claude-opus-5-5' }));
  expect(screen.getByRole('button', { name: '1. Claude · claude-opus-5-5' })).toBeInTheDocument();
});

test('a custom id prefills the Other… box', async () => {
  withClaudeModel('claude-opus-5-5');
  render(ConnectionsPanel);
  await waitFor(() => expect(colabState.loaded).toBe(true));
  await fireEvent.click(screen.getByRole('button', { name: '1. Claude · claude-opus-5-5' }));
  expect(screen.getByRole('textbox', { name: 'Model id' })).toHaveValue('claude-opus-5-5');
});

test('the popup notes MCP', async () => {
  live.colab = { ...idle, claude: 'mcp' };
  render(ConnectionsPanel);
  await waitFor(() => expect(colabState.loaded).toBe(true));
  live.colab = { ...idle, claude: 'mcp' };
  await fireEvent.click(screen.getByRole('button', { name: /^1\. Claude/ }));
  expect(screen.getByText('Set by your session while connected via MCP.')).toBeInTheDocument();
});

test('the image model is not in the sidebar (it is in Settings), and the line-up leaves it alone', async () => {
  render(ConnectionsPanel);
  await waitFor(() => expect(colabState.loaded).toBe(true));
  expect(screen.queryByLabelText('Image model')).toBeNull();
  await fireEvent.click(screen.getByRole('button', { name: '+ Add connection' }));
  await fireEvent.input(screen.getByRole('searchbox', { name: 'Search models' }), { target: { value: 'sol' } });
  await fireEvent.click(screen.getByRole('option', { name: /GPT 6.1 Sol/ }));
  await fireEvent.click(screen.getByRole('button', { name: 'Add' }));
  expect(lastLineup()).not.toHaveProperty('imageModel');
});

test('the Claude popup stays closed once a run that started while it was open ends', async () => {
  live.board = emptyBoard();
  live.colab = idle;
  render(ConnectionsPanel);
  await waitFor(() => expect(colabState.loaded).toBe(true));
  await fireEvent.click(screen.getByRole('button', { name: '1. Claude · Sonnet' }));
  expect(screen.getByRole('group', { name: "Claude's model" })).toBeInTheDocument();
  live.colab = { ...idle, state: 'running' };
  await waitFor(() => expect(screen.getByRole('button', { name: '1. Claude · Sonnet' })).toBeDisabled());
  live.colab = idle;
  await waitFor(() => expect(screen.getByRole('button', { name: '1. Claude · Sonnet' })).toBeEnabled());
  expect(screen.queryByRole('group', { name: "Claude's model" })).toBeNull();
});
