// History: what each op changed in the board's content, recorded as
// before/after pairs so it can be undone and redone later, plus the
// append-only log those records live in (<board>.history.jsonl).
import fs from 'node:fs';
import path from 'node:path';
import { findObject, objectLabel } from './brainstorm.mjs';

// Content is everything the three views show, plus the ruled-out memory.
// chat, version, claudeSessionId and schema are never diffed.
const CONTENT_KEYS = ['title', 'brief', 'flow', 'brainstorm', 'ruledOut'];
// Who last touched an item and when. A later touch by someone else does not
// make an older change conflict, and is never overwritten by undo.
const BOOKKEEPING = ['updatedAt', 'updatedBy'];
const PAGE_LIST_KEY = /^brainstorm\.([^.]+)\.(objects|links)$/;
const ENTRIES_KEY = /^brainstorm\.([^.]+)\.entries\.(.+)$/;

export function cloneContent(board) {
  return structuredClone(Object.fromEntries(CONTENT_KEYS.map((key) => [key, board[key]])));
}

// Every list of content items, keyed by where it lives. Each group's entries
// are a list of their own, so an edit to one entry never conflicts with
// another entry of the same group. (The title is diffed as a single value.)
export function collections(board) {
  const lists = [
    { key: 'brief.sections', items: board.brief.sections },
    { key: 'flow.nodes', items: board.flow.nodes },
    { key: 'flow.edges', items: board.flow.edges },
  ];
  for (const page of board.brainstorm.pages) {
    lists.push({ key: `brainstorm.${page.id}.objects`, items: page.objects });
    lists.push({ key: `brainstorm.${page.id}.links`, items: page.links });
    for (const o of page.objects) if (o.kind === 'group') lists.push({ key: `brainstorm.${page.id}.entries.${o.id}`, items: o.entries });
  }
  lists.push({ key: 'ruledOut', items: board.ruledOut });
  return lists;
}

function findList(board, key) {
  if (key === 'brief.sections') return board.brief?.sections;
  if (key === 'flow.nodes') return board.flow?.nodes;
  if (key === 'flow.edges') return board.flow?.edges;
  if (key === 'ruledOut') return board.ruledOut;
  const pages = board.brainstorm?.pages ?? [];
  const pageList = PAGE_LIST_KEY.exec(key);
  if (pageList) return pages.find((p) => p.id === pageList[1])?.[pageList[2]];
  const entries = ENTRIES_KEY.exec(key);
  if (entries) return pages.find((p) => p.id === entries[1])?.objects.find((o) => o.id === entries[2] && o.kind === 'group')?.entries;
  return undefined;
}

const isObjectsKey = (key) => PAGE_LIST_KEY.exec(key)?.[2] === 'objects';
const isEntriesKey = (key) => ENTRIES_KEY.test(key);

// A group compared without its entries (they are diffed on their own).
function withoutEntries(item) {
  if (item?.kind !== 'group') return item;
  const { entries, ...rest } = item;
  return rest;
}

function withoutBookkeeping(item) {
  if (!item || typeof item !== 'object') return item;
  const rest = { ...item };
  for (const field of BOOKKEEPING) delete rest[field];
  return rest;
}

// JSON.stringify with sorted keys, so key order never counts as a change.
const canonical = (value) => JSON.stringify(value, (_, v) => (
  v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v
));
const same = (a, b) => canonical(a) === canonical(b);
const sameContent = (a, b) => same(withoutBookkeeping(a), withoutBookkeeping(b));
const sameIds = (a, b) => a.length === b.length && a.every((id, i) => id === b[i]);

// Changes for one list, by phase: removals (highest index first), the new
// order of the items kept, additions (lowest index first), edits.
function diffList(key, before, after) {
  const view = isObjectsKey(key) ? withoutEntries : (item) => item;
  const beforeAt = new Map(before.map((item, i) => [item.id, i]));
  const afterIds = new Set(after.map((item) => item.id));
  const removed = before
    .map((item, index) => ({ key, id: item.id, before: structuredClone(item), after: null, index }))
    .filter((change) => !afterIds.has(change.id))
    .reverse();
  const keptBefore = before.filter((item) => afterIds.has(item.id)).map((item) => item.id);
  const keptAfter = after.filter((item) => beforeAt.has(item.id)).map((item) => item.id);
  const order = sameIds(keptBefore, keptAfter) ? [] : [{ key, order: { before: keptBefore, after: keptAfter } }];
  const added = [];
  const edited = [];
  after.forEach((item, index) => {
    if (!beforeAt.has(item.id)) {
      added.push({ key, id: item.id, before: null, after: structuredClone(item), index });
      return;
    }
    const was = view(before[beforeAt.get(item.id)]);
    const is = view(item);
    if (!same(was, is)) edited.push({ key, id: item.id, before: structuredClone(was), after: structuredClone(is), index });
  });
  return { removed, order, added, edited };
}

