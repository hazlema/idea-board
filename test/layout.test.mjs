import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOp, emptyBoard } from '../lib/board.mjs';
import { GAP_Y, NODE_H } from '../lib/layout.mjs';

function boardWith(cards, arrows) {
  const board = emptyBoard();
  const byTitle = {};
  for (const [title, y] of cards) byTitle[title] = applyOp(board, { type: 'addNode', title, x: 0, y }, 'user').node;
  for (const [from, to] of arrows) applyOp(board, { type: 'addEdge', from: byTitle[from].id, to: byTitle[to].id }, 'user');
  return { board, card: byTitle };
}

// Arrows between consecutive columns that cross each other.
function crossings(board) {
  const at = new Map(board.flow.nodes.map((n) => [n.id, n]));
  const edges = board.flow.edges.map((e) => [at.get(e.from), at.get(e.to)]);
  let count = 0;
  for (let i = 0; i < edges.length; i += 1) {
    for (let j = i + 1; j < edges.length; j += 1) {
      const [a, b] = [edges[i], edges[j]];
      if (a[0].x !== b[0].x || a[1].x !== b[1].x) continue;
      if ((a[0].y - b[0].y) * (a[1].y - b[1].y) < 0) count += 1;
    }
  }
  return count;
}

test('tidy untangles arrows that cross', () => {
  // Children start in the wrong order for their parents, two columns deep.
  const { board } = boardWith(
    [['A', 0], ['B', 100], ['C', 200], ['X', 300], ['Y', 200], ['Z', 100], ['P', 0], ['Q', 100], ['R', 200]],
    [['A', 'X'], ['B', 'Y'], ['C', 'Z'], ['X', 'R'], ['Y', 'Q'], ['Z', 'P']],
  );
  applyOp(board, { type: 'tidy' }, 'user');
  assert.equal(crossings(board), 0);
});

test('an arrow that skips a column still pulls on the order', () => {
  // A -> B -> C and A -> C, plus D -> E: the long arrow should not cut across D -> E.
  const { board, card } = boardWith(
    [['D', 0], ['A', 100], ['E', 0], ['B', 200], ['C', 100]],
    [['A', 'B'], ['B', 'C'], ['A', 'C'], ['D', 'E']],
  );
  applyOp(board, { type: 'tidy' }, 'user');
  assert.ok(card.A.x < card.B.x && card.B.x < card.C.x, 'C sits one past its deepest parent');
  assert.equal(card.D.x, card.A.x);
  assert.equal(card.E.x, card.B.x);
  const aboveInFirst = card.A.y < card.D.y;
  assert.equal(card.B.y < card.E.y, aboveInFirst, 'the two chains keep to their own side');
});

test('a single child lines up with its parent, and a parent centres on its children', () => {
  const { board, card } = boardWith([['Root', 0], ['One', 0], ['Two', 300], ['Leaf', 0]], [['Root', 'One'], ['Root', 'Two'], ['Two', 'Leaf']]);
  applyOp(board, { type: 'tidy' }, 'user');
  assert.equal(card.Leaf.y, card.Two.y);
  assert.equal(card.Root.y, Math.round((card.One.y + card.Two.y) / 2));
});

test('rows are spaced by the measured card heights', () => {
  const { board, card } = boardWith([['Root', 0], ['Tall', 0], ['Short', 100]], [['Root', 'Tall'], ['Root', 'Short']]);
  applyOp(board, { type: 'tidy', heights: { [card.Tall.id]: 240 } }, 'user');
  const [upper, lower] = [card.Tall, card.Short].sort((a, b) => a.y - b.y);
  const upperHeight = upper === card.Tall ? 240 : NODE_H;
  assert.ok(lower.y - upper.y >= upperHeight + GAP_Y, 'the tall card does not overlap the one below');
  // Without heights every card counts as the default height.
  applyOp(board, { type: 'tidy' }, 'user');
  assert.equal(Math.abs(card.Tall.y - card.Short.y), NODE_H + GAP_Y);
});

test('tidy keeps the board where it was and rejects bad heights', () => {
  const { board, card } = boardWith([['A', 500], ['B', 700]], [['A', 'B']]);
  for (const n of board.flow.nodes) n.x += 1000;
  applyOp(board, { type: 'tidy' }, 'user');
  assert.equal(card.A.x, 1000);
  assert.equal(Math.min(card.A.y, card.B.y), 500);
  assert.throws(() => applyOp(board, { type: 'tidy', heights: { [card.A.id]: -5 } }, 'user'), /positive number/);
  assert.throws(() => applyOp(board, { type: 'tidy', heights: [1] }, 'user'), /heights must be an object/);
  applyOp(emptyBoard(), { type: 'tidy' }, 'user');
});
