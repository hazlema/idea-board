import { expect, test } from 'vitest';
import { authorColor, authorName, cardIds, isAi } from './authors';
import { emptyBoard } from '../test-board';

const board = emptyBoard();
board.colab.roster = [{ id: 'agent:x/y=qa', model: 'x/y', roleId: 'qa', name: 'Y · QA', modelName: 'Y', color: 'sky' }];

test('isAi is true for claude and agents only', () => {
  expect(isAi('user')).toBe(false);
  expect(isAi('claude')).toBe(true);
  expect(isAi('agent:x/y=qa')).toBe(true);
});

test('authorName', () => {
  expect(authorName(board, 'user')).toBe('You');
  expect(authorName(board, 'claude')).toBe('Claude');
  expect(authorName(board, 'agent:x/y=qa')).toBe('Y · QA');
  expect(authorName(board, 'agent:gone/m=qa')).toBe('gone/m=qa');
});

test('authorColor', () => {
  expect(authorColor(board, 'user')).toBe('var(--color-accent)');
  expect(authorColor(board, 'claude')).toBe('var(--color-claude)');
  expect(authorColor(board, 'agent:x/y=qa')).toBe('#38bdf8');
});

test("Claude's name comes from the board", () => {
  const named = emptyBoard();
  named.colab.claudeName = 'Claude · Foreman';
  expect(authorName(named, 'claude')).toBe('Claude · Foreman');
});

test('cardIds numbers repeats of the same model and role', () => {
  const a = { model: 'x/y', roleId: 'qa' };
  expect(cardIds([a, { model: 'x/y', roleId: 'creative' }, a, a])).toEqual(['agent:x/y=qa', 'agent:x/y=creative', 'agent:x/y=qa#2', 'agent:x/y=qa#3']);
});
