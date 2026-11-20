// Brainstorm canvas: groups (with entries), notes, pictures and topics, plus
// the links between them. Every op returns `changed`, the ids it touched, so
// the browser can flash them.
import { isAi } from './authors.mjs';
import { OpError, now, shortId, text, number } from './board.mjs';

export const KINDS = ['group', 'note', 'picture', 'topic'];
export const COLORS = ['slate', 'violet', 'green', 'amber', 'rose', 'sky'];
export const CHECKS = ['none', 'open', 'done'];
// w/h of 0 mean "size to content"; a positive h is a minimum height.
export const DEFAULT_SIZE = { group: { w: 640, h: 0 }, note: { w: 440, h: 140 }, picture: { w: 240, h: 0 }, topic: { w: 0, h: 0 } };

const MAIN_PAGE = 'p_main';
const GAP = 60; // between a new object and the one it is placed beside
const CLEAR = 40; // the least space kept around a placed object
const STEP = 40;
const RINGS = 60;
// Pictures are files beside the board; the board only stores their names.
export const ASSET_NAME = /^[0-9a-f]{32}\.(png|jpg|gif|webp)$/;

function findPage(board, id = MAIN_PAGE) {
  const page = board.brainstorm.pages.find((p) => p.id === id);
  if (!page) throw new OpError(`no brainstorm page with id ${id}`);
  return page;
}

export function findObject(board, id) {
  for (const page of board.brainstorm.pages) {
    const object = page.objects.find((o) => o.id === id);
    if (object) return { page, object };
  }
  throw new OpError(`no brainstorm object with id ${id}`);
}

function findGroup(board, id) {
  const found = findObject(board, id);
  if (found.object.kind !== 'group') throw new OpError(`${id} is not a group`);
  return found.object;
}

// Entry ids are unique across the board, so an entry can be found without its group.
export function findGroupOfEntry(board, entryId) {
  const group = board.brainstorm.pages
    .flatMap((p) => p.objects)
    .find((o) => o.kind === 'group' && o.entries.some((e) => e.id === entryId));
  if (!group) throw new OpError(`no entry with id ${entryId}`);
  return group;
}

function findEntry(group, entryId) {
  const entry = group.entries.find((e) => e.id === entryId);
  if (!entry) throw new OpError(`no entry with id ${entryId} in group ${group.id}`);
  return entry;
}

function findLink(board, id) {
  for (const page of board.brainstorm.pages) {
    const link = page.links.find((l) => l.id === id);
    if (link) return { page, link };
  }
  throw new OpError(`no link with id ${id}`);
}

export function objectLabel(object) {
  switch (object.kind) {
    case 'group': return object.title;
    case 'note': return (object.text.split('\n').find((line) => line.trim()) ?? '').trim().slice(0, 60);
    case 'picture': return object.caption || 'picture';
    default: return object.text;
  }
}

// How many lines `text` wraps to in a box `width` px wide, at about `perChar` px a character.
const wrapped = (text, width, perChar) => text.split('\n').reduce((n, line) => n + Math.max(1, Math.ceil((line.length * perChar) / Math.max(width, 40))), 0);

// The space an object takes on the canvas. Sizes of 0 grow with the content
// in the browser, so they are estimated here from the text they hold.
function rectOf(o) {
  const w = o.w || (o.kind === 'topic' ? o.text.length * 8 + 40 : 160);
  let h = o.h;
  if (o.kind === 'group') {
    const live = o.entries.filter((e) => !e.ruledOut);
    const items = live.reduce((sum, e) => sum + wrapped(e.label, w - 60, 7.5) * 20 + 7, 0);
    const estimate = wrapped(o.title, w - 70, 9) * 21 + 20 + (live.length ? 10 : 0) + items + 32 + (live.length < o.entries.length ? 30 : 0);
    h = Math.max(h, estimate);
  } else if (o.kind === 'note') {
    h = Math.max(h, wrapped(o.text, w - 24, 7.5) * 20 + 24);
  } else if (o.kind === 'picture') {
    h ||= Math.round(w * 0.75) + (o.caption ? 30 : 0);
  } else {
    h ||= 48;
  }
  return { x: o.x, y: o.y, w, h };
}

// Grid offsets around a wanted spot, nearest first (built on first use).
let offsets = null;
function offsetsByDistance() {
  if (offsets) return offsets;
  offsets = [];
  for (let i = -RINGS; i <= RINGS; i += 1) for (let j = -RINGS; j <= RINGS; j += 1) offsets.push({ x: i * STEP, y: j * STEP });
  return offsets.sort((a, b) => Math.hypot(a.x, a.y) - Math.hypot(b.x, b.y));
}

// The nearest spot to `want` where a box of `size` keeps clear of everything on the page.
export function freeSpot(page, want, size, { except } = {}) {
  const rects = page.objects.filter((o) => o.id !== except).map(rectOf);
  const blocked = (x, y) => rects.some((r) => x - CLEAR < r.x + r.w && r.x - CLEAR < x + size.w && y - CLEAR < r.y + r.h && r.y - CLEAR < y + size.h);
  for (const offset of offsetsByDistance()) {
    const x = want.x + offset.x;
    const y = want.y + offset.y;
    if (!blocked(x, y)) return { x, y };
  }
  return want;
}

