// Board shape and operations. The board is one JSON file; every change goes
// through applyOp so the browser and the MCP tools share the same rules.
import { randomUUID } from 'node:crypto';
import { brainstormOp } from './brainstorm.mjs';
import { memoryOp, recordForRejectedNode } from './memory.mjs';

export const STATUSES = ['idea', 'accepted', 'rejected'];
export const AUTHORS = ['user', 'claude'];

const NODE_W = 220;
const NODE_H = 64;
const GAP_X = 80;
const GAP_Y = 40;

export const now = () => new Date().toISOString();
export const shortId = (prefix) => `${prefix}_${randomUUID().slice(0, 8)}`;

// The brief is the project's free-form description: an ordered list of text
// boxes, each with a heading. Claude reads it first so it remembers what the
// board is for.
export function defaultBrief() {
  return { sections: [{ id: shortId('s'), title: "What we're building", text: '', updatedBy: 'user', updatedAt: now() }] };
}

export function emptyBoard(title = 'Untitled board') {
  return {
    schema: 2,
    version: 0,
    title,
    brief: defaultBrief(),
    flow: { nodes: [], edges: [] },
    brainstorm: { pages: [{ id: 'p_main', name: 'Brainstorm', objects: [], links: [] }] },
    ruledOut: [],
    chat: [],
    claudeSessionId: null,
  };
}

// Bring a board read from disk up to schema 2. Schema 1 kept the flowchart at
// the top level; anything a file lacks is filled from an empty board.
export function migrateBoard(raw) {
  const { nodes, edges, ...rest } = raw;
  const board = { ...emptyBoard(), ...rest, schema: 2 };
  if (!rest.flow) board.flow = { nodes: nodes ?? [], edges: edges ?? [] };
  // Schema 1 rejected cards had no memory; give each one a ruled-out record.
  if (raw.schema !== 2) {
    const known = new Set(board.ruledOut.map((r) => r.source?.nodeId));
    for (const node of board.flow.nodes) {
      if (node.status === 'rejected' && !known.has(node.id)) board.ruledOut.push(recordForRejectedNode(node));
    }
  }
  return board;
}

export class OpError extends Error {}

export function text(value, field, { required = false, max = 20_000, keepSpace = field === 'notes' } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new OpError(`${field} is required`);
    return undefined;
  }
  if (typeof value !== 'string') throw new OpError(`${field} must be a string`);
  const trimmed = keepSpace ? value : value.trim();
  if (required && !trimmed) throw new OpError(`${field} must not be empty`);
  if (trimmed.length > max) throw new OpError(`${field} is longer than ${max} characters`);
  return trimmed;
}

export function number(value, field) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new OpError(`${field} must be a number`);
  return Math.round(value);
}

function status(value) {
  if (value === undefined) return undefined;
  if (!STATUSES.includes(value)) throw new OpError(`status must be one of ${STATUSES.join(', ')}`);
  return value;
}

// Props are an ordered list of { key, value } so the panel keeps the order the
// user typed them in.
function props(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new OpError('props must be a list of { key, value }');
  return value.map((p, i) => {
    if (!p || typeof p !== 'object') throw new OpError(`props[${i}] must be an object`);
    return { key: text(p.key ?? '', `props[${i}].key`, { max: 200 }), value: text(String(p.value ?? ''), `props[${i}].value`, { max: 2000 }) };
  });
}

// Merge-style prop edits for agents: { set: { key: value }, remove: [key] }.
function patchProps(current, set = {}, remove = []) {
  const next = current.map((p) => ({ ...p }));
  for (const [key, value] of Object.entries(set)) {
    const existing = next.find((p) => p.key === key);
    if (existing) existing.value = String(value);
    else next.push({ key, value: String(value) });
  }
  return next.filter((p) => !remove.includes(p.key));
}

function findSection(board, id) {
  const section = board.brief.sections.find((x) => x.id === id);
  if (!section) throw new OpError(`no brief section with id ${id}`);
  return section;
}

function findNode(board, id) {
  const node = board.flow.nodes.find((n) => n.id === id);
  if (!node) throw new OpError(`no node with id ${id}`);
  return node;
}

function overlaps(board, x, y) {
  return board.flow.nodes.some((n) => Math.abs(n.x - x) < NODE_W + GAP_X / 2 && Math.abs(n.y - y) < NODE_H + GAP_Y / 2);
}

