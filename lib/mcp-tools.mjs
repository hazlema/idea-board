// The MCP tool set: each tool is a definition (name, description, input
// schema) plus the function that runs it against the board store. Claude's
// changes go through store.apply(op, author), the same path as the browser's.
import fs from 'node:fs';
import { AUDIT_TOOLS } from './audit.mjs';
import { authorName } from './authors.mjs';
import { OpError, text } from './board.mjs';
import { findGroupOfEntry, findObject, objectLabel } from './brainstorm.mjs';
import { findRuledOutMatches } from './memory.mjs';

const NOTE_PREVIEW = 160;
export const MAX_WAIT_SECONDS = 600;
export const DEFAULT_WAIT_SECONDS = 240;
const MAX_PICTURE_BYTES = 3.75 * 1024 * 1024;
const PICTURE_TYPES = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
const RESEMBLES = 'This resembles something the user ruled out. Remove it, or tell the user it was ruled out before and why.';
const MAX_BATCH = 50;
const TURN_NEXT = "It is your turn in the agents' run. Work on the board, then call reply with a short message to the others (3 to 5 sentences). Then call wait_for_chat again.";
// Tools a batch can't run: they wait, return raw content, or nest.
const NOT_IN_BATCH = new Set(['batch', 'wait_for_chat', 'view_picture', 'generate_image']);
const BATCH_REF = /^\$(\d+)\.([A-Za-z_]+)$/;
// Tools a prune pass may not use, alone or in a batch: it rewrites the board, not the chat or its history.
export const PRUNE_DENIED = new Set(['generate_image', 'add_picture_from_url', 'reply', 'undo_reply', 'wait_for_chat', 'restore_version', 'save_version', 'rename_board']);
// Tools that leave the board as it is, which a session may still use while a prune runs
// (a batch is checked call by call).
const LEAVES_BOARD = new Set(['view_board', 'view_brief', 'view_brainstorm', 'view_flow', 'view_chat', 'view_picture', 'get_node', 'get_history', 'list_versions', 'export_design_doc', 'wait_for_chat', 'batch']);
const PRUNE_RUNNING = 'a prune is running; try again when it finishes';

// Throws when `ctx`'s runner may not call `tool` right now.
function permit(ctx, tool) {
  if (ctx.readOnly && tool !== 'batch' && !AUDIT_TOOLS.has(tool)) throw new OpError(`${tool} isn't allowed during an audit`);
  if (ctx.prune && PRUNE_DENIED.has(tool)) throw new OpError(`${tool} isn't allowed during a prune`);
  if (!ctx.prune && ctx.store.pruning && !LEAVES_BOARD.has(tool)) throw new OpError(PRUNE_RUNNING);
}

const propsToList = (obj = {}) => Object.entries(obj).map(([key, value]) => ({ key, value: String(value) }));
const propsToObject = (list) => Object.fromEntries(list.map((p) => [p.key, p.value]));

function nodeSummary(node, full) {
  return {
    id: node.id,
    title: node.title,
    status: node.status,
    author: node.author,
    props: propsToObject(node.props),
    notes: full || node.notes.length <= NOTE_PREVIEW ? node.notes : `${node.notes.slice(0, NOTE_PREVIEW)}… (get_node for the rest)`,
  };
}

export const unansweredChat = (board) => board.chat
  .filter((m) => m.role === 'user' && m.owed?.includes('claude'))
  .map((m) => ({ id: m.id, text: m.text, at: m.at, pointing_at: m.context ?? [] }));

// The parts of the board, as the reading tools show them.
const ruledOutView = (b) => b.ruledOut.map((r) => ({ id: r.id, text: r.text, reason: r.reason, from: r.by, at: r.at }));
export const briefView = (b) => b.brief.sections.map((s) => ({ id: s.id, title: s.title, text: s.text }));

export function brainstormView(b) {
  const objects = b.brainstorm.pages.flatMap((p) => p.objects);
  const ofKind = (kind) => objects.filter((o) => o.kind === kind);
  // Where an object sits, so Claude can move things without overlapping them (h 0 = auto height).
  const box = (o) => ({ x: o.x, y: o.y, w: o.w, h: o.h });
  return {
    groups: ofKind('group').map((g) => ({
      id: g.id,
      title: g.title,
      color: g.color,
      claude_added: g.claudeAdded,
      ...box(g),
      entries: g.entries.filter((e) => !e.ruledOut).map((e) => ({ id: e.id, label: e.label, text: e.text, check: e.check, claude_added: e.claudeAdded })),
      ruled_out_entries: g.entries.filter((e) => e.ruledOut).map((e) => ({ id: e.id, label: e.label })),
    })),
    notes: ofKind('note').map((n) => ({ id: n.id, text: n.text, claude_added: n.claudeAdded, ...box(n) })),
    pictures: ofKind('picture').map((p) => ({ id: p.id, caption: p.caption, claude_added: p.claudeAdded, ...box(p) })),
    topics: ofKind('topic').map((t) => ({ id: t.id, text: t.text, ...box(t) })),
    links: b.brainstorm.pages.flatMap((p) => p.links).map((l) => ({ id: l.id, from: l.from, to: l.to, label: l.label, dashed: l.dashed })),
  };
}

