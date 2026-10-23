import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { emptyBoard } from '../test-board';
import type { Board, FlowEdge, FlowNode, RuledOut } from '$lib/types';

vi.mock('$lib/api', () => ({ op: vi.fn().mockResolvedValue({}) }));

import * as api from '$lib/api';
import { live, RETRY_MS } from '$lib/live.svelte';
import FlowchartView from './FlowchartView.svelte';

const node = (id: string, title: string, extra: Partial<FlowNode> = {}): FlowNode => ({
  id,
  title,
  notes: '',
  props: [],
  status: 'idea',
  author: 'user',
  x: 0,
  y: 0,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  updatedBy: 'user',
  ...extra,
});

const record = (nodeId: string, extra: Partial<RuledOut> = {}): RuledOut => ({
  id: `r_${nodeId}`,
  text: 'Dragons',
  reason: 'too big',
  by: 'user',
  at: new Date().toISOString(),
  source: { view: 'flowchart', label: 'Dragons', nodeId },
  snapshot: null,
  ...extra,
});

function boardWith(nodes: FlowNode[], edges: FlowEdge[] = [], ruledOut: RuledOut[] = []): Board {
  const board = emptyBoard();
  board.flow = { nodes, edges };
  board.ruledOut = ruledOut;
  return board;
}

const card = (container: HTMLElement, id: string): HTMLElement => container.querySelector(`[data-node-id="${id}"]`) as HTMLElement;

async function select(container: HTMLElement, id: string): Promise<void> {
  await fireEvent.pointerDown(card(container, id), { button: 0 });
}

beforeEach(() => {
  localStorage.clear();
  vi.mocked(api.op).mockReset();
  vi.mocked(api.op).mockResolvedValue({});
  live.board = boardWith([node('n_1', 'Dragons'), node('n_2', 'Wizards', { x: 400 })]);
  live.pointing = null;
});

afterEach(() => {
  vi.restoreAllMocks();
});

test('Rejected asks Why not? and sends ruleOut with the reason', async () => {
  const prompt = vi.spyOn(window, 'prompt').mockReturnValue('too big');
  const { container } = render(FlowchartView);
  await select(container, 'n_1');

  await fireEvent.click(screen.getByRole('button', { name: 'Rejected' }));

  expect(prompt).toHaveBeenCalledWith('Why not?');
  expect(api.op).toHaveBeenCalledWith({ type: 'ruleOut', target: { kind: 'node', id: 'n_1' }, reason: 'too big' });
});

test('cancelling Why not? changes nothing; an empty reason is allowed', async () => {
  const prompt = vi.spyOn(window, 'prompt').mockReturnValue(null);
  const { container } = render(FlowchartView);
  await select(container, 'n_1');

  await fireEvent.click(screen.getByRole('button', { name: 'Rejected' }));
  expect(api.op).not.toHaveBeenCalled();

  prompt.mockReturnValue('');
  await fireEvent.click(screen.getByRole('button', { name: 'Rejected' }));
  expect(api.op).toHaveBeenCalledWith({ type: 'ruleOut', target: { kind: 'node', id: 'n_1' }, reason: '' });
});

test('Idea and Accepted send updateNode', async () => {
  live.board = boardWith([node('n_1', 'Dragons', { status: 'accepted' })]);
  const { container } = render(FlowchartView);
  await select(container, 'n_1');

  await fireEvent.click(screen.getByRole('button', { name: 'Idea' }));
  expect(api.op).toHaveBeenCalledWith({ type: 'updateNode', id: 'n_1', status: 'idea' });
  expect(screen.queryByRole('button', { name: 'Bring back' })).not.toBeInTheDocument();
});

test('a rejected card shows Bring back, which sends bringBack for its record', async () => {
  live.board = boardWith([node('n_1', 'Dragons', { status: 'rejected' }), node('n_2', 'Wizards')], [], [record('n_2'), record('n_1')]);
  const { container } = render(FlowchartView);
  await select(container, 'n_1');

  expect(screen.getByText('Ruled out: too big')).toBeInTheDocument();
  // The way back is Bring back, not the status buttons.
  expect(screen.getByRole('button', { name: 'Idea' })).toBeDisabled();
  await fireEvent.click(screen.getByRole('button', { name: 'Bring back' }));
  expect(api.op).toHaveBeenCalledWith({ type: 'bringBack', id: 'r_n_1' });
});

