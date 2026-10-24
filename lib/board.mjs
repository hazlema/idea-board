// Board shape and operations. The board is one JSON file; every change goes
// through applyOp so the browser and the MCP tools share the same rules.
import { randomUUID } from 'node:crypto';
import { isAi } from './authors.mjs';
import { brainstormOp } from './brainstorm.mjs';
import { memoryOp, recordForRejectedNode } from './memory.mjs';
import { GAP_X, GAP_Y, NODE_H, NODE_W, tidyLayout } from './layout.mjs';

export const STATUSES = ['idea', 'accepted', 'rejected'];
export const AUTHORS = ['user', 'claude'];
const POINTER_KINDS = ['object', 'entry', 'node', 'section'];
const MAX_POINTERS = 5;


export const now = () => new Date().toISOString();
export const shortId = (prefix) => `${prefix}_${randomUUID().slice(0, 8)}`;

// The brief is the project's free-form description: an ordered list of text
// boxes, each with a heading. Claude reads it first so it remembers what the
// board is for.
export function defaultBrief() {
  return { sections: [{ id: shortId('s'), title: "What we're building", text: '', updatedBy: 'user', updatedAt: now() }] };
}

// Minutes an agent's turn may take before it is asked to wrap up (slow models can need 20).
export const TURN_LIMIT = 30;

export function emptyColab() {
  return { roster: [], lineup: { agents: [], rounds: 5, budget: 5, turnLimit: TURN_LIMIT, claudeRoleId: 'foreman', imageModel: '' }, extras: { rules: '', roles: {} }, run: null, spent: 0, claudeName: 'Claude' };
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
    colab: emptyColab(),
  };
}