// All content changes from `before` to `after`. Removals everywhere come
// before additions anywhere, so an entry moved between groups leaves one list
// before it joins the other, whichever way the change is replayed.
export function diffContent(before, after) {
  const changes = [];
  if (before.title !== after.title) changes.push({ key: 'title', before: before.title, after: after.title });
  const old = new Map(collections(before).map((c) => [c.key, c.items]));
  const next = new Map(collections(after).map((c) => [c.key, c.items]));
  const phases = { removed: [], order: [], added: [], edited: [] };
  for (const key of new Set([...old.keys(), ...next.keys()])) {
    // A group that is new or gone carries its entries in its own change.
    if (isEntriesKey(key) && !(old.has(key) && next.has(key))) continue;
    const diff = diffList(key, old.get(key) ?? [], next.get(key) ?? []);
    for (const phase of Object.keys(phases)) phases[phase].push(...diff[phase]);
  }
  return [...changes, ...phases.removed, ...phases.order, ...phases.added, ...phases.edited];
}

const APPLIED = 'applied';
const SKIPPED = 'skipped';
const NOTHING = 'nothing'; // only bookkeeping, already overtaken by a later touch

function hasItem(board, key, id) {
  if (!isEntriesKey(key)) return findList(board, key)?.some((item) => item.id === id) ?? false;
  // An entry may have moved to another group since; never make a second copy.
  return board.brainstorm.pages.some((p) => p.objects.some((o) => o.kind === 'group' && o.entries.some((e) => e.id === id)));
}

function reorder(list, expected, target) {
  const wanted = new Set(expected);
  const positions = [];
  list.forEach((item, i) => { if (wanted.has(item.id)) positions.push(i); });
  if (!sameIds(positions.map((i) => list[i].id), expected)) return SKIPPED;
  const byId = new Map(positions.map((i) => [list[i].id, list[i]]));
  positions.forEach((at, k) => { list[at] = byId.get(target[k]); });
  return APPLIED;
}

function edit(list, at, change, expected, target) {
  const current = list[at];
  const pick = (from) => Object.fromEntries(BOOKKEEPING.filter((f) => f in from).map((f) => [f, from[f]]));
  if (sameContent(change.before, change.after)) {
    // A touch with no content: put the old bookkeeping back only if nobody touched it since.
    if (!BOOKKEEPING.every((f) => current[f] === expected[f])) return NOTHING;
    list[at] = { ...current, ...pick(target) };
    return APPLIED;
  }
  const objects = isObjectsKey(change.key);
  if (!sameContent(objects ? withoutEntries(current) : current, expected)) return SKIPPED;
  const next = structuredClone(target);
  for (const f of BOOKKEEPING) if (f in current && current[f] !== expected[f]) next[f] = current[f];
  if (objects && current.kind === 'group') next.entries = current.entries;
  list[at] = next;
  return APPLIED;
}

function applyOne(board, change, undo) {
  if (change.key === 'title') {
    const [expected, target] = undo ? [change.after, change.before] : [change.before, change.after];
    if (board.title !== expected) return SKIPPED;
    board.title = target;
    return APPLIED;
  }
  const list = findList(board, change.key);
  if (!list) return SKIPPED;
  if (change.order) {
    const { before, after } = change.order;
    return undo ? reorder(list, after, before) : reorder(list, before, after);
  }
  const [expected, target] = undo ? [change.after, change.before] : [change.before, change.after];
  if (expected === null) {
    if (hasItem(board, change.key, change.id)) return SKIPPED;
    list.splice(Math.min(change.index, list.length), 0, structuredClone(target));
    return APPLIED;
  }
  const at = list.findIndex((item) => item.id === change.id);
  if (at < 0) return SKIPPED;
  if (target === null) {
    if (!sameContent(list[at], expected)) return SKIPPED;
    list.splice(at, 1);
    return APPLIED;
  }
  return edit(list, at, change, expected, target);
}

// Replay changes backwards (undo) or forwards (redo). A change is applied only
// when what it would replace is still what it left behind; anything edited
// or deleted since is skipped and reported, never clobbered.
export function applyChanges(board, changes, direction) {
  if (direction !== 'undo' && direction !== 'redo') throw new Error('direction must be undo or redo');
  const undo = direction === 'undo';
  const applied = [];
  const skipped = [];
  for (const change of undo ? [...changes].reverse() : changes) {
    const outcome = applyOne(board, change, undo);
    if (outcome === APPLIED) applied.push(change);
    else if (outcome === SKIPPED) skipped.push(change);
  }
  return { applied, skipped };
}