test('the card checkbox toggles idea and accepted, and is off for rejected cards', async () => {
  live.board = boardWith([node('n_1', 'Dragons'), node('n_2', 'Wizards', { status: 'rejected' })]);
  const { container } = render(FlowchartView);
  const [first, second] = screen.getAllByRole('checkbox', { name: 'Accepted' });

  await fireEvent.click(first);
  await waitFor(() => expect(api.op).toHaveBeenCalledWith({ type: 'updateNode', id: 'n_1', status: 'accepted' }));
  expect(second).toBeDisabled();
  expect(container.querySelectorAll('[data-node-id]')).toHaveLength(2);
});

test('selecting a card points chat at it, and clicking empty canvas clears it', async () => {
  live.board = boardWith([node('n_1', 'x'.repeat(100))]);
  const { container } = render(FlowchartView);
  await select(container, 'n_1');
  expect(live.pointing).toEqual({ kind: 'node', id: 'n_1', label: 'x'.repeat(60) });

  await fireEvent.pointerDown(screen.getByRole('application'), { button: 0 });
  await fireEvent.pointerUp(screen.getByRole('application'), { button: 0 });
  expect(live.pointing).toBeNull();
  expect(screen.queryByLabelText('Title')).not.toBeInTheDocument();
});

test('Hide rejected hides rejected cards and remembers the choice', async () => {
  live.board = boardWith([node('n_1', 'Dragons', { status: 'rejected' }), node('n_2', 'Wizards')]);
  const { container } = render(FlowchartView);
  expect(container.querySelectorAll('[data-node-id]')).toHaveLength(2);

  await fireEvent.click(screen.getByRole('checkbox', { name: 'Hide rejected' }));
  expect(container.querySelectorAll('[data-node-id]')).toHaveLength(1);
  expect(localStorage.getItem('idea-board-hide-rejected')).toBe('1');
});

test('Delete asks first and then deletes the selected card', async () => {
  const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
  const { container } = render(FlowchartView);
  await select(container, 'n_1');

  await fireEvent.keyDown(document.body, { key: 'Delete' });
  expect(confirmSpy).toHaveBeenCalledWith('Delete "Dragons" and its connections?');
  expect(api.op).not.toHaveBeenCalled();

  confirmSpy.mockReturnValue(true);
  await fireEvent.keyDown(document.body, { key: 'Delete' });
  await waitFor(() => expect(api.op).toHaveBeenCalledWith({ type: 'deleteNode', id: 'n_1' }));
});

test('double-clicking empty canvas adds a New idea and focuses its title', async () => {
  vi.mocked(api.op).mockResolvedValue({ node: node('n_new', 'New idea') });
  render(FlowchartView);
  // The view starts at (80, 80), so (330, 128) is world (250, 48); cards are centred on the point.
  await fireEvent.dblClick(screen.getByRole('application'), { clientX: 330, clientY: 128 });
  expect(api.op).toHaveBeenCalledWith({ type: 'addNode', title: 'New idea', x: 140, y: 20 });

  live.board = boardWith([node('n_1', 'Dragons'), node('n_2', 'Wizards', { x: 400 }), node('n_new', 'New idea')]);
  await waitFor(() => expect(screen.getByLabelText('Title')).toHaveFocus());
});

test('typing in the title is not clobbered by a Claude edit, and saves after 400 ms', async () => {
  vi.useFakeTimers();
  try {
    const { container } = render(FlowchartView);
    await select(container, 'n_1');
    const title = screen.getByLabelText('Title') as HTMLInputElement;
    title.focus();
    await fireEvent.input(title, { target: { value: 'My typing' } });

    live.board = boardWith([node('n_1', 'Claude retitled', { updatedBy: 'claude' }), node('n_2', 'Wizards')]);
    await vi.advanceTimersByTimeAsync(0);
    expect(title.value).toBe('My typing');

    await vi.advanceTimersByTimeAsync(400);
    expect(api.op).toHaveBeenCalledWith({ type: 'updateNode', id: 'n_1', title: 'My typing' });
  } finally {
    vi.useRealTimers();
  }
});

