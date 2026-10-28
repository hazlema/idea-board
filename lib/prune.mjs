// Rules for a prune pass: how big the board is, what the pass may not touch
// ("law": struck entries, accepted cards, ruled-out things, pictures, chat) and
// who keeps the credit. Pure: nothing here reads or writes a file.
import { OpError } from './board.mjs';
import { defaults } from './defaults.mjs';
import { boardView, brainstormView, briefView, flowView } from './mcp-tools.mjs';

export const PRUNE_REGROW = 10_000;
// Each part of the board is pruned on its own once it passes this, in characters of the JSON
// its reading tool returns (about 20K tokens, under Claude Code's 25K cap on a tool's output).
export const SECTION_LIMIT = 80_000;
export const SECTIONS = ['brief', 'brainstorm', 'flow'];
export const SECTION_NAMES = { brief: 'Brief', brainstorm: 'Brainstorm', flow: 'Flowchart' };

// The Brief is measured without the ruled-out list view_brief also carries: a pass can't shrink it.
export function sectionSizes(store) {
  const b = store.board;
  return {
    brief: JSON.stringify(briefView(b)).length,
    brainstorm: JSON.stringify(brainstormView(b)).length,
    flow: JSON.stringify(flowView(b, false)).length,
  };
}

export const sectionsOver = (sizes) => SECTIONS.filter((s) => sizes[s] > SECTION_LIMIT);

const chars = (n) => n.toLocaleString('en-US');
const the = (sections) => {
  const names = sections.map((s) => `the ${SECTION_NAMES[s]}`);
  return names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
};

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

export function prunePrompt(store, guidance = '', sections = SECTIONS) {
  const { limit, aggressiveness } = pruneSettings(store);
  const since = store.board.colab?.lastPruneAt;
  const found = since ? newSinceLastPrune(store.board, since) : [];
  let fresh = `New since the last pass: ${since ? 'none' : 'none (this is the first pass)'}`;
  if (found.length) fresh = `New since the last pass (don't cut these): ${found.join(', ')}`;
  const settings = `Settings for this pass:\n- Mechanics limit: ${limit ?? 'none'}\n- Aggressiveness: ${aggressiveness}\n\n${fresh}`;
  const sizes = sectionSizes(store);
  const measured = `Section sizes (limit ${chars(SECTION_LIMIT)} characters each): ${SECTIONS.map((s) => `${SECTION_NAMES[s]} ${chars(sizes[s])}`).join(' · ')}`;
  const focus = sections.length === SECTIONS.length && !sectionsOver(sizes).length
    ? 'No section is over the limit; the host asked for this pass. Prune the whole board.'
    : `Over the limit: ${the(sections)}. Work on ${sections.length === 1 ? 'it' : 'them'}. In the other sections, change only what belongs to the ideas you cut: remove their pieces.`;
  const note = guidance.trim() ? `\n\nGuidance from the user for this pass: ${guidance.trim()}` : '';
  return `Here is the whole board:\n\n${JSON.stringify(boardView(store, { fullNotes: true }))}\n\n${settings}\n\n${measured}\n${focus}${note}\n\nPrune it now.`;
}

// Local time, like the page's defaultVersionName.
function versionName(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `Before prune ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

export class Pruner {
  // `library` (optional) supplies the editable prune text.
  constructor({ store, agent, library }) {
    this.store = store;
    this.agent = agent;
    this.library = library;
  }

  available() {
    return Boolean(this.agent.found);
  }

  // The version, the guard and the prompt wait until the agent holds its lock (onStart),
  // so a chat answer in flight finishes unguarded and before the version is taken. A pass
  // stopped before then did nothing and posts nothing; a failure to save the version rejects.
  // `sections` is what the pass works on; left out (the host's /prune), it is chosen when the
  // pass starts: the sections over the limit, or the whole board when none is.
  async run({ guidance = '', sections, timeoutMs, signal } = {}) {
    const { store } = this;
    let before = sectionSizes(store);
    let worked = sections;
    let started = false;
    // `token` names this pass: only tool calls that carry it are the pass's.
    const onStart = (token) => {
      store.saveVersion(versionName(), 'claude', { auto: true });
      before = sectionSizes(store);
      worked ??= sectionsOver(before).length ? sectionsOver(before) : SECTIONS;
      store.beginPrune(token);
      store.setLastPruneAt(new Date().toISOString());
      started = true;
    };
    const systemPrompt = this.library?.get().prompts?.prune ?? defaults().prompts.prune;
    let result;
    try {
      result = await this.agent.prune(() => prunePrompt(store, guidance, worked), { systemPrompt, timeoutMs, signal, onStart });
    } catch (err) {
      if (!started) throw err;
      result = { ok: false, error: err?.message ?? String(err) };
    } finally {
      store.endPrune();
    }
    const after = sectionSizes(store);
    if (!started) return { ok: false, started: false, sections: [], before, after };
    const text = result?.ok
      ? (String(result.text ?? '').trim() || 'Pruned the board.')
      : `Pruning was cut short (${result?.error || 'unknown error'}). What it changed is kept; undo it from History.`;
    const lines = worked.map((s) => `${SECTION_NAMES[s]}: ${chars(before[s])} → ${chars(after[s])} characters.`);
    const still = worked.filter((s) => after[s] > SECTION_LIMIT)
      .map((s) => `The ${SECTION_NAMES[s]} is still over its limit (${chars(after[s])} of ${chars(SECTION_LIMIT)} characters). Raise Aggressiveness under ⋯ → Settings → Pruning and run /prune again.`);
    store.apply({ type: 'chat', text: [text, lines.join('\n'), ...still].join('\n\n'), answers: [] }, 'claude');
    return { ok: Boolean(result?.ok), started: true, sections: worked, before, after };
  }
}
