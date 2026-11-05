import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { emptyBoard } from '../test-board';
import type { Playtest, PlaytestSummary } from '$lib/types';

vi.mock('$lib/api', () => ({
  playtests: vi.fn(),
  playtest: vi.fn(),
  startPlaytest: vi.fn(),
  playtestAct: vi.fn(),
  endPlaytest: vi.fn(),
}));

import * as api from '$lib/api';
import { live } from '$lib/live.svelte';
import PlaytestView from './PlaytestView.svelte';

const turn = (action: string | null, happened: string, gaps: string[] = []) => ({ at: '2026-11-05T12:00:00Z', action, happened, gaps, assumed: [], rolls: [51], rollsUsed: [] });

const game = (fields: Partial<Playtest> = {}): Playtest => ({
  id: 'pt_00000001',
  player: 'agent:x/y=qa',
  startedAt: new Date().toISOString(),
  endedAt: null,
  over: false,
  verdict: '',
  state: ['Crowd: 40'],
  assumed: ['assumed: 10 people hold a street'],
  turns: [turn(null, 'You stand in a street.'), turn('march at the drum', 'Nothing happens.', ['What a drum does to a crowd'])],
  ...fields,
});

const row = (g: Playtest): PlaytestSummary => ({ id: g.id, player: g.player, startedAt: g.startedAt, endedAt: g.endedAt, over: g.over, actions: g.turns.length - 1, gaps: g.turns.reduce((n, t) => n + t.gaps.length, 0) });

beforeEach(() => {
  vi.clearAllMocks();
  const board = emptyBoard();
  board.colab.roster = [{ id: 'agent:x/y=qa', model: 'x/y', roleId: 'qa', name: 'Y · QA', modelName: 'Y', color: 'amber' }];
  live.board = board;
  live.playtest = null;
});

afterEach(() => {
  live.playtest = null;
});

test("an agent's playtest shows its state, turns, gaps and assumed numbers, and the host can't play it", async () => {
  const qa = game();
  vi.mocked(api.playtests).mockResolvedValue([row(qa)]);
  vi.mocked(api.playtest).mockResolvedValue(qa);
  render(PlaytestView);
  expect(await screen.findByText('You stand in a street.')).toBeInTheDocument();
  expect(within(screen.getByRole('list', { name: 'Playtests' })).getByText('Y · QA')).toBeInTheDocument();
  expect(screen.getByText(/1 gap\b/)).toBeInTheDocument();
  expect(within(screen.getByLabelText('State')).getByText('Crowd: 40')).toBeInTheDocument();
  expect(screen.getByText("The rules don't say: What a drum does to a crowd")).toBeInTheDocument();
  expect(screen.getByText('assumed: 10 people hold a street')).toBeInTheDocument();
  expect(screen.queryByLabelText('What do you do?')).not.toBeInTheDocument();
});

test('the host starts a game, plays a move and ends it with a verdict', async () => {
  vi.mocked(api.playtests).mockResolvedValue([]);
  const opening = game({ id: 'pt_00000002', player: 'user', turns: [turn(null, 'A bell is pressed into your hands.')], state: [], assumed: [] });
  vi.mocked(api.startPlaytest).mockResolvedValue(opening);
  const moved = { ...opening, turns: [...opening.turns, turn('ring it', 'Forty strangers turn.')], state: ['Crowd: 40'] };
  vi.mocked(api.playtestAct).mockResolvedValue(moved);
  vi.mocked(api.endPlaytest).mockResolvedValue({ ...moved, endedAt: new Date().toISOString(), verdict: 'The bell works.' });
  render(PlaytestView);
  await fireEvent.click(await screen.findByRole('button', { name: 'New playtest' }));
  expect(await screen.findByText('A bell is pressed into your hands.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'New playtest' })).toBeDisabled();

  await fireEvent.input(screen.getByLabelText('What do you do?'), { target: { value: 'ring it' } });
  await fireEvent.click(screen.getByRole('button', { name: 'Do it' }));
  expect(api.playtestAct).toHaveBeenCalledWith('ring it');
  expect(await screen.findByText('Forty strangers turn.')).toBeInTheDocument();
  expect((screen.getByLabelText('What do you do?') as HTMLInputElement).value).toBe('');

  await fireEvent.input(screen.getByLabelText(/Your verdict/), { target: { value: 'The bell works.' } });
  await fireEvent.click(screen.getByRole('button', { name: 'End playtest' }));
  expect(api.endPlaytest).toHaveBeenCalledWith('The bell works.');
  expect(await screen.findByText('The bell works.')).toBeInTheDocument();
  expect(screen.queryByLabelText('What do you do?')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'New playtest' })).toBeEnabled();
});

test("an agent's game updates live as it plays", async () => {
  const qa = game({ turns: [turn(null, 'You stand in a street.')] });
  vi.mocked(api.playtests).mockResolvedValue([row(qa)]);
  vi.mocked(api.playtest).mockResolvedValue(qa);
  render(PlaytestView);
  await screen.findByText('You stand in a street.');
  live.playtest = { ...qa, turns: [...qa.turns, turn('ring the bell', 'Forty turn.')] };
  expect(await screen.findByText('Forty turn.')).toBeInTheDocument();
  await waitFor(() => expect(screen.getByText(/1 action\b/)).toBeInTheDocument());
});

test("a refused move says why and keeps what was typed", async () => {
  const mine = game({ player: 'user', turns: [turn(null, 'A street.')] });
  vi.mocked(api.playtests).mockResolvedValue([row(mine)]);
  vi.mocked(api.playtest).mockResolvedValue(mine);
  vi.mocked(api.playtestAct).mockRejectedValue(new Error('The budget is used up; raise it or press Reset to playtest.'));
  const toast = vi.spyOn(live, 'toast');
  render(PlaytestView);
  await fireEvent.input(await screen.findByLabelText('What do you do?'), { target: { value: 'ring it' } });
  await fireEvent.click(screen.getByRole('button', { name: 'Do it' }));
  await waitFor(() => expect(toast).toHaveBeenCalledWith('The budget is used up; raise it or press Reset to playtest.'));
  expect((screen.getByLabelText('What do you do?') as HTMLInputElement).value).toBe('ring it');
});