// Pick a free spot beside `near`, or beside the last thing added, as close to
// there as the canvas allows.
export function placeObject(page, { near, w, h, kind = 'note', ...content }) {
  const anchor = (near && page.objects.find((o) => o.id === near)) || page.objects.at(-1);
  if (!anchor) return { x: 0, y: 0 };
  const box = rectOf(anchor);
  const size = rectOf({ kind, text: '', title: '', entries: [], ...content, x: 0, y: 0, w, h });
  return freeSpot(page, { x: box.x + box.w + GAP, y: box.y }, size);
}

function oneOf(value, allowed, field) {
  if (value === undefined) return undefined;
  if (!allowed.includes(value)) throw new OpError(`${field} must be one of ${allowed.join(', ')}`);
  return value;
}

function dimension(value, field) {
  const n = number(value, field);
  if (n !== undefined && n < 0) throw new OpError(`${field} must not be negative`);
  return n;
}

function flag(value, field) {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new OpError(`${field} must be true or false`);
  return value;
}

function assetName(value, field) {
  const name = text(value, field, { required: true, max: 100 });
  if (!ASSET_NAME.test(name)) throw new OpError(`${field} must be an asset file name (32 hex characters and .png, .jpg, .gif or .webp)`);
  return name;
}

// An entry the host makes a plain bullet (added without a checkbox, or its checkbox removed)
// is locked: no AI author may change it (lib/locks.mjs). AI authors never set or clear it.
function makeEntry(op, author, claudeAdded) {
  if (!op || typeof op !== 'object') throw new OpError('entry must be an object');
  const check = oneOf(op.check, CHECKS, 'check') ?? 'none';
  return {
    id: shortId('en'),
    label: text(op.label, 'label', { required: true, max: 200 }),
    text: text(op.text, 'text') ?? '',
    check,
    locked: !isAi(author) && check === 'none',
    ruledOut: false,
    author,
    claudeAdded,
    createdAt: now(),
  };
}

function touch(object, author) {
  object.updatedAt = now();
  object.updatedBy = author;
}

function insertAt(list, item, index) {
  const at = index === undefined ? list.length : Math.min(list.length, Math.max(0, index));
  list.splice(at, 0, item);
}

// The one place an object's fields are assembled, shared by addObject and by
// memory's Bring back when it has to recreate a group.
export function buildObject({ kind, at, base, body, author }) {
  return {
    id: shortId('o'),
    kind,
    ...at,
    ...base,
    author,
    claudeAdded: isAi(author),
    createdAt: now(),
    updatedAt: now(),
    updatedBy: author,
    ...body,
  };
}

function addObject(board, op, author) {
  const kind = oneOf(op.kind, KINDS, 'kind');
  if (!kind) throw new OpError('kind is required');
  const page = findPage(board, op.page);
  if (op.near !== undefined && !page.objects.some((o) => o.id === op.near)) throw new OpError(`no brainstorm object with id ${op.near}`);
  const base = {
    w: dimension(op.w, 'w') ?? DEFAULT_SIZE[kind].w,
    h: dimension(op.h, 'h') ?? DEFAULT_SIZE[kind].h,
  };
  const body = {};
  if (kind === 'group') {
    body.title = text(op.title, 'title', { max: 200 }) ?? '';
    body.color = oneOf(op.color, COLORS, 'color') ?? 'slate';
    if (op.entries !== undefined && !Array.isArray(op.entries)) throw new OpError('entries must be a list');
    // Entries seeded inside a new group are part of that group, not separate Claude additions.
    body.entries = (op.entries ?? []).map((e) => makeEntry(e, author, false));
  } else if (kind === 'note') {
    body.text = text(op.text, 'text') ?? '';
    body.color = oneOf(op.color, COLORS, 'color') ?? 'slate';
  } else if (kind === 'picture') {
    body.asset = assetName(op.asset, 'asset');
    body.preview = op.preview === undefined || op.preview === null ? null : assetName(op.preview, 'preview');
    body.caption = text(op.caption, 'caption', { max: 500 }) ?? '';
  } else {
    body.text = text(op.text, 'text') ?? '';
  }
  const x = number(op.x, 'x');
  const y = number(op.y, 'y');
  let at;
  if (x === undefined || y === undefined) at = placeObject(page, { near: op.near, kind, ...base, ...body });
  // An agent's own spot is moved off anything already there; the host's is kept as given.
  else at = isAi(author) ? freeSpot(page, { x, y }, rectOf({ kind, ...base, ...body, x, y })) : { x, y };
  const object = buildObject({ kind, at, base, body, author });
  page.objects.push(object);
  return { object, changed: [object.id] };
}

function updateObject(board, op, author) {
  const { object } = findObject(board, op.id);
  const fields = {
    title: text(op.title, 'title', { max: 200 }),
    text: text(op.text, 'text'),
    caption: text(op.caption, 'caption', { max: 500 }),
    color: oneOf(op.color, COLORS, 'color'),
  };
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (!(key in object)) throw new OpError(`a ${object.kind} has no ${key}`);
    object[key] = value;
  }
  touch(object, author);
  return { object, changed: [object.id] };
}

