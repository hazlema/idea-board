// Rules for a prune pass: how big the board is, what the pass may not touch
// ("law": struck entries, accepted cards, ruled-out things, pictures, chat) and
// who keeps the credit. Pure: nothing here reads or writes a file.
import { OpError } from './board.mjs';
import { boardView } from './mcp-tools.mjs';

export const PRUNE_THRESHOLD = 45_000;
export const PRUNE_REGROW = 10_000;

export const boardSize = (store) => JSON.stringify(boardView(store)).length;

const refuse = (message) => { throw new OpError(message); };
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
}

// Every edge the op would touch: deleteEdge matches by id or by from/to, updateEdge by id.
function guardEdge(board, op) {
  const matches = board.flow.edges.filter((e) => e.id === op.id || (op.type === 'deleteEdge' && e.from === op.from && e.to === op.to));
  if (matches.some((e) => bothAccepted(board, e.from, e.to))) refuse('connections between accepted cards are law during a prune and can\'t be changed or deleted');
}

const bothAccepted = (board, from, to) => {
  const accepted = (id) => board.flow.nodes.find((n) => n.id === id)?.status === 'accepted';
  return accepted(from) && accepted(to);
};

const GUARDS = {
  deleteObject(board, op) {
    const object = objects(board).find((o) => o.id === op.id);
    if (!object) return;
    if (object.kind === 'picture') refuse(law('pictures'));
    if (object.kind === 'group') {
      const held = object.entries.find((e) => e.ruledOut);
      if (held) refuse(`ruled-out entries are law during a prune: group "${object.title}" holds "${held.label}" so it can't be deleted`);
    }
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
  addEdge(board, op) {
    if (bothAccepted(board, op.from, op.to)) refuse('connections between accepted cards are law during a prune: no new arrow between two accepted cards');
  },
  updateEdge: guardEdge,
  deleteEdge: guardEdge,
  moveEntry(board, op) {
    const entry = objects(board).flatMap((o) => (o.kind === 'group' ? o.entries : [])).find((e) => e.id === op.entryId);
    if (entry?.ruledOut) refuse(`ruled-out entries are law during a prune: "${entry.label}" stays where it is`);
  },
};

// Op types that need no check of their own. Anything not named here or in GUARDS is refused.
const FREE = new Set([
  'addObject', 'addEntry', 'updateObject', 'moveObject', 'addLink', 'updateLink', 'deleteLink',
  'addSection', 'updateSection', 'deleteSection', 'moveSection', 'tidy',
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

export const PRUNE_SYSTEM_PROMPT = `You are pruning a shared idea board that has grown too big for its collaborators to read. Make it smaller, and keep it focused on the game's best ideas. The whole board is in the prompt, with this pass's settings; change it with the board tools.

First, the mechanics. A mechanic is a distinct system or rule of play (a group, or a cluster of entries, Brief text and cards about one thing). Judge which are most interesting: what the Brief and ticked entries lean on, and what fits the game's core. If there is a mechanics limit, keep at most that many of the established ones; new ones (listed as new since the last pass) don't count toward it and must not be cut yet. Cut each mechanic you drop completely: its groups, entries, notes, Brief text and idea cards. To cut a mechanic that is a whole group, use rule_out with kind "object" and the group's id (it removes the group, and Bring back can restore it). Otherwise record the mechanic once with rule_out kind "idea" (text = the mechanic, reason "cut by prune: …" saying what you kept instead), then delete its pieces (entries, notes, Brief text, idea cards) with the delete tools. Never use rule_out on single entries or cards to cut them: that leaves them on the board.

Then, in this order:
1. Delete exact duplicates.
2. Merge restatements into one place. The settled version wins: usually the Brief, or a ticked entry. Merge into the item that already exists rather than adding a new one, so whoever started the idea keeps the credit.
3. Delete working copies whose content now lives somewhere settled, and flowchart cards still marked "idea" that are covered elsewhere or went nowhere.
4. Notes: for each one, decide whether it is still needed. If not, delete it; if so, shorten it hard.
5. Shorten labels, entry text and Brief sections where the meaning, the numbers and the reasons survive.

How hard to cut depends on the aggressiveness:
- gentle: only steps 1, 2 and 5, plus notes and cards that are plainly dead ends. Don't cut mechanics unless the limit requires it.
- normal: everything above. Cut the weakest mechanics and stale working copies.
- aggressive: keep only what the Brief and the kept mechanics need. Cut anything not pulling its weight and tighten every text you keep.

Items new since the last pass may be merged or shortened, never cut.

Law (the server refuses these, so don't try): struck-through (ruled-out) entries and any group holding one, the ruled-out list (you may add to it), accepted flowchart cards and arrows between two accepted cards, pictures (you may shorten a caption) and the chat.

When you are done, reply with a short summary for the chat. Start with "Kept: …" (the mechanics kept) and "Cut: …" (the mechanics cut), then what you merged and shortened, in a few lines.`;

const AGGRESSIVENESS = ['gentle', 'normal', 'aggressive'];

// Stored values aren't validated on load, so fall back to the defaults.
function pruneSettings(store) {
  const lineup = store.board.colab?.lineup ?? {};
  const limit = lineup.pruneLimit;
  return {
    limit: limit === null ? null : (Number.isInteger(limit) && limit >= 1 && limit <= 50 ? limit : 5),
    aggressiveness: AGGRESSIVENESS.includes(lineup.pruneAggressiveness) ? lineup.pruneAggressiveness : 'normal',
  };
}

// Everything made after the last pass: objects, their entries, Brief sections and flow nodes.
function newSinceLastPrune(board, since) {
  const found = [];
  const shown = (x) => {
    const one = String(x.title ?? x.label ?? x.text ?? '').replace(/\s+/g, ' ').trim();
    return one.length > 60 ? `${one.slice(0, 60)}…` : one;
  };
  const add = (kind, x) => { if (typeof x.createdAt === 'string' && x.createdAt > since) found.push(`${kind} ${x.id} “${shown(x)}”`); };
  for (const o of objects(board)) {
    if (o.kind === 'picture') continue;
    add(o.kind, o);
    for (const e of o.entries ?? []) if (!e.ruledOut) add('entry', e);
  }
  for (const s of board.brief.sections) add('section', s);
  for (const n of board.flow.nodes) add('node', n);
  return found;
}

export function prunePrompt(store, guidance = '') {
  const { limit, aggressiveness } = pruneSettings(store);
  const since = store.board.colab?.lastPruneAt;
  const found = since ? newSinceLastPrune(store.board, since) : [];
  let fresh = `New since the last pass: ${since ? 'none' : 'none (this is the first pass)'}`;
  if (found.length) fresh = `New since the last pass (don't cut these): ${found.join(', ')}`;
  const settings = `Settings for this pass:\n- Mechanics limit: ${limit ?? 'none'}\n- Aggressiveness: ${aggressiveness}\n\n${fresh}`;
  const note = guidance.trim() ? `\n\nGuidance from the user for this pass: ${guidance.trim()}` : '';
  return `Here is the whole board:\n\n${JSON.stringify(boardView(store, { fullNotes: true }))}\n\n${settings}${note}\n\nPrune it now.`;
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

  // The version, the guard and the prompt wait until the agent holds its lock (onStart),
  // so a chat answer in flight finishes unguarded and before the version is taken. A pass
  // stopped before then did nothing and posts nothing; a failure to save the version rejects.
  async run({ guidance = '', timeoutMs, signal } = {}) {
    const { store } = this;
    let before = boardSize(store);
    let started = false;
    // `token` names this pass: only tool calls that carry it are the pass's.
    const onStart = (token) => {
      store.saveVersion(versionName(), 'claude', { auto: true });
      before = boardSize(store);
      store.beginPrune(token);
      store.setLastPruneAt(new Date().toISOString());
      started = true;
    };
    let result;
    try {
      result = await this.agent.prune(() => prunePrompt(store, guidance), { systemPrompt: PRUNE_SYSTEM_PROMPT, timeoutMs, signal, onStart });
    } catch (err) {
      if (!started) throw err;
      result = { ok: false, error: err?.message ?? String(err) };
    } finally {
      store.endPrune();
    }
    const after = boardSize(store);
    if (!started) return { ok: false, started: false, before, after };
    const text = result?.ok
      ? (String(result.text ?? '').trim() || 'Pruned the board.')
      : `Pruning was cut short (${result?.error || 'unknown error'}). What it changed is kept; undo it from History.`;
    store.apply({ type: 'chat', text: `${text}\n\nBoard size: ${before.toLocaleString('en-US')} → ${after.toLocaleString('en-US')} characters.`, answers: [] }, 'claude');
    return { ok: Boolean(result?.ok), started: true, before, after };
  }
}
