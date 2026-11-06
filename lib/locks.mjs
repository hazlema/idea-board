// The host's locks: an entry the host made a plain bullet (entry.locked) is the host's
// decision. No AI author may change, move, rule out or delete it, or delete its group, at
// any time, prune and audit included. Pure: nothing here reads or writes a file.
import { OpError } from './board.mjs';

const groups = (board) => board.brainstorm.pages.flatMap((p) => p.objects).filter((o) => o.kind === 'group');
const entryIn = (board, groupId, entryId) => groups(board).find((g) => g.id === groupId)?.entries.find((e) => e.id === entryId);
const entryAnywhere = (board, entryId) => groups(board).flatMap((g) => g.entries).find((e) => e.id === entryId);

// The entry the op would touch, or undefined (a missing target is the op's own error to report).
function target(board, op) {
  switch (op?.type) {
    case 'updateEntry':
    case 'deleteEntry': return entryIn(board, op.groupId, op.entryId);
    case 'moveEntry': return entryAnywhere(board, op.entryId);
    case 'ruleOut': return op.target?.kind === 'entry' ? entryIn(board, op.target.groupId, op.target.entryId) : undefined;
    case 'deleteObject': return groups(board).find((g) => g.id === op.id)?.entries.find((e) => e.locked === true);
    default: return undefined;
  }
}

export function lockGuard(board, op) {
  const entry = target(board, op);
  if (entry?.locked === true) throw new OpError(`"${entry.label}" is locked by the host: build on it, don't change it`);
}
