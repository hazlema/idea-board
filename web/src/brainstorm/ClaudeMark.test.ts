import { expect, test } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import { live } from '$lib/live.svelte';
import { emptyBoard } from '../test-board';
import ClaudeMark from './ClaudeMark.svelte';

const noop = () => {};

test('an agent-authored object shows "<name> added"', () => {
  const board = emptyBoard();
  board.colab.roster = [{ id: 'agent:x/y=qa', model: 'x/y', roleId: 'qa', name: 'Y · QA', modelName: 'Y', color: 'sky' }];
  live.board = board;
  render(ClaudeMark, { variant: 'object', by: 'agent:x/y=qa', onkeep: noop, ondismiss: noop });
  expect(screen.getByText('Y · QA added')).toBeInTheDocument();
});

test('Claude keeps "Claude added"', () => {
  live.board = emptyBoard();
  render(ClaudeMark, { variant: 'entry', by: 'claude', onkeep: noop, ondismiss: noop });
  expect(screen.getByText('Claude added')).toBeInTheDocument();
});
