// Rules for a prune pass: how big the board is, what the pass may not touch
// ("law": plain bullets, accepted cards, ruled-out things, pictures, chat) and
// who keeps the credit. Pure: nothing here reads or writes a file.
import { OpError } from './board.mjs';
import { boardView } from './mcp-tools.mjs';

export const PRUNE_THRESHOLD = 45_000;
export const PRUNE_REGROW = 10_000;

export const boardSize = (store) => JSON.stringify(boardView(store)).length;

const refuse = (message) => { throw new OpError(message); };
const isBullet = (e) => !e.ruledOut && e.check === 'none';
const lacksCheck = (e) => e?.check === undefined || e.check === 'none';
const law = (what) => `${what} is law during a prune and can't be changed or deleted`;

const objects = (board) => board.brainstorm.pages.flatMap((p) => p.objects);
const findEntry = (board, groupId, entryId) => {
  const group = objects(board).find((o) => o.id === groupId && o.kind === 'group');
  return group?.entries.find((e) => e.id === entryId);
};

function guardEntry(board, op) {
  const entry = findEntry(board, op.groupId, op.entryId);
  if (!entry) return;
  if (entry.ruledOut) refuse(`ruled-out entries are law during a prune: "${entry.label}" can't be changed or deleted`);
  if (isBullet(entry)) refuse(`plain bullets are law during a prune: "${entry.label}" can't be changed or deleted`);
  if (op.type === 'updateEntry' && op.check === 'none') refuse(`entries need a checkbox during a prune: "${entry.label}" can't become a plain bullet`);
}

function guardEdge(board, op) {
  const edge = op.id !== undefined ? board.flow.edges.find((e) => e.id === op.id) : board.flow.edges.find((e) => e.from === op.from && e.to === op.to);
  if (!edge) return;
  const accepted = (id) => board.flow.nodes.find((n) => n.id === id)?.status === 'accepted';
  if (accepted(edge.from) && accepted(edge.to)) refuse('connections between accepted cards are law during a prune and can\'t be changed or deleted');
}

const GUARDS = {
  addObject(board, op) {
    if (op.kind === 'group' && Array.isArray(op.entries) && op.entries.some(lacksCheck)) refuse('plain bullets are not allowed during a prune: give every entry a checkbox (open or done)');
  },
  deleteObject(board, op) {
    const object = objects(board).find((o) => o.id === op.id);
    if (!object) return;
    if (object.kind === 'picture') refuse(law('pictures'));
    if (object.kind === 'group') {
      const held = object.entries.find((e) => e.ruledOut || isBullet(e));
      if (held) refuse(`${held.ruledOut ? 'ruled-out entries' : 'plain bullets'} are law during a prune: group "${object.title}" holds "${held.label}" so it can't be deleted`);
    }
  },
  addEntry(board, op) {
    if (op.check !== 'open' && op.check !== 'done') refuse('plain bullets are not allowed during a prune: give the entry a checkbox (open or done)');
  },
  updateEntry: guardEntry,
  deleteEntry: guardEntry,
  addNode(board, op) {
    if (op.status === 'accepted') refuse('accepting a card is the user\'s call; a prune can\'t accept cards');
  },
  updateNode(board, op) {
    const node = board.flow.nodes.find((n) => n.id === op.id);
    if (!node) return;
    if (op.status === 'accepted' && node.status !== 'accepted') refuse('accepting a card is the user\'s call; a prune can\'t accept cards');
    if (node.status === 'accepted' && Object.keys(op).some((k) => !['type', 'id', 'x', 'y'].includes(k))) refuse(`accepted cards are law during a prune: "${node.title}" can only be moved`);
  },
  deleteNode(board, op) {
    const node = board.flow.nodes.find((n) => n.id === op.id);
    if (node?.status === 'accepted') refuse(`accepted cards are law during a prune: "${node.title}" can't be deleted`);
  },
  updateEdge: guardEdge,
  deleteEdge: guardEdge,
};

// Op types that need no check of their own. Anything not named here or in GUARDS is refused.
const FREE = new Set([
  'updateObject', 'moveObject', 'moveEntry', 'addLink', 'updateLink', 'deleteLink',
  'addEdge', 'addSection', 'updateSection', 'deleteSection', 'moveSection', 'tidy', 'ruleOut',
]);

export function pruneGuard(board, op) {
  const guard = Object.hasOwn(GUARDS, op?.type) ? GUARDS[op.type] : null;
  if (guard) return void guard(board, op);
  if (!FREE.has(op?.type)) refuse(`${op?.type} isn't allowed during a prune`);
}

const CREDIT = ['author', 'updatedBy'];

function restore(now, was) {
  if (!was) {
    if ('claudeAdded' in now) now.claudeAdded = false;
    return;
  }
  for (const key of CREDIT) if (key in was) now[key] = was[key];
}

// `before` is a structuredClone of the board from before the op; `board` is
// changed in place so a pass leaves authorship alone and marks nothing as new.
export function keepCredit(before, board) {
  const byId = (lists) => new Map(lists.flat().map((x) => [x.id, x]));
  const old = byId([before.brief.sections, before.flow.nodes, objects(before), objects(before).flatMap((o) => o.entries ?? [])]);
  for (const section of board.brief.sections) restore(section, old.get(section.id));
  for (const node of board.flow.nodes) restore(node, old.get(node.id));
  for (const object of objects(board)) {
    restore(object, old.get(object.id));
    for (const entry of object.entries ?? []) restore(entry, old.get(entry.id));
  }
}
