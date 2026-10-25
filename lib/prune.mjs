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
  ruleOut(board, op) {
    const target = op.target ?? {};
    if (target.kind === 'entry') guardEntry(board, { type: 'ruleOut', groupId: target.groupId, entryId: target.entryId });
    else if (target.kind === 'object') GUARDS.deleteObject(board, { id: target.id });
    else if (target.kind === 'node') {
      const node = board.flow.nodes.find((n) => n.id === target.id);
      if (node?.status === 'accepted') refuse(`accepted cards are law during a prune: "${node.title}" can't be ruled out`);
      if (node?.status === 'rejected') refuse(`ruled-out cards are law during a prune: "${node.title}" can't be changed`);
    }
  },
  updateEdge: guardEdge,
  deleteEdge: guardEdge,
};

// Op types that need no check of their own. Anything not named here or in GUARDS is refused.
const FREE = new Set([
  'updateObject', 'moveObject', 'moveEntry', 'addLink', 'updateLink', 'deleteLink',
  'addEdge', 'addSection', 'updateSection', 'deleteSection', 'moveSection', 'tidy',
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

export const PRUNE_SYSTEM_PROMPT = `You are pruning a shared idea board that has grown too big for its collaborators to read. Make it smaller without losing a single decision. The whole board is in the prompt; change it with the board tools.

In this order:
1. Delete exact duplicates.
2. Merge restatements into one place. The settled version wins: usually the Brief, or a ticked entry. Merge into the item that already exists rather than adding a new one, so whoever started the idea keeps the credit.
3. Delete working copies whose content now lives somewhere settled, and flowchart cards still marked "idea" that are covered elsewhere or went nowhere.
4. Shorten labels, entry text, notes and Brief sections only where the meaning, the numbers and the reasons all survive. If something can't be shorter without losing context, leave it.

Law (the server refuses these, so don't try):
- Entries without a checkbox are plain bullets: never change or delete them. You may move them to another group. If something contradicts a plain bullet, the bullet is right; cut the other thing.
- Never add an entry without a checkbox, or take the checkbox off one.
- Struck-through (ruled-out) entries, the ruled-out list, accepted flowchart cards (and arrows between two accepted cards), pictures and the chat stay as they are. You may shorten a picture's caption, and add to the ruled-out list with rule_out.

When you are done, reply with a short summary for the chat: what you merged, what you cut and what you shortened, in a few lines.`;

export function prunePrompt(store, guidance = '') {
  const note = guidance.trim() ? `\n\nGuidance from the user for this pass: ${guidance.trim()}` : '';
  return `Here is the whole board:\n\n${JSON.stringify(boardView(store, { fullNotes: true }))}${note}\n\nPrune it now.`;
}

// Local time, like the page's defaultVersionName.
function versionName(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `Before prune ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

export class Pruner {
  constructor({ store, agent }) {
    this.store = store;
    this.agent = agent;
  }

  available() {
    return Boolean(this.agent.found);
  }

  async run({ guidance = '', timeoutMs, signal } = {}) {
    const { store } = this;
    store.saveVersion(versionName(), 'claude', { auto: true });
    const before = boardSize(store);
    let result;
    store.beginPrune();
    try {
      result = await this.agent.prune(prunePrompt(store, guidance), { systemPrompt: PRUNE_SYSTEM_PROMPT, timeoutMs, signal });
    } catch (err) {
      result = { ok: false, error: err?.message ?? String(err) };
    } finally {
      store.endPrune();
    }
    const after = boardSize(store);
    const text = result?.ok
      ? (String(result.text ?? '').trim() || 'Pruned the board.')
      : `Pruning was cut short (${result?.error}). What it changed is kept; undo it from History.`;
    store.apply({ type: 'chat', text: `${text}\n\nBoard size: ${before.toLocaleString('en-US')} → ${after.toLocaleString('en-US')} characters.`, answers: [] }, 'claude');
    return { ok: Boolean(result?.ok), before, after };
  }
}