// Place a new node to the right of its parent (stacking downward past
// siblings), or to the right of everything when it has no parent.
export function autoPlace(board, nearId) {
  const near = nearId && board.flow.nodes.find((n) => n.id === nearId);
  if (near) {
    const x = near.x + NODE_W + GAP_X;
    let y = near.y;
    while (overlaps(board, x, y)) y += NODE_H + GAP_Y;
    return { x, y };
  }
  if (!board.flow.nodes.length) return { x: 0, y: 0 };
  const maxX = Math.max(...board.flow.nodes.map((n) => n.x));
  const x = maxX + NODE_W + GAP_X;
  let y = Math.min(...board.flow.nodes.map((n) => n.y));
  while (overlaps(board, x, y)) y += NODE_H + GAP_Y;
  return { x, y };
}

// Arrange nodes left to right in layers by how they connect: roots on the
// left, each node one column past its deepest parent. Within a column, nodes
// sit near the average row of their parents to keep arrows short. Nodes with
// no connections go in a final column.
export function tidyLayout(board) {
  const ids = board.flow.nodes.map((n) => n.id);
  const byId = new Map(board.flow.nodes.map((n) => [n.id, n]));
  const out = new Map(ids.map((id) => [id, []]));
  for (const e of board.flow.edges) if (byId.has(e.from) && byId.has(e.to)) out.get(e.from).push(e.to);

  // Drop back edges so cycles don't push depth forever.
  const forward = [];
  const mark = new Map();
  const visit = (id) => {
    mark.set(id, 'open');
    for (const to of out.get(id)) {
      if (mark.get(to) === 'open') continue;
      forward.push([id, to]);
      if (!mark.has(to)) visit(to);
    }
    mark.set(id, 'done');
  };
  const hasIncoming = new Set(board.flow.edges.map((e) => e.to));
  const byY = [...board.flow.nodes].sort((a, b) => a.y - b.y || a.x - b.x).map((n) => n.id);
  for (const id of byY) if (!hasIncoming.has(id) && !mark.has(id)) visit(id);
  for (const id of byY) if (!mark.has(id)) visit(id);

  const depth = new Map(ids.map((id) => [id, 0]));
  for (let i = 0; i < ids.length; i += 1) {
    let changed = false;
    for (const [from, to] of forward) {
      if (depth.get(to) < depth.get(from) + 1) { depth.set(to, depth.get(from) + 1); changed = true; }
    }
    if (!changed) break;
  }

  const connected = new Set(board.flow.edges.flatMap((e) => [e.from, e.to]));
  const maxDepth = Math.max(0, ...[...connected].map((id) => depth.get(id) ?? 0));
  const layers = [];
  for (const id of byY) {
    const d = connected.has(id) ? depth.get(id) : maxDepth + 1;
    (layers[d] ??= []).push(id);
  }

  const parents = new Map(ids.map((id) => [id, []]));
  for (const [from, to] of forward) parents.get(to).push(from);
  const row = new Map();
  for (const layer of layers.filter(Boolean)) {
    const score = (id) => {
      const rows = parents.get(id).map((p) => row.get(p)).filter((r) => r !== undefined);
      return rows.length ? rows.reduce((a, b) => a + b, 0) / rows.length : Infinity;
    };
    layer.sort((a, b) => score(a) - score(b) || byY.indexOf(a) - byY.indexOf(b));
    layer.forEach((id, i) => row.set(id, i));
  }

  const left = Math.min(...board.flow.nodes.map((n) => n.x));
  const top = Math.min(...board.flow.nodes.map((n) => n.y));
  const tallest = Math.max(...layers.filter(Boolean).map((l) => l.length));
  const stepY = NODE_H + GAP_Y;
  layers.filter(Boolean).forEach((layer, column) => {
    const offset = ((tallest - layer.length) * stepY) / 2;
    layer.forEach((id, i) => {
      const node = byId.get(id);
      node.x = left + column * (NODE_W + GAP_X + 20);
      node.y = Math.round(top + offset + i * stepY);
    });
  });
}