// Moving or resizing is not an edit: updatedAt and updatedBy stay as they were.
function moveObject(board, op) {
  const { object } = findObject(board, op.id);
  const fields = { x: number(op.x, 'x'), y: number(op.y, 'y'), w: dimension(op.w, 'w'), h: dimension(op.h, 'h') };
  for (const [key, value] of Object.entries(fields)) if (value !== undefined) object[key] = value;
  return { object, changed: [object.id] };
}

function deleteObject(board, op) {
  const { page, object } = findObject(board, op.id);
  const gone = page.links.filter((l) => l.from === object.id || l.to === object.id).map((l) => l.id);
  page.objects = page.objects.filter((o) => o !== object);
  page.links = page.links.filter((l) => !gone.includes(l.id));
  return { deleted: object.id, changed: [object.id, ...gone] };
}

function keep(board, op) {
  const { object } = findObject(board, op.id);
  if (op.entryId === undefined) {
    object.claudeAdded = false;
    return { object, changed: [object.id] };
  }
  if (object.kind !== 'group') throw new OpError(`${object.id} is not a group`);
  const entry = findEntry(object, op.entryId);
  entry.claudeAdded = false;
  return { entry, changed: [entry.id] };
}

function setPicturePreview(board, op) {
  const { object } = findObject(board, op.id);
  if (object.kind !== 'picture') throw new OpError(`${object.id} is not a picture`);
  if (op.preview === undefined) throw new OpError('preview is required');
  object.preview = op.preview === null ? null : assetName(op.preview, 'preview');
  return { object, changed: [object.id] };
}

function addEntry(board, op, author) {
  const group = findGroup(board, op.groupId);
  const entry = makeEntry(op, author, isAi(author));
  insertAt(group.entries, entry, number(op.index, 'index'));
  touch(group, author);
  return { entry, changed: [group.id, entry.id] };
}

function updateEntry(board, op, author) {
  const group = findGroup(board, op.groupId);
  const entry = findEntry(group, op.entryId);
  const fields = {
    label: text(op.label, 'label', { required: op.label !== undefined, max: 200 }),
    text: text(op.text, 'text'),
    check: oneOf(op.check, CHECKS, 'check'),
  };
  for (const [key, value] of Object.entries(fields)) if (value !== undefined) entry[key] = value;
  if (fields.check !== undefined && !isAi(author)) entry.locked = fields.check === 'none';
  touch(group, author);
  return { entry, changed: [group.id, entry.id] };
}

function moveEntry(board, op, author) {
  const target = findGroup(board, op.toGroupId);
  const index = number(op.index, 'index'); // validate before anything is removed
  const source = findGroupOfEntry(board, op.entryId);
  const entry = findEntry(source, op.entryId);
  source.entries = source.entries.filter((e) => e !== entry);
  insertAt(target.entries, entry, index);
  touch(source, author);
  touch(target, author);
  return { entry, changed: [...new Set([source.id, target.id])].concat(entry.id) };
}

function deleteEntry(board, op, author) {
  const group = findGroup(board, op.groupId);
  const entry = findEntry(group, op.entryId);
  group.entries = group.entries.filter((e) => e !== entry);
  touch(group, author);
  return { deleted: entry.id, changed: [group.id, entry.id] };
}

function addLink(board, op, author) {
  const { page, object: from } = findObject(board, op.from);
  const { page: toPage, object: to } = findObject(board, op.to);
  if (from === to) throw new OpError('an object cannot link to itself');
  if (page !== toPage) throw new OpError('objects on different pages cannot be linked');
  const existing = page.links.find((l) => l.from === from.id && l.to === to.id);
  if (existing) return { link: existing, changed: [existing.id] };
  const link = {
    id: shortId('l'),
    from: from.id,
    to: to.id,
    label: text(op.label, 'label', { max: 200 }) ?? '',
    dashed: flag(op.dashed, 'dashed') ?? false,
    author,
  };
  page.links.push(link);
  return { link, changed: [link.id] };
}

function updateLink(board, op) {
  const { link } = findLink(board, op.id);
  const label = text(op.label, 'label', { max: 200 });
  const dashed = flag(op.dashed, 'dashed');
  if (label !== undefined) link.label = label;
  if (dashed !== undefined) link.dashed = dashed;
  return { link, changed: [link.id] };
}

function deleteLink(board, op) {
  const { page, link } = findLink(board, op.id);
  page.links = page.links.filter((l) => l !== link);
  return { deleted: link.id, changed: [link.id] };
}

const OPS = {
  addObject, updateObject, moveObject, deleteObject, keep, setPicturePreview,
  addEntry, updateEntry, moveEntry, deleteEntry,
  addLink, updateLink, deleteLink,
};

// Returns undefined for op types that are not brainstorm ops, so applyOp can
// report them as unknown.
export function brainstormOp(board, op, author) {
  const handler = Object.hasOwn(OPS, op?.type) ? OPS[op.type] : undefined;
  return handler ? handler(board, op, author) : undefined;
}