// Ids to flash after changes are replayed.
export function changedIdsOf(changes) {
  const ids = changes.flatMap((c) => {
    if (c.order) return c.order.after;
    const group = ENTRIES_KEY.exec(c.key ?? '')?.[2];
    return [group, c.id].filter(Boolean);
  });
  return [...new Set(ids)];
}

// ---- Summaries ------------------------------------------------------------

const LABEL_MAX = 40;

function quote(label, more = false) {
  const clean = String(label ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return '“untitled”';
  const cut = clean.length > LABEL_MAX;
  return `“${cut ? clean.slice(0, LABEL_MAX - 1).trimEnd() : clean}${cut || more ? '…' : ''}”`;
}

function lookup(board, id) {
  try {
    return findObject(board, id).object;
  } catch {
    return undefined;
  }
}

function objectName(object) {
  if (!object) return quote('');
  const label = objectLabel(object);
  return quote(label, object.kind === 'note' && object.text.trim() !== label);
}

const objectPhrase = (object) => `${object?.kind ?? 'object'} ${objectName(object)}`;
const groupName = (board, id) => lookup(board, id)?.title || 'untitled group';
const entryLabel = (board, groupId, entryId) => lookup(board, groupId)?.entries?.find((e) => e.id === entryId)?.label;
const nodeTitle = (board, id) => board.flow.nodes.find((n) => n.id === id)?.title;
const sectionTitle = (board, id) => board.brief.sections.find((s) => s.id === id)?.title;
const findLink = (board, id) => board.brainstorm.pages.flatMap((p) => p.links).find((l) => l.id === id);
const linkEnds = (board, link) => `${objectName(lookup(board, link?.from))} → ${objectName(lookup(board, link?.to))}`;
const edgeEnds = (board, edge) => `${quote(nodeTitle(board, edge?.from))} → ${quote(nodeTitle(board, edge?.to))}`;

const DESCRIBE = {
  addObject: (op, r) => `added ${objectPhrase(r.object)}`,
  updateObject: (op, r) => `edited ${objectPhrase(r.object)}`,
  moveObject: (op, r) => `${op.x === undefined && op.y === undefined ? 'resized' : 'moved'} ${objectName(r.object)}`,
  deleteObject: (op, r, before) => `deleted ${objectPhrase(lookup(before, op.id))}`,
  keep: (op, r, before) => (r.entry ? `kept ${quote(r.entry.label)} in ${groupName(before, op.id)}` : `kept ${objectPhrase(r.object)}`),
  setPicturePreview: (op, r) => `updated the preview of ${objectPhrase(r.object)}`,
  addEntry: (op, r, before) => `added ${quote(r.entry.label)} to ${groupName(before, op.groupId)}`,
  updateEntry: (op, r, before) => `edited ${quote(r.entry.label)} in ${groupName(before, op.groupId)}`,
  moveEntry: (op, r, before) => `moved ${quote(r.entry.label)} to ${groupName(before, op.toGroupId)}`,
  deleteEntry: (op, r, before) => `deleted ${quote(entryLabel(before, op.groupId, op.entryId))} from ${groupName(before, op.groupId)}`,
  addLink: (op, r, before) => `linked ${objectName(lookup(before, r.link.from))} to ${objectName(lookup(before, r.link.to))}`,
  updateLink: (op, r, before) => `edited the link ${linkEnds(before, r.link)}`,
  deleteLink: (op, r, before) => `removed the link ${linkEnds(before, findLink(before, op.id))}`,
  ruleOut: (op, r) => `ruled out ${quote(r.record.text)}`,
  bringBack: (op, r, before) => `brought back ${quote(before.ruledOut.find((x) => x.id === op.id)?.text)}`,
  addNode: (op, r) => `added card ${quote(r.node.title)}`,
  updateNode: (op, r) => `${Object.keys(op).every((k) => ['type', 'id', 'x', 'y'].includes(k)) ? 'moved' : 'edited'} card ${quote(r.node.title)}`,
  deleteNode: (op, r, before) => `deleted card ${quote(nodeTitle(before, op.id))}`,
  addEdge: (op, r, before) => `connected ${quote(nodeTitle(before, op.from))} to ${quote(nodeTitle(before, op.to))}`,
  updateEdge: (op, r, before) => `edited the connection ${edgeEnds(before, r.edge)}`,
  deleteEdge: (op, r, before) => `removed the connection ${edgeEnds(before, before.flow.edges.find((e) => e.id === op.id || (e.from === op.from && e.to === op.to)))}`,
  addSection: (op, r) => `added section ${quote(r.section.title)}`,
  updateSection: (op, r) => `edited section ${quote(r.section.title)}`,
  deleteSection: (op, r, before) => `deleted section ${quote(sectionTitle(before, op.id))}`,
  moveSection: (op, r, before) => `moved section ${quote(sectionTitle(before, op.id))}`,
  tidy: () => 'tidied the flowchart',
  setTitle: (op, r) => `renamed the board ${quote(r.title)}`,
  chat: () => 'sent a message',
};

// A short past-tense phrase naming what an op did. Who did it is kept on the
// history entry, so `author` does not appear in the text. Never throws.
export function describeOp(op, result, boardBefore, author) {
  const fallback = op?.type ? `changed the board (${op.type})` : 'changed the board';
  try {
    const describe = Object.hasOwn(DESCRIBE, op?.type) ? DESCRIBE[op.type] : undefined;
    return describe ? describe(op, result ?? {}, boardBefore) : fallback;
  } catch {
    return fallback;
  }
}

// ---- The log ----------------------------------------------------------------

// Edits that arrive keystroke by keystroke; a run of them on one target is
// one undo step.
const MERGEABLE = new Set(['updateObject', 'updateEntry', 'updateSection', 'updateNode', 'updateEdge', 'updateLink', 'moveObject']);
const UNDO_KINDS = new Set(['undo', 'redo']);

export const isUndoOrRedo = (entry) => UNDO_KINDS.has(entry.kind);

const changeSlot = (c) => (c.key === 'title' ? 'title' : c.order ? `${c.key}#order` : `${c.key}#${c.id}`);

// Fold `later` into `earlier`: the first before stays, the latest after wins.
function mergeChanges(earlier, later) {
  const merged = earlier.map((c) => ({ ...c, ...(c.order && { order: { ...c.order } }) }));
  for (const change of later) {
    const prior = merged.find((c) => changeSlot(c) === changeSlot(change));
    if (!prior) merged.push(change);
    else if (change.order) prior.order.after = change.order.after;
    else { prior.after = change.after; if ('index' in change) prior.index = change.index; }
  }
  return merged;
}

export class HistoryLog {
  #file;
  #now;
  #coalesceMs;
  #entries = [];
  #undone = new Set();
  #seq = 0;
  #pending = null; // { entry, target, lastAt } for a user edit that may still grow
  #timer = null;

  constructor(file, { now = Date.now, coalesceMs = 2000 } = {}) {
    this.#file = file;
    this.#now = now;
    this.#coalesceMs = coalesceMs;
    this.#load();
  }

  #load() {
    let raw;
    try {
      raw = fs.readFileSync(this.#file, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw new Error(`cannot read history file ${this.#file}: ${error.message}`);
    }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue; // a line cut short by a crash
      }
      if (!Number.isInteger(entry?.seq)) continue;
      this.#entries.push(entry);
      this.#track(entry);
      this.#seq = Math.max(this.#seq, entry.seq);
    }
  }

  #track(entry) {
    if (entry.kind === 'undo') for (const seq of entry.targets ?? []) this.#undone.add(seq);
    if (entry.kind === 'redo') for (const seq of entry.targets ?? []) this.#undone.delete(seq);
  }

  #write(entry) {
    fs.mkdirSync(path.dirname(this.#file), { recursive: true });
    fs.appendFileSync(this.#file, `${JSON.stringify(entry)}\n`);
  }

  #schedule() {
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      try {
        this.flush();
      } catch (error) {
        console.error(`could not write history: ${error.message}`);
      }
    }, this.#coalesceMs);
    this.#timer.unref?.();
  }

  // `op` is the op object (or just its type). A user's turn defaults to u<seq>.
  record({ author, turn, op, summary, changes, kind, targets }) {
    const type = typeof op === 'string' ? op : op?.type;
    const target = typeof op === 'object' && op ? op.entryId ?? op.id : undefined;
    const at = this.#now();
    const mergeable = author === 'user' && !kind && MERGEABLE.has(type) && target !== undefined;
    const pending = this.#pending;
    if (mergeable && pending && pending.target === target && at - pending.lastAt <= this.#coalesceMs) {
      Object.assign(pending.entry, { at: new Date(at).toISOString(), op: type, summary, changes: mergeChanges(pending.entry.changes, changes) });
      pending.lastAt = at;
      this.#schedule();
      return pending.entry;
    }
    this.flush();
    const seq = ++this.#seq;
    const entry = { seq, at: new Date(at).toISOString(), author, turn: turn ?? `u${seq}`, op: type, summary, changes };
    if (kind) entry.kind = kind;
    if (targets) entry.targets = targets;
    this.#entries.push(entry);
    this.#track(entry);
    if (mergeable) {
      this.#pending = { entry, target, lastAt: at };
      this.#schedule();
    } else this.#write(entry);
    return entry;
  }

  entries() {
    return [...this.#entries];
  }

  isUndone(seq) {
    return this.#undone.has(seq);
  }

  flush() {
    clearTimeout(this.#timer);
    this.#timer = null;
    if (!this.#pending) return;
    const { entry } = this.#pending;
    this.#pending = null;
    this.#write(entry);
  }
}