test('a failed save in the card panel keeps the typed notes, and a later success saves them', async () => {
  vi.useFakeTimers();
  try {
    vi.mocked(api.op).mockRejectedValueOnce(new Error('Could not reach the board server'));
    const { container } = render(FlowchartView);
    await select(container, 'n_1');
    const notes = screen.getByLabelText('Notes') as HTMLTextAreaElement;
    notes.focus();
    await fireEvent.input(notes, { target: { value: 'Breathe fire' } });
    notes.blur();
    await vi.advanceTimersByTimeAsync(0);
    expect(api.op).toHaveBeenCalledWith({ type: 'updateNode', id: 'n_1', notes: 'Breathe fire' });
    expect(notes.value).toBe('Breathe fire');
    expect(live.saveStatus).toBe('Not saved');

    await vi.advanceTimersByTimeAsync(RETRY_MS);
    expect(api.op).toHaveBeenCalledTimes(2);
    expect(live.saveStatus).toBe('All changes saved');
    expect(notes.value).toBe('Breathe fire');
  } finally {
    vi.useRealTimers();
  }
});

test('a failed save of a connection label keeps the typing until it is saved', async () => {
  live.board = boardWith([node('n_1', 'Dragons'), node('n_2', 'Wizards', { x: 400 })], [{ id: 'e_1', from: 'n_1', to: 'n_2', label: '', author: 'user' }]);
  vi.mocked(api.op).mockRejectedValueOnce(new Error('Could not reach the board server'));
  const { container } = render(FlowchartView);
  // The arrows' layer is hidden from assistive tech (the panel lists connections), so find it directly.
  await fireEvent.pointerDown(container.querySelector('g[aria-label="Connection"]') as Element);
  const label = screen.getByLabelText('Label') as HTMLInputElement;
  label.focus();
  await fireEvent.input(label, { target: { value: 'fears' } });
  label.blur();
  await waitFor(() => expect(api.op).toHaveBeenCalledWith({ type: 'updateEdge', id: 'e_1', label: 'fears' }));
  await waitFor(() => expect(live.saveStatus).toBe('Not saved'));
  expect(label.value).toBe('fears');
  label.focus();
  label.blur();
  await waitFor(() => expect(live.saveStatus).toBe('All changes saved'));
  expect(api.op).toHaveBeenCalledTimes(2);
  expect(label.value).toBe('fears');
});

test('connections in the panel select the other card', async () => {
  live.board = boardWith([node('n_1', 'Dragons'), node('n_2', 'Wizards', { x: 400 })], [{ id: 'e_1', from: 'n_1', to: 'n_2', label: 'fears', author: 'user' }]);
  const { container } = render(FlowchartView);
  await select(container, 'n_1');
  await fireEvent.click(screen.getByRole('button', { name: 'Wizards' }));
  expect(live.pointing?.id).toBe('n_2');
  expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('Wizards');
});

test('a board passed in is shown read-only: its cards, no add or tidy, no selecting, no ops', async () => {
  live.board = boardWith([node('n_live', 'Live card')]);
  const { container } = render(FlowchartView, { board: boardWith([node('n_old', 'Old card')]) });

  expect(screen.getByText('Old card')).toBeInTheDocument();
  expect(screen.queryByText('Live card')).toBeNull();
  expect(screen.queryByRole('button', { name: '+ Idea' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Tidy' })).toBeNull();

  await select(container, 'n_old');
  await fireEvent.keyDown(window, { key: 'Delete' });
  expect(screen.queryByRole('complementary')).toBeNull();
  expect(live.pointing).toBeNull();
  expect(api.op).not.toHaveBeenCalled();
});

test('it tells the page when a card is selected', async () => {
  live.board = boardWith([node('n_1', 'Card')]);
  const onselection = vi.fn();
  const { container } = render(FlowchartView, { onselection });
  expect(onselection).toHaveBeenLastCalledWith(false);

  await select(container, 'n_1');
  await waitFor(() => expect(onselection).toHaveBeenLastCalledWith(true));
});
