// Every file that belongs to a board sits beside it, named from the board path
// without its .json extension.
import path from 'node:path';

export function boardPaths(file) {
  const board = path.resolve(file);
  const base = board.replace(/\.json$/i, '');
  return {
    board,
    base,
    assets: `${base}.assets`,
    versions: `${base}.versions`,
    history: `${base}.history.jsonl`,
    design: `${base}.design.md`,
  };
}