// Apply one operation in place. Returns a small result describing what changed.
export function applyOp(board, op, author) {
  if (!AUTHORS.includes(author)) throw new OpError('unknown author');
  switch (op?.type) {
    case 'addNode': {
      const title = text(op.title, 'title', { required: true, max: 200 });
      if (status(op.status) === 'rejected') throw new OpError('use ruleOut to reject a card');
      const placed = op.x === undefined || op.y === undefined ? autoPlace(board, op.near) : null;
      const node = {
        id: shortId('n'),
        title,
        notes: text(op.notes, 'notes') ?? '',
        props: props(op.props) ?? [],
        status: status(op.status) ?? 'idea',
        author,
        x: placed ? placed.x : number(op.x, 'x'),
        y: placed ? placed.y : number(op.y, 'y'),
        createdAt: now(),
        updatedAt: now(),
        updatedBy: author,
      };
      board.flow.nodes.push(node);
      return { node };
    }
    case 'updateNode': {
      const node = findNode(board, op.id);
      const fields = {
        title: text(op.title, 'title', { required: op.title !== undefined, max: 200 }),
        notes: text(op.notes, 'notes'),
        props: props(op.props),
        status: status(op.status),
        x: number(op.x, 'x'),
        y: number(op.y, 'y'),
      };
      // Rejection is memory: it goes through ruleOut / bringBack so the reason is kept.
      if (fields.status === 'rejected') throw new OpError('use ruleOut to reject a card');
      if (fields.status !== undefined && node.status === 'rejected') throw new OpError('use bringBack to restore a rejected card');
      for (const [key, value] of Object.entries(fields)) if (value !== undefined) node[key] = value;
      if (op.setProps || op.removeProps) node.props = patchProps(node.props, op.setProps, op.removeProps);
      const moveOnly = Object.keys(op).every((k) => ['type', 'id', 'x', 'y'].includes(k));
      if (!moveOnly) {
        node.updatedAt = now();
        node.updatedBy = author;
      }
      return { node };
    }
    case 'deleteNode': {
      findNode(board, op.id);
      board.flow.nodes = board.flow.nodes.filter((n) => n.id !== op.id);
      board.flow.edges = board.flow.edges.filter((e) => e.from !== op.id && e.to !== op.id);
      return { deleted: op.id };
    }
    case 'addEdge': {
      findNode(board, op.from);
      findNode(board, op.to);
      if (op.from === op.to) throw new OpError('a node cannot connect to itself');
      const existing = board.flow.edges.find((e) => e.from === op.from && e.to === op.to);
      if (existing) return { edge: existing };
      const edge = { id: shortId('e'), from: op.from, to: op.to, label: text(op.label, 'label', { max: 200 }) ?? '', author };
      board.flow.edges.push(edge);
      return { edge };
    }
    case 'updateEdge': {
      const edge = board.flow.edges.find((e) => e.id === op.id);
      if (!edge) throw new OpError(`no edge with id ${op.id}`);
      edge.label = text(op.label, 'label', { max: 200 }) ?? '';
      return { edge };
    }
    case 'deleteEdge': {
      const before = board.flow.edges.length;
      board.flow.edges = board.flow.edges.filter((e) => e.id !== op.id && !(e.from === op.from && e.to === op.to));
      if (board.flow.edges.length === before) throw new OpError('no matching connection');
      return { deleted: op.id ?? `${op.from}->${op.to}` };
    }
    case 'addSection': {
      const section = {
        id: shortId('s'),
        title: text(op.title, 'title', { max: 200 }) ?? '',
        text: text(op.text, 'text', { max: 50_000, keepSpace: true }) ?? '',
        updatedBy: author,
        updatedAt: now(),
      };
      const after = op.after ? board.brief.sections.findIndex((x) => x.id === op.after) : -1;
      board.brief.sections.splice(after >= 0 ? after + 1 : board.brief.sections.length, 0, section);
      return { section };
    }
    case 'updateSection': {
      const section = findSection(board, op.id);
      const title = text(op.title, 'title', { max: 200 });
      const body = text(op.text, 'text', { max: 50_000, keepSpace: true });
      if (title !== undefined) section.title = title;
      if (body !== undefined) section.text = body;
      section.updatedBy = author;
      section.updatedAt = now();
      return { section };
    }
    case 'deleteSection': {
      findSection(board, op.id);
      board.brief.sections = board.brief.sections.filter((x) => x.id !== op.id);
      return { deleted: op.id };
    }
    case 'moveSection': {
      const list = board.brief.sections;
      const from = list.findIndex((x) => x.id === op.id);
      if (from < 0) throw new OpError(`no brief section with id ${op.id}`);
      const to = Math.min(list.length - 1, Math.max(0, from + (op.by === -1 ? -1 : 1)));
      list.splice(to, 0, ...list.splice(from, 1));
      return { moved: op.id };
    }
    case 'tidy': {
      if (board.flow.nodes.length) tidyLayout(board);
      return { tidied: board.flow.nodes.length };
    }
    case 'setTitle': {
      board.title = text(op.title, 'title', { required: true, max: 200 });
      return { title: board.title };
    }
    case 'chat': {
      const message = { id: shortId('m'), role: author, text: text(op.text, 'text', { required: true }), at: now(), handled: author === 'claude' };
      board.chat.push(message);
      // Claude replying answers everything the user said before it.
      if (author === 'claude') for (const m of board.chat) if (m.role === 'user') m.handled = true;
      return { message };
    }
    default: {
      const result = brainstormOp(board, op, author) ?? memoryOp(board, op, author);
      if (result !== undefined) return result;
      throw new OpError(`unknown operation ${op?.type}`);
    }
  }
}
