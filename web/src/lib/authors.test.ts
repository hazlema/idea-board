import { expect, test } from 'vitest';
import { authorColor, authorName, isAi } from './authors';
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