export const flowView = (b, fullNotes) => ({
  nodes: b.flow.nodes.map((n) => ({ ...nodeSummary(n, fullNotes), x: n.x, y: n.y })),
  connections: b.flow.edges.map((e) => ({ id: e.id, from: e.from, to: e.to, label: e.label })),
});

// The whole board as one JSON (what view_board shows, less its notice; prune and card turns read it too).
export function boardView(store, { fullNotes = false } = {}) {
  const b = store.board;
  return {
    title: b.title,
    brief: briefView(b),
    ruled_out: ruledOutView(b),
    brainstorm: brainstormView(b),
    flowchart: flowView(b, fullNotes),
    unanswered_chat: unansweredChat(b),
  };
}

export const VIEW_BOARD_NOTICE = '* deprecated, please use view_brief, view_brainstorm, view_flow, view_chat to maximize context';
const HOST = new Set(['host', 'user', 'you']);
// The most view_chat sends in one answer, in characters of JSON (about 20K tokens), so it stays
// under Claude Code's cap on a tool's output (25K tokens) with room to spare.
export const MAX_CHAT_CHARS = 80_000;

// Whether a chat message was written by `from`: "host", a connection id, or part of the author's name (any case).
function writtenBy(board, message, from) {
  const wanted = from.trim().toLowerCase();
  if (HOST.has(wanted)) return message.role === 'user';
  if (message.role === from) return true;
  return message.role !== 'user' && authorName(board, message.role).toLowerCase().includes(wanted);
}

function chatLine(board, m) {
  const line = { id: m.id, from: m.role === 'user' ? 'Host' : authorName(board, m.role), at: m.at, text: m.text };
  if (m.to?.length) line.to = m.to;
  if (m.context?.length) line.pointing_at = m.context;
  return line;
}

// view_chat: the chat, oldest first: all of it, or the last `limit` messages before `before`,
// and never more of the newest than fit in MAX_CHAT_CHARS.
function chatView(board, author, args) {
  const owedToMe = (m) => m.role === 'user' && m.owed?.includes(author);
  let pool = board.chat;
  if (args.before !== undefined) {
    const at = pool.findIndex((m) => m.id === args.before);
    if (at === -1) throw new OpError(`no chat message ${args.before}`);
    pool = pool.slice(0, at);
  }
  if (args.from !== undefined) pool = pool.filter((m) => writtenBy(board, m, text(args.from, 'from', { required: true, max: 200 })));
  if (args.unanswered_only) pool = pool.filter(owedToMe);
  const limit = args.limit === undefined ? 0 : Math.max(1, Math.floor(Number(args.limit)) || 1);
  const wanted = limit ? pool.slice(-limit) : pool;
  const unanswered = args.unanswered_only ? null : board.chat.filter(owedToMe).map((m) => chatLine(board, m));
  // Newest first until the next one would not fit (the 50 covers the keys and the count).
  let room = MAX_CHAT_CHARS - 50 - (unanswered ? JSON.stringify(unanswered).length : 0);
  const messages = [];
  for (const m of [...wanted].reverse()) {
    const line = chatLine(board, m);
    room -= JSON.stringify(line).length + 1;
    if (room < 0) break;
    messages.unshift(line);
  }
  const view = { messages, more: pool.length - messages.length };
  if (unanswered) view.unanswered = unanswered;
  return view;
}

const string = { type: 'string' };
const number = { type: 'number' };
const boolean = { type: 'boolean' };
const colorSchema = { type: 'string', enum: ['slate', 'violet', 'green', 'amber', 'rose', 'sky'] };
const checkSchema = { type: 'string', enum: ['none', 'open', 'done'], description: 'none = a note or fact, open = undecided (unticked), done = agreed (ticked)' };
const near = { type: 'string', description: 'Id of an object to place this next to' };
const x = { type: 'number', description: 'Canvas x; leave out x and y to place it automatically' };
const y = { type: 'number', description: 'Canvas y' };
const propsSchema = { type: 'object', additionalProperties: { type: 'string' }, description: 'Key/value properties, e.g. {"cost": "3 mana"}' };
const object = (properties, required = []) => ({ type: 'object', properties, ...(required.length ? { required } : {}) });
const entrySchema = object({ label: string, text: string, check: checkSchema }, ['label']);
const groupIdOptional = { type: 'string', description: 'Optional: entry ids are unique across the board' };

// The group an entry is in: the one passed, else found from the entry id.
function entryGroupId(board, args) {
  const entryId = text(args.entry_id, 'entry_id', { required: true, max: 100 });
  return args.group_id ?? findGroupOfEntry(board, entryId).id;
}

// In a batch, a string "$<n>.<field>" stands for that field of the result of
// call n (an earlier one), e.g. "$0.id" for the id the first call created.
function resolveRefs(value, results) {
  if (typeof value === 'string') {
    const ref = BATCH_REF.exec(value);
    if (!ref) return value;
    const [, index, field] = ref;
    if (Number(index) >= results.length) throw new OpError(`${value} refers to a call that has not run yet`);
    const found = results[Number(index)].result?.[field];
    if (found === undefined) throw new OpError(`${value}: call ${index} returned no ${field}`);
    return found;
  }
  if (Array.isArray(value)) return value.map((v) => resolveRefs(v, results));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveRefs(v, results)]));
  return value;
}