// Bring a board read from disk up to schema 2. Schema 1 kept the flowchart at
// the top level; anything a file lacks is filled from an empty board.
export function migrateBoard(raw) {
  const { nodes, edges, ...rest } = raw;
  const board = { ...emptyBoard(), ...rest, schema: 2 };
  board.colab = { ...emptyColab(), ...rest.colab };
  board.colab.lineup = { turnLimit: TURN_LIMIT, claudeRoleId: 'foreman', imageModel: '', ...board.colab.lineup };
  // Messages used to carry `handled`; now each says who still owes an answer.
  for (const m of board.chat) {
    if (m.role === 'user' && !Array.isArray(m.owed)) m.owed = m.handled ? [] : ['claude'];
    delete m.handled;
  }
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

const MAX_LINEUP = 8;

export class OpError extends Error {}
// An op that is refused because of what the server is doing right now.
export class ConflictError extends OpError {
  status = 409;
}

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

// What a chat message points at ("this" in "what about this?"). Checked in full
// before the message is stored.
function pointers(value) {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new OpError('context must be a list');
  if (value.length > MAX_POINTERS) throw new OpError(`context can point at ${MAX_POINTERS} things at most`);
  return value.map((p, i) => {
    if (!p || typeof p !== 'object') throw new OpError(`context[${i}] must be an object`);
    if (!POINTER_KINDS.includes(p.kind)) throw new OpError(`context[${i}].kind must be one of ${POINTER_KINDS.join(', ')}`);
    const pointer = { kind: p.kind, id: text(p.id, `context[${i}].id`, { required: true, max: 100 }) };
    const groupId = text(p.groupId, `context[${i}].groupId`, { max: 100 });
    if (groupId) pointer.groupId = groupId;
    pointer.label = text(p.label, `context[${i}].label`, { required: true, max: 200 });
    return pointer;
  });
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

// Card heights the browser measured, for Tidy: { [nodeId]: pixels }.
function cardHeights(value) {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new OpError('heights must be an object of card id to height');
  return Object.fromEntries(Object.entries(value).map(([id, h]) => {
    if (typeof h !== 'number' || !Number.isFinite(h) || h <= 0 || h > 5000) throw new OpError(`heights.${id} must be a positive number`);
    return [id, Math.round(h)];
  }));
}

// Apply one operation in place. Returns a small result describing what changed.
function answerIds(value) {
  if (!Array.isArray(value) || value.length > 1000 || value.some((id) => typeof id !== 'string')) {
    throw new OpError('answers must be a list of message ids');
  }
  return new Set(value);
}

const STAT_KEYS = ['seconds', 'cost', 'calls', 'promptTokens', 'cachedTokens'];

function turnStats(value) {
  const ok = value && typeof value === 'object' && STAT_KEYS.every((k) => Number.isFinite(value[k]) && value[k] >= 0);
  if (!ok) throw new OpError(`stats must have ${STAT_KEYS.join(', ')} as numbers of 0 or more`);
  return Object.fromEntries(STAT_KEYS.map((k) => [k, value[k]]));
}

// A list of connections ('claude' or roster agents) a chat message is for or owed by.
function connectionIds(board, value, name) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new OpError(`${name} must be a list of connection ids`);
  for (const id of value) {
    if (id !== 'claude' && !board.colab?.roster?.some((r) => r.id === id)) throw new OpError(`unknown connection ${id}`);
  }
  return [...new Set(value)];
}

export function applyOp(board, op, author) {
  if (!AUTHORS.includes(author) && !board.colab?.roster?.some((r) => r.id === author)) throw new OpError('unknown author');
  switch (op?.type) {
    case 'addNode': {
      const title = text(op.title, 'title', { required: true, max: 200 });
      if (status(op.status) === 'rejected') throw new OpError('use ruleOut to reject a card');
      if (op.near !== undefined && op.near !== null) findNode(board, op.near);
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
      tidyLayout(board, { heights: cardHeights(op.heights) });
      return { tidied: board.flow.nodes.length };
    }
    case 'setTitle': {
      board.title = text(op.title, 'title', { required: true, max: 200 });
      return { title: board.title };
    }
    case 'chat': {
      const message = { id: shortId('m'), role: author, text: text(op.text, 'text', { required: true }), at: now() };
      if (author === 'user') {
        message.owed = connectionIds(board, op.owed, 'owed') ?? [];
        const to = connectionIds(board, op.to, 'to');
        if (to) message.to = to;
        if (op.start === true) message.start = true;
      }
      const context = pointers(op.context);
      if (context?.length) message.context = context;
      // An agent's note says what its turn took; only an AI's message carries it.
      if (isAi(author) && op.stats !== undefined) message.stats = turnStats(op.stats);
      const answers = isAi(author) && op.answers !== undefined ? answerIds(op.answers) : null;
      board.chat.push(message);
      // An AI reply answers the user messages listed in `answers` (the
      // background agent lists the ones it was given, so a message that
      // arrived mid-run stays unanswered and gets its own run). Without
      // `answers` (the interactive reply tool) it answers everything the user
      // said before it. Only the replier's own debt is cleared.
      if (isAi(author)) {
        for (const m of board.chat) {
          if (m.role === 'user' && m.owed && (!answers || answers.has(m.id))) m.owed = m.owed.filter((id) => id !== author);
        }
      }
      return { message };
    }
    case 'setColabLineup': {
      if (!Array.isArray(op.agents) || op.agents.length > MAX_LINEUP) throw new OpError(`agents must be a list of ${MAX_LINEUP} at most`);
      const agents = op.agents.map((a, i) => {
        if (!a || typeof a !== 'object') throw new OpError(`agents[${i}] must be an object`);
        if (a.settings !== undefined && (!a.settings || typeof a.settings !== 'object' || Array.isArray(a.settings))) throw new OpError(`agents[${i}].settings must be an object`);
        // An empty model is allowed so a half-set-up card can be saved; start() refuses it.
        if (typeof a.model !== 'string' || a.model.length > 200) throw new OpError(`agents[${i}].model must be a string of 200 characters at most`);
        const agent = { model: a.model.trim(), roleId: text(a.roleId, `agents[${i}].roleId`, { required: true, max: 200 }) };
        if (a.settings) agent.settings = a.settings;
        return agent;
      });
      if (!Number.isInteger(op.rounds) || op.rounds < 1 || op.rounds > 50) throw new OpError('rounds must be a whole number from 1 to 50');
      if (typeof op.budget !== 'number' || !(op.budget >= 0.1 && op.budget <= 100)) throw new OpError('budget must be a number from 0.1 to 100');
      const turnLimit = op.turnLimit ?? TURN_LIMIT;
      if (!Number.isInteger(turnLimit) || turnLimit < 1 || turnLimit > 120) throw new OpError('turnLimit must be a whole number of minutes from 1 to 120');
      // Claude's role is optional: left out, the stored one stays.
      const claudeRoleId = op.claudeRoleId === undefined ? board.colab.lineup.claudeRoleId : text(op.claudeRoleId, 'claudeRoleId', { required: true, max: 200 });
      // Image and Claude models are optional too: left out, the stored ones stay.
      const old = board.colab.lineup;
      if (op.imageModel !== undefined && (typeof op.imageModel !== 'string' || op.imageModel.length > 200)) throw new OpError('imageModel must be a string of 200 characters at most');
      const imageModel = op.imageModel === undefined ? old.imageModel ?? '' : op.imageModel.trim();
      const claudeModel = op.claudeModel === undefined ? old.claudeModel : text(op.claudeModel, 'claudeModel', { required: true, max: 200 });
      board.colab.lineup = { agents, rounds: op.rounds, budget: op.budget, turnLimit, claudeRoleId, imageModel };
      if (claudeModel !== undefined) board.colab.lineup.claudeModel = claudeModel;
      return { lineup: board.colab.lineup };
    }
    case 'setClaudeName': {
      board.colab.claudeName = text(op.name, 'name', { required: true, max: 200 });
      return { claudeName: board.colab.claudeName };
    }
    case 'resetColabSpent': {
      board.colab.spent = 0;
      return { spent: 0 };
    }
    case 'setColabExtras': {
      const rules = text(op.rules, 'rules', { keepSpace: true }) ?? '';
      const roles = op.roles ?? {};
      if (typeof roles !== 'object' || Array.isArray(roles)) throw new OpError('roles must be an object of role id to text');
      const kept = {};
      for (const [id, value] of Object.entries(roles)) kept[id] = text(value, `roles.${id}`, { keepSpace: true }) ?? '';
      board.colab.extras = { rules, roles: kept };
      return { extras: board.colab.extras };
    }
    default: {
      const result = brainstormOp(board, op, author) ?? memoryOp(board, op, author);
      if (result !== undefined) return result;
      throw new OpError(`unknown operation ${op?.type}`);
    }
  }
}
