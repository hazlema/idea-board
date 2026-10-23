// Brainstorm canvas: groups (with entries), notes, pictures and topics, plus
// the links between them. Every op returns `changed`, the ids it touched, so
// the browser can flash them.
import { OpError, now, shortId, text, number } from './board.mjs';

export const KINDS = ['group', 'note', 'picture', 'topic'];
export const COLORS = ['slate', 'violet', 'green', 'amber', 'rose', 'sky'];
export const CHECKS = ['none', 'open', 'done'];
// w/h of 0 mean "size to content"; a positive h is a minimum height.
export const DEFAULT_SIZE = { group: { w: 320, h: 0 }, note: { w: 220, h: 140 }, picture: { w: 240, h: 0 }, topic: { w: 0, h: 0 } };

const MAIN_PAGE = 'p_main';
const GAP = 60;
const STEP = 40;
const AUTO_SIZE = 160; // stand-in for content-sized (0) widths and heights when checking overlap
// Pictures are files beside the board; the board only stores their names.
const ASSET_NAME = /^[0-9a-f]{32}\.(png|jpg|gif|webp)$/;

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

const rectOf = (o) => ({ x: o.x, y: o.y, w: o.w || AUTO_SIZE, h: o.h || AUTO_SIZE });
const intersects = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

// Pick a free spot: right of `near` (or of everything), then step down until
// the new rectangle overlaps nothing.
export function placeObject(page, { near, w, h }) {
  const anchor = near && page.objects.find((o) => o.id === near);
  if (!anchor && !page.objects.length) return { x: 0, y: 0 };
  const rects = page.objects.map(rectOf);
  const x = anchor
    ? anchor.x + rectOf(anchor).w + GAP
    : Math.max(...rects.map((r) => r.x + r.w)) + GAP;
  let y = anchor ? anchor.y : Math.min(...rects.map((r) => r.y));
  const size = { w: w || AUTO_SIZE, h: h || AUTO_SIZE };
  while (rects.some((r) => intersects({ x, y, ...size }, r))) y += STEP;
  return { x, y };
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

function makeEntry(op, author, claudeAdded) {
  if (!op || typeof op !== 'object') throw new OpError('entry must be an object');
  return {
    id: shortId('en'),
    label: text(op.label, 'label', { required: true, max: 200 }),
    text: text(op.text, 'text') ?? '',
    check: oneOf(op.check, CHECKS, 'check') ?? 'none',
    ruledOut: false,
    author,
    claudeAdded,
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
    claudeAdded: author === 'claude',
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
  const at = x === undefined || y === undefined ? placeObject(page, { near: op.near, ...base }) : { x, y };
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
  const entry = makeEntry(op, author, author === 'claude');
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
  touch(group, author);
  return { entry, changed: [group.id, entry.id] };
}

function moveEntry(board, op, author) {
  const target = findGroup(board, op.toGroupId);
  const index = number(op.index, 'index'); // validate before anything is removed
  const source = board.brainstorm.pages
    .flatMap((p) => p.objects)
    .find((o) => o.kind === 'group' && o.entries.some((e) => e.id === op.entryId));
  if (!source) throw new OpError(`no entry with id ${op.entryId}`);
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