// What a tool does with the board. `run(ctx, args)` returns the JSON the
// model sees, or `{ mcpContent }` for raw MCP content blocks.
const DEFINITIONS = [
  // Reading
  {
    name: 'view_brief',
    description: 'Start here. ruled_out comes first: ideas the user turned down, which you must never re-propose. Then the board title and the brief: what we are building and why, and the decisions so far. Read the rest with view_brainstorm, view_flow and view_chat as you need it.',
    inputSchema: object({}),
    run({ store, presence }) {
      presence?.markSeen();
      const b = store.board;
      return { title: b.title, ruled_out: ruledOutView(b), brief: briefView(b) };
    },
  },
  {
    name: 'view_brainstorm',
    description: 'Read the brainstorm canvas: groups with their entries (and the ruled-out entries of each group, which must not come back), notes, pictures, topic bubbles and links. Objects carry x, y, w, h (h 0 = auto height), so you can place and move things without overlapping them.',
    inputSchema: object({}),
    run({ store, presence }) {
      presence?.markSeen();
      return brainstormView(store.board);
    },
  },
  {
    name: 'view_flow',
    description: 'Read the flowchart: cards (with x, y) and the connections between them. Card notes are previews unless full_notes is set; get_node reads one card in full.',
    inputSchema: object({ full_notes: { type: 'boolean', description: 'Include full card notes instead of previews' } }),
    run({ store, presence }, args) {
      presence?.markSeen();
      return flowView(store.board, args.full_notes);
    },
  },
  {
    name: 'view_chat',
    description: `Read the board's chat, oldest first: all of it by default, with who wrote each, who a host message was sent to, and what it points at. A long chat sends the newest messages that fit; more says how many older ones there are, and before=<id of the oldest you have> pages back. limit asks for only the last few. from picks one author: "host", a connection id, or part of a name such as a role ("Foreman"). unanswered lists the host's messages still waiting on you; unanswered_only shows just those.`,
    inputSchema: object({
      limit: { type: 'number', description: 'Only the last this many messages (default: all)' },
      before: { type: 'string', description: 'Only messages before the one with this id' },
      from: { type: 'string', description: 'Only messages by this author: "host", a connection id, or part of a name' },
      unanswered_only: { type: 'boolean', description: "Only the host's messages still waiting on you" },
    }),
    run({ board, author }, args) {
      return chatView(board(), author, args);
    },
  },
  {
    name: 'view_board',
    description: 'Deprecated: use view_brief (start there; it has ruled_out), view_brainstorm, view_flow and view_chat, which read one part each and leave room for more context. This still returns the whole board in one go: ruled_out (never re-propose those), the brief, the brainstorm, the flowchart, and the user\'s unanswered chat messages.',
    inputSchema: object({ full_notes: { type: 'boolean', description: 'Include full card notes instead of previews' } }),
    run({ store, presence }, args) {
      presence?.markSeen();
      return { notice: VIEW_BOARD_NOTICE, ...boardView(store, { fullNotes: args.full_notes }) };
    },
  },
  {
    name: 'view_picture',
    description: 'Look at a picture on the brainstorm. Returns the image itself. Use it when a picture matters to the conversation.',
    inputSchema: object({ id: string }, ['id']),
    run({ board, store }, args) {
      const { object: picture } = findObject(board(), args.id);
      if (picture.kind !== 'picture') throw new OpError(`${picture.id} is not a picture`);
      const name = picture.preview ?? picture.asset;
      let data;
      try {
        const file = store.assets.resolve(name);
        if (fs.statSync(file).size > MAX_PICTURE_BYTES) throw new OpError('Picture too large to view; open the board in a browser once so it can make a preview.');
        data = fs.readFileSync(file);
      } catch (error) {
        if (error.code === 'ENOENT') throw new OpError('The picture file is missing from the board folder.');
        throw error;
      }
      return {
        mcpContent: [
          { type: 'text', text: objectLabel(picture) },
          { type: 'image', data: data.toString('base64'), mimeType: PICTURE_TYPES[name.split('.').pop()] },
        ],
      };
    },
  },
  {
    name: 'get_node',
    description: 'Read one flowchart card in full, with its incoming and outgoing connections.',
    inputSchema: object({ id: string }, ['id']),
    run({ board }, args) {
      const b = board();
      const node = b.flow.nodes.find((n) => n.id === args.id);
      if (!node) throw new OpError(`no node with id ${args.id}`);
      const title = (id) => b.flow.nodes.find((n) => n.id === id)?.title;
      return {
        ...nodeSummary(node, true),
        updated_by: node.updatedBy,
        outgoing: b.flow.edges.filter((e) => e.from === node.id).map((e) => ({ to: e.to, to_title: title(e.to), label: e.label })),
        incoming: b.flow.edges.filter((e) => e.to === node.id).map((e) => ({ from: e.from, from_title: title(e.from), label: e.label })),
      };
    },
  },
  {
    name: 'get_history',
    description: 'List recent changes to the board, newest first: who did what, when, and the turn id of Claude replies (for undo_reply). Pass before=<seq> to page back.',
    inputSchema: object({ limit: { type: 'number', description: 'How many entries (default 50)' }, before: { type: 'number', description: 'Only entries with a seq below this' } }),
    run({ store }, args) {
      return store.history({ limit: args.limit === undefined ? undefined : Number(args.limit), before: args.before === undefined ? undefined : Number(args.before) });
    },
  },
  {
    name: 'list_versions',
    description: 'List the saved versions of the board, newest first.',
    inputSchema: object({}),
    run: ({ store }) => ({ versions: store.versions.list() }),
  },

  // Brief
  {
    name: 'add_brief_section',
    description: "Add a text box to the board's brief, the project's free-form description. Use it to record goals, decisions, constraints or open questions the user settles, so the next conversation remembers them. Keep each box about one topic.",
    inputSchema: object({ title: { type: 'string', description: 'Short heading' }, text: { type: 'string', description: 'The content (plain text, newlines allowed)' } }, ['title', 'text']),
    run({ apply }, args) {
      const { section } = apply({ type: 'addSection', title: args.title, text: args.text });
      return { id: section.id, title: section.title };
    },
  },
  {
    name: 'update_brief_section',
    description: "Change a brief text box. Only the fields you pass change; text replaces the whole box. Don't rewrite the user's boxes unless they ask; add to them or add a new box instead.",
    inputSchema: object({ id: string, title: string, text: string }, ['id']),
    run({ apply }, args) {
      const { section } = apply({ type: 'updateSection', id: args.id, title: args.title, text: args.text });
      return { id: section.id, title: section.title, text: section.text };
    },
  },
  {
    name: 'move_brief_section',
    description: 'Move a brief text box up (-1) or down (1) one place.',
    inputSchema: object({ id: string, by: { type: 'number', enum: [-1, 1] } }, ['id', 'by']),
    run({ apply }, args) {
      if (args.by !== -1 && args.by !== 1) throw new OpError('by must be -1 or 1');
      apply({ type: 'moveSection', id: args.id, by: args.by });
      return { moved: args.id };
    },
  },
  {
    name: 'delete_brief_section',
    description: 'Remove a brief text box. Only when the user asks.',
    inputSchema: object({ id: string }, ['id']),
    run({ apply }, args) {
      apply({ type: 'deleteSection', id: args.id });
      return { deleted: args.id };
    },
  },

  // Brainstorm
  {
    name: 'add_group',
    description: 'Add a group to the brainstorm: a titled box of entries (each a label, optional detail and optional checkbox). Seed it with entries to save calls. It is marked "Claude added" until the user keeps it.',
    inputSchema: object({ title: string, color: colorSchema, entries: { type: 'array', items: entrySchema }, near, x, y }, ['title']),
    run({ apply, guard }, args) {
      const { object: group } = apply({ type: 'addObject', kind: 'group', title: args.title, color: args.color, entries: args.entries, near: args.near, x: args.x, y: args.y });
      return guard({ id: group.id, title: group.title, entries: group.entries.map((e) => ({ id: e.id, label: e.label })) }, [group.title, ...group.entries.map((e) => `${e.label} ${e.text}`)]);
    },
  },
  {
    name: 'update_group',
    description: "Change a group's title or color. Only the fields you pass change.",
    inputSchema: object({ id: string, title: string, color: colorSchema }, ['id']),
    run({ apply, guard }, args) {
      const { object: group } = apply({ type: 'updateObject', id: args.id, title: args.title, color: args.color });
      return guard({ id: group.id, title: group.title, color: group.color }, [args.title]);
    },
  },
  {
    name: 'add_entry',
    description: 'Add an entry to a group. The label is a short line; text is optional detail. check: none = a note or fact, open = undecided, done = agreed. Pass index to insert at a position (default: the end).',
    inputSchema: object({ group_id: string, label: string, text: string, check: checkSchema, index: number }, ['group_id', 'label', 'text']),
    run({ apply, guard }, args) {
      const { entry } = apply({ type: 'addEntry', groupId: args.group_id, label: args.label, text: args.text, check: args.check, index: args.index });
      return guard({ id: entry.id, group_id: args.group_id, label: entry.label }, [`${entry.label} ${entry.text}`]);
    },
  },
  {
    name: 'update_entry',
    description: 'Change an entry. Only the fields you pass change; use check to tick (done) or untick (open) it. The entry id is enough; group_id is optional.',
    inputSchema: object({ entry_id: string, group_id: groupIdOptional, label: string, text: string, check: checkSchema }, ['entry_id']),
    run({ apply, guard, board }, args) {
      const groupId = entryGroupId(board(), args);
      const { entry } = apply({ type: 'updateEntry', groupId, entryId: args.entry_id, label: args.label, text: args.text, check: args.check });
      const changedText = args.label !== undefined || args.text !== undefined;
      return guard({ id: entry.id, group_id: groupId, label: entry.label, text: entry.text, check: entry.check }, changedText ? [`${entry.label} ${entry.text}`] : []);
    },
  },
  {
    name: 'move_entry',
    description: 'Move an entry into another (or the same) group, at an optional position.',
    inputSchema: object({ entry_id: string, to_group_id: string, index: number }, ['entry_id', 'to_group_id']),
    run({ apply }, args) {
      const { entry } = apply({ type: 'moveEntry', entryId: args.entry_id, toGroupId: args.to_group_id, index: args.index });
      return { id: entry.id, group_id: args.to_group_id };
    },
  },
  {
    name: 'delete_entry',
    description: "Delete an entry from its group (group_id is optional). If the user turned it down, use rule_out instead so it is remembered. Only delete the user's entries when they ask.",
    inputSchema: object({ entry_id: string, group_id: groupIdOptional }, ['entry_id']),
    run({ apply, board }, args) {
      apply({ type: 'deleteEntry', groupId: entryGroupId(board(), args), entryId: args.entry_id });
      return { deleted: args.entry_id };
    },
  },
  {
    name: 'add_note',
    description: 'Add a sticky note to the brainstorm.',
    inputSchema: object({ text: string, color: colorSchema, near, x, y }, ['text']),
    run({ apply, guard }, args) {
      const { object: note } = apply({ type: 'addObject', kind: 'note', text: args.text, color: args.color, near: args.near, x: args.x, y: args.y });
      return guard({ id: note.id }, [note.text]);
    },
  },
  {
    name: 'update_note',
    description: "Change a note's text or color. Only the fields you pass change.",
    inputSchema: object({ id: string, text: string, color: colorSchema }, ['id']),
    run({ apply, guard }, args) {
      const { object: note } = apply({ type: 'updateObject', id: args.id, text: args.text, color: args.color });
      return guard({ id: note.id, text: note.text, color: note.color }, [args.text]);
    },
  },
  {
    name: 'add_topic',
    description: 'Add a topic bubble: a short label for a theme that groups and notes can be linked to.',
    inputSchema: object({ text: string, near, x, y }, ['text']),
    run({ apply, guard }, args) {
      const { object: topic } = apply({ type: 'addObject', kind: 'topic', text: args.text, near: args.near, x: args.x, y: args.y });
      return guard({ id: topic.id }, [topic.text]);
    },
  },
  {
    name: 'update_topic',
    description: "Change a topic bubble's text.",
    inputSchema: object({ id: string, text: string }, ['id', 'text']),
    run({ apply, guard }, args) {
      const { object: topic } = apply({ type: 'updateObject', id: args.id, text: args.text });
      return guard({ id: topic.id, text: topic.text }, [topic.text]);
    },
  },
  {
    name: 'add_picture_from_url',
    description: 'Download a picture (png, jpeg, gif or webp, up to 30 MB) from a web address and add it to the brainstorm. Use view_picture afterwards to look at it.',
    inputSchema: object({ url: string, caption: string, near }, ['url']),
    async run({ apply, store }, args) {
      const { asset } = await store.assets.ingestUrl(args.url);
      const { object: picture } = apply({ type: 'addObject', kind: 'picture', asset, caption: args.caption, near: args.near });
      return { id: picture.id, caption: picture.caption };
    },
  },
  {
    name: 'generate_image',
    description: 'Make a new picture from a text prompt with the board\'s image model and add it to the brainstorm. Only some roles can use it; at most 2 per turn; it costs money from the budget.',
    inputSchema: object({ prompt: string, caption: string, near }, ['prompt']),
    async run({ apply, author, pictures, signal, onSpend }, args) {
      if (!pictures) throw new OpError('No image model is set; choose one in ⋯ → Settings.');
      const prompt = text(args.prompt, 'prompt', { required: true, max: 4000 });
      const { asset } = await pictures.make({ author, prompt, signal: signal(), onSpend });
      const { object: picture } = apply({ type: 'addObject', kind: 'picture', asset, caption: args.caption, near: args.near });
      return { id: picture.id, caption: picture.caption };
    },
  },
  {
    name: 'update_picture',
    description: "Change a picture's caption.",
    inputSchema: object({ id: string, caption: string }, ['id', 'caption']),
    run({ apply }, args) {
      const { object: picture } = apply({ type: 'updateObject', id: args.id, caption: args.caption });
      return { id: picture.id, caption: picture.caption };
    },
  },
  {
    name: 'move_object',
    description: 'Move or resize a group, note, picture or topic on the brainstorm canvas. Only the fields you pass change. A height of 0 means automatic.',
    inputSchema: object({ id: string, x, y, w: number, h: number }, ['id']),
    run({ apply }, args) {
      const { object: moved } = apply({ type: 'moveObject', id: args.id, x: args.x, y: args.y, w: args.w, h: args.h });
      return { id: moved.id, x: moved.x, y: moved.y, w: moved.w, h: moved.h };
    },
  },
  {
    name: 'delete_object',
    description: "Delete a group, note, picture or topic, with its links. If the user turned it down, use rule_out instead so it is remembered. Only delete the user's things when they ask.",
    inputSchema: object({ id: string }, ['id']),
    run({ apply }, args) {
      apply({ type: 'deleteObject', id: args.id });
      return { deleted: args.id };
    },
  },
  {
    name: 'link',
    description: 'Draw a line from one brainstorm object to another, with an optional label. dashed = true for a weaker or tentative relation.',
    inputSchema: object({ from: string, to: string, label: string, dashed: boolean }, ['from', 'to']),
    run({ apply }, args) {
      const { link } = apply({ type: 'addLink', from: args.from, to: args.to, label: args.label, dashed: args.dashed });
      return { id: link.id, from: link.from, to: link.to, label: link.label, dashed: link.dashed };
    },
  },
  {
    name: 'update_link',
    description: "Change a link's label or dashed style. Only the fields you pass change.",
    inputSchema: object({ id: string, label: string, dashed: boolean }, ['id']),
    run({ apply }, args) {
      const { link } = apply({ type: 'updateLink', id: args.id, label: args.label, dashed: args.dashed });
      return { id: link.id, label: link.label, dashed: link.dashed };
    },
  },
  {
    name: 'unlink',
    description: 'Remove a link between two brainstorm objects.',
    inputSchema: object({ id: string }, ['id']),
    run({ apply }, args) {
      apply({ type: 'deleteLink', id: args.id });
      return { deleted: args.id };
    },
  },

  // Memory
  {
    name: 'rule_out',
    description: 'Record that something is ruled out, with the user\'s reason, so it is never proposed again. Use it when the user rejects something ("we don\'t want X"). target says what: {kind:"entry",entryId} strikes an entry through (groupId optional), {kind:"object",id} removes a group, note, picture or topic, {kind:"node",id} rejects a card, {kind:"idea"} records an idea that is not on the board (then pass text). Everything is kept and can be brought back.',
    inputSchema: object({
      reason: { type: 'string', description: "Why, in the user's words" },
      text: { type: 'string', description: 'What was ruled out; needed for kind "idea", otherwise taken from the target' },
      target: object({ kind: { type: 'string', enum: ['entry', 'object', 'node', 'idea'] }, groupId: string, entryId: string, id: string }, ['kind']),
    }, ['reason']),
    run({ apply, board }, args) {
      if (typeof args.reason !== 'string') throw new OpError('reason is required');
      let target = args.target ?? { kind: 'idea' };
      if (target.kind === 'entry' && target.groupId === undefined && typeof target.entryId === 'string') {
        target = { ...target, groupId: findGroupOfEntry(board(), target.entryId).id };
      }
      const { record } = apply({ type: 'ruleOut', target, reason: args.reason, text: args.text });
      return { id: record.id, text: record.text, reason: record.reason };
    },
  },
  {
    name: 'bring_back',
    description: 'Take something off the ruled-out list and restore it. Only when the user changes their mind.',
    inputSchema: object({ id: { type: 'string', description: 'Id of the ruled_out record' } }, ['id']),
    run({ apply }, args) {
      apply({ type: 'bringBack', id: args.id });
      return { restored: args.id };
    },
  },

  // Flowchart
  {
    name: 'add_node',
    description: 'Add a card to the flowchart. Keep the title to a short one-liner; put detail in notes and props. Pass connect_from to link it from an existing card and place it next to that card. To place it yourself, pass near (a card to sit beside, without connecting) or x and y.',
    inputSchema: object({
      title: string,
      notes: { type: 'string', description: 'Longer notes (plain text, newlines allowed)' },
      props: propsSchema,
      connect_from: { type: 'string', description: 'Id of an existing card to connect from' },
      edge_label: { type: 'string', description: 'Label for that connection' },
      near: { type: 'string', description: 'Id of a card to place this next to (wins over connect_from for placement)' },
      x,
      y,
    }, ['title']),
    run({ apply, guard }, args) {
      const { node } = apply({ type: 'addNode', title: args.title, notes: args.notes, props: propsToList(args.props), near: args.near ?? args.connect_from, x: args.x, y: args.y });
      if (args.connect_from) apply({ type: 'addEdge', from: args.connect_from, to: node.id, label: args.edge_label });
      return guard({ id: node.id, title: node.title }, [node.title, node.notes]);
    },
  },
  {
    name: 'update_node',
    description: "Change a card. Only the fields you pass change. set_props adds or overwrites keys; remove_props deletes keys. Pass x and y to move the card. Set status to 'accepted' only when the user has decided; to reject a card use rule_out.",
    inputSchema: object({
      id: string,
      title: string,
      notes: { type: 'string', description: 'Replaces the notes entirely' },
      set_props: propsSchema,
      remove_props: { type: 'array', items: string },
      status: { type: 'string', enum: ['idea', 'accepted'] },
      x,
      y,
    }, ['id']),
    run({ apply, guard }, args) {
      // Absent fields are left out so a pure move (only x/y) is not counted as an edit.
      const fields = { title: args.title, notes: args.notes, status: args.status, setProps: args.set_props, removeProps: args.remove_props, x: args.x, y: args.y };
      const { node } = apply({ type: 'updateNode', id: args.id, ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) });
      return guard(nodeSummary(node, true), [args.title, args.notes]);
    },
  },
  {
    name: 'delete_node',
    description: "Delete a card and its connections. If the user turned it down, use rule_out instead so it is remembered. Only delete the user's cards when they ask.",
    inputSchema: object({ id: string }, ['id']),
    run({ apply }, args) {
      apply({ type: 'deleteNode', id: args.id });
      return { deleted: args.id };
    },
  },
  {
    name: 'connect',
    description: 'Draw an arrow from one card to another, with an optional label.',
    inputSchema: object({ from: string, to: string, label: string }, ['from', 'to']),
    run({ apply }, args) {
      const { edge } = apply({ type: 'addEdge', from: args.from, to: args.to, label: args.label });
      return { id: edge.id, from: edge.from, to: edge.to, label: edge.label };
    },
  },
  {
    name: 'update_connection',
    description: "Change the label of the arrow from one card to another (connect leaves an existing arrow's label alone). Omit label to clear it.",
    inputSchema: object({ from: string, to: string, label: string }, ['from', 'to']),
    run({ apply, board }, args) {
      const found = board().flow.edges.find((e) => e.from === args.from && e.to === args.to);
      if (!found) throw new OpError(`no connection from ${args.from} to ${args.to}`);
      const { edge } = apply({ type: 'updateEdge', id: found.id, label: args.label });
      return { id: edge.id, from: edge.from, to: edge.to, label: edge.label };
    },
  },
  {
    name: 'disconnect',
    description: 'Remove the arrow from one card to another.',
    inputSchema: object({ from: string, to: string }, ['from', 'to']),
    run({ apply }, args) {
      apply({ type: 'deleteEdge', from: args.from, to: args.to });
      return { disconnected: `${args.from} -> ${args.to}` };
    },
  },
  {
    name: 'tidy_layout',
    description: "Rearrange the whole flowchart left to right by how cards connect: each card one column past its deepest parent, ordered to keep arrows from crossing, near the cards it connects to. This moves the user's cards too, so only do it when the user asks.",
    inputSchema: object({}),
    run: ({ apply }) => apply({ type: 'tidy' }),
  },
  {
    name: 'rename_board',
    description: 'Change the board\'s title.',
    inputSchema: object({ title: string }, ['title']),
    run({ apply }, args) {
      const { title } = apply({ type: 'setTitle', title: args.title });
      return { title };
    },
  },

  // History, versions, export
  {
    name: 'undo_reply',
    description: 'Undo every change you made in one earlier reply (a turn, taken from get_history). Changes the user has edited since are skipped and reported.',
    inputSchema: object({ turn: { type: 'string', description: 'Turn id from get_history' } }, ['turn']),
    run({ store, author, prune }, args) {
      return store.undoTurn(text(args.turn, 'turn', { required: true, max: 100 }), author, { prune });
    },
  },
  {
    name: 'save_version',
    description: 'Save the board as a named version the user can preview and restore. Do it before big rework.',
    inputSchema: object({ name: string }, ['name']),
    run({ store, author, prune }, args) {
      return { version: store.saveVersion(text(args.name, 'name', { required: true, max: 200 }), author, { prune }) };
    },
  },
  {
    name: 'restore_version',
    description: 'Put a saved version back on the board (the current board is saved first). Memory (ruled-out list, chat, history) is kept. Only when the user asks.',
    inputSchema: object({ id: string }, ['id']),
    run({ store, author, prune }, args) {
      try {
        const { restored, backup } = store.restoreVersion(args.id, author, { prune });
        return { restored: { id: restored.id, name: restored.name }, backup: { id: backup.id, name: backup.name } };
      } catch (error) {
        if (error.status === 404) throw new OpError(error.message);
        throw error;
      }
    },
  },
  {
    name: 'export_design_doc',
    description: 'Write the board out as a readable design document (Markdown) beside the board file and return its path.',
    inputSchema: object({}),
    run: ({ store }) => ({ path: store.exportDesignDoc() }),
  },

  // Several changes at once
  {
    name: 'batch',
    description: `Run several tools in one call, in order, each as if called alone: calls is a list of {tool, args}. A later call can use what an earlier one returned: the string "$0.id" is the id from the first call (any field works, e.g. "$1.group_id"), so you can add a group and fill it in one go. Stops at the first error: the calls before it stay done and are listed, failed says which one broke, and you can carry on from there or undo_reply. Up to ${MAX_BATCH} calls; not for ${[...NOT_IN_BATCH].join(', ')}.`,
    inputSchema: object({
      calls: { type: 'array', maxItems: MAX_BATCH, items: object({ tool: string, args: { type: 'object', description: 'The arguments for that tool, as you would pass them alone' } }, ['tool']) },
    }, ['calls']),
    async run(ctx, args) {
      if (!Array.isArray(args.calls) || !args.calls.length) throw new OpError('calls must be a non-empty list');
      if (args.calls.length > MAX_BATCH) throw new OpError(`a batch can hold ${MAX_BATCH} calls at most`);
      const results = [];
      for (const [index, call] of args.calls.entries()) {
        const tool = call?.tool;
        try {
          if (NOT_IN_BATCH.has(tool)) throw new OpError(`${tool} can't run inside a batch`);
          permit(ctx, tool);
          const run = HANDLERS.get(tool);
          if (!run) throw new OpError(`unknown tool ${tool}`);
          results.push({ tool, result: await run(ctx, resolveRefs(call.args ?? {}, results)) });
        } catch (error) {
          if (!(error instanceof OpError)) throw error;
          return { results, failed: { index, tool, error: error.message }, not_run: args.calls.length - index - 1 };
        }
      }
      return { results };
    },
  },

  // Chat
  {
    name: 'reply',
    description: "Post a message in the board's chat. This marks the user's earlier messages as answered, except when it finishes your turn in an agents' run.",
    inputSchema: object({ text: string }, ['text']),
    run({ apply, presence }, args) {
      // A turn post says nothing about the user's questions, so it answers none.
      if (presence?.turn?.handed) {
        apply({ type: 'chat', text: args.text, answers: [] });
        presence.finishTurn();
        return { posted: true, turn: 'done' };
      }
      apply({ type: 'chat', text: args.text });
      return { posted: true };
    },
  },
  {
    name: 'wait_for_chat',
    description: `Hold the line until the user types in the board's chat, then return their new messages (long poll; pointing_at says what each message refers to). Returns early with no messages after timeout_seconds (default ${DEFAULT_WAIT_SECONDS}, max ${MAX_WAIT_SECONDS}). board_changes lists what the user changed on the board since you last looked (view_brief, view_brainstorm, view_flow or the previous wait), oldest first, with the ids each touched; your own changes are left out. While you are waiting, this session answers the chat instead of a background Claude. During an agents' run it may return a turn instead of messages: do the turn, then reply. Loop: wait_for_chat → act on the board → reply → wait_for_chat.`,
    inputSchema: object({ timeout_seconds: number }),
    async run({ presence, pictures, author }, args) {
      const seconds = Math.min(Math.max(Number(args.timeout_seconds) || DEFAULT_WAIT_SECONDS, 1), MAX_WAIT_SECONDS);
      // The first wait of a session starts counting edits from now.
      if (!presence.seen) presence.markSeen();
      const { messages, turn } = await presence.waitForChat(seconds * 1000);
      // Whatever it returns is a new go for the session: its picture count starts over.
      pictures?.newTurn(author);
      const { changes, more } = presence.takeBoardChanges();
      const edits = { board_changes: changes, ...(more ? { more_board_changes: more } : {}) };
      const role = presence.role();
      const you = role ? { your_role: role } : {};
      if (turn) return { messages: [], turn, ...you, ...edits, next: TURN_NEXT };
      const noticed = changes.length ? ' Take the board changes into account (get_history, view_brainstorm or view_flow for detail).' : '';
      return messages.length
        ? { messages, ...you, ...edits, next: `Act on these, reply, then call wait_for_chat again.${noticed}` }
        : { messages: [], ...you, ...edits, next: changes.length ? `No new messages, but the user changed the board.${noticed} Call wait_for_chat again to keep listening.` : 'No new messages. Call wait_for_chat again to keep listening.' };
    },
  },
];

