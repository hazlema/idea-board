import { beforeEach, expect, test, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';
import { emptyBoard } from '../test-board';
import type { RuledOut } from '$lib/types';

vi.mock('$lib/api', () => ({ op: vi.fn().mockResolvedValue({}) }));

import * as api from '$lib/api';
import { live } from '$lib/live.svelte';
import RuledOutList from './RuledOutList.svelte';

const record = (id: string, text: string, reason: string, extra: Partial<RuledOut> = {}): RuledOut => ({
  id,
  text,
  reason,
  by: 'user',
  at: '2026-10-20T10:00:00.000Z',
  source: { view: 'brainstorm', label: 'Wizards' },
  snapshot: null,
  ...extra,
});

beforeEach(() => {
  vi.mocked(api.op).mockReset();
  vi.mocked(api.op).mockResolvedValue({});
  const board = emptyBoard();
  board.ruledOut = [record('r_old', 'Fire towers', 'too fiddly'), record('r_new', 'Familiars', '', { by: 'claude', source: { view: 'chat', label: 'Chat' } })];
  live.board = board;
});

test('lists the newest first with reason, author and source, and the hint line', () => {
  render(RuledOutList);

  const cards = screen.getAllByRole('article');
  expect(cards[0]).toHaveTextContent('Familiars');
  expect(cards[0]).toHaveTextContent(/Claude · .* · Chat/);
  expect(cards[1]).toHaveTextContent('Fire towers');
  expect(cards[1]).toHaveTextContent('“too fiddly”');
  expect(cards[1]).toHaveTextContent(/You · .* · Wizards/);
  expect(screen.getByText("Claude checks this list before suggesting anything, and won't bring these back unless you do.")).toBeInTheDocument();
});

test('Bring back sends bringBack for that record', async () => {
  render(RuledOutList);

  const buttons = screen.getAllByRole('button', { name: 'Bring back' });
  await fireEvent.click(buttons[1]);
  expect(api.op).toHaveBeenCalledWith({ type: 'bringBack', id: 'r_old' });
});