export const TOOLS = DEFINITIONS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));

const HANDLERS = new Map(DEFINITIONS.map((tool) => [tool.name, tool.run]));

// Runs the tools as `author` (a Claude session, or an agent from the colab roster).
// `pictures` (a PictureMaker) is what generate_image makes pictures with. `signal` returns the
// AbortSignal that cuts a picture call short (a function, as a caller's signal can change), and
// `onSpend(cost)` hears what a picture cost. `prune` is the token of the prune pass this runner
// serves: its ops are tagged as the pass's and it can't use PRUNE_DENIED. Any other runner can
// only read while a pass runs. `readOnly` limits the runner to AUDIT_TOOLS (also inside a batch).
export function createToolRunner(store, presence, { author = 'claude', pictures = null, signal = () => undefined, onSpend, prune, readOnly = false } = {}) {
  const board = () => store.board;
  // Adds a warning to a tool result when any of `texts` resembles a ruled-out
  // idea. The change itself has already been made.
  const guard = (result, texts) => {
    const matches = new Map();
    for (const value of texts) {
      if (typeof value !== 'string') continue;
      for (const record of findRuledOutMatches(value, board().ruledOut)) matches.set(record.id, record);
    }
    if (!matches.size) return result;
    return { ...result, resembles_ruled_out: [...matches.values()].map((r) => ({ id: r.id, text: r.text, reason: r.reason })), warning: RESEMBLES };
  };
  const context = { store, presence, board, guard, author, pictures, signal, onSpend, prune, readOnly, apply: (op) => store.apply(op, author, { prune }) };

  return {
    async call(name, args = {}) {
      const run = HANDLERS.get(name);
      if (!run) throw new OpError(`unknown tool ${name}`);
      permit(context, name);
      return run(context, args);
    },
  };
}
