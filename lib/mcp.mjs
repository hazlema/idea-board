// MCP over Streamable HTTP, hand-rolled: Claude Code POSTs JSON-RPC to /mcp and
// we answer with plain JSON. Only the tools capability is implemented.
import { OpError } from './board.mjs';

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const NOTE_PREVIEW = 160;
const MAX_WAIT_SECONDS = 600;
const DEFAULT_WAIT_SECONDS = 240;

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

const unansweredChat = (board) => board.chat.filter((m) => m.role === 'user' && !m.handled).map((m) => ({ id: m.id, text: m.text, at: m.at }));

const string = { type: 'string' };
const propsSchema = { type: 'object', additionalProperties: { type: 'string' }, description: 'Key/value properties, e.g. {"cost": "3 mana"}' };

export const TOOLS = [
  {
    name: 'view_board',
    description: 'See the whole board: the brief (what we are building and why; read it first), every node (id, one-line title, status, author, props, notes preview), every connection, and chat messages from the user that have not been answered yet. Call this first.',
    inputSchema: { type: 'object', properties: { full_notes: { type: 'boolean', description: 'Include full notes instead of previews' } } },
  },
  {
    name: 'add_brief_section',
    description: "Add a text box to the board's brief, the project's free-form description. Use it to record goals, decisions, constraints or open questions the user settles, so the next conversation remembers them. Keep each box about one topic.",
    inputSchema: { type: 'object', properties: { title: { type: 'string', description: 'Short heading' }, text: { type: 'string', description: 'The content (plain text, newlines allowed)' } }, required: ['title', 'text'] },
  },
  {
    name: 'update_brief_section',
    description: "Change a brief text box. Only the fields you pass change; text replaces the whole box. Don't rewrite the user's boxes unless they ask; add to them or add a new box instead.",
    inputSchema: { type: 'object', properties: { id: string, title: string, text: string }, required: ['id'] },
  },
  {
    name: 'delete_brief_section',
    description: 'Remove a brief text box. Only when the user asks.',
    inputSchema: { type: 'object', properties: { id: string }, required: ['id'] },
  },
  {
    name: 'get_node',
    description: 'Read one node in full, with its incoming and outgoing connections.',
    inputSchema: { type: 'object', properties: { id: string }, required: ['id'] },
  },
  {
    name: 'add_node',
    description: 'Add an idea to the board. Keep the title to a short one-liner; put detail in notes and props. Pass connect_from to link it from an existing node and place it next to that node.',
    inputSchema: {
      type: 'object',
      properties: {
        title: string,
        notes: { type: 'string', description: 'Longer notes (plain text, newlines allowed)' },
        props: propsSchema,
        connect_from: { type: 'string', description: 'Id of an existing node to connect from' },
        edge_label: { type: 'string', description: 'Label for that connection' },
      },
      required: ['title'],
    },
  },
  {
    name: 'update_node',
    description: "Change a node. Only the fields you pass change. set_props adds or overwrites keys; remove_props deletes keys. Set status to 'accepted' or 'rejected' only when the user has decided.",
    inputSchema: {
      type: 'object',
      properties: {
        id: string,
        title: string,
        notes: { type: 'string', description: 'Replaces the notes entirely' },
        set_props: propsSchema,
        remove_props: { type: 'array', items: string },
        status: { type: 'string', enum: ['idea', 'accepted', 'rejected'] },
      },
      required: ['id'],
    },
  },
  {
    name: 'delete_node',
    description: 'Delete a node and its connections. Only delete nodes the user created when they ask you to.',
    inputSchema: { type: 'object', properties: { id: string }, required: ['id'] },
  },
  {
    name: 'connect',
    description: 'Draw an arrow from one node to another, with an optional label.',
    inputSchema: { type: 'object', properties: { from: string, to: string, label: string }, required: ['from', 'to'] },
  },
  {
    name: 'disconnect',
    description: 'Remove the arrow from one node to another.',
    inputSchema: { type: 'object', properties: { from: string, to: string }, required: ['from', 'to'] },
  },
  {
    name: 'tidy_layout',
    description: 'Rearrange the whole board left to right by how ideas connect. This moves the user\'s cards too, so only do it when the user asks.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'reply',
    description: "Post a message in the board's chat. This marks the user's earlier messages as answered.",
    inputSchema: { type: 'object', properties: { text: string }, required: ['text'] },
  },
  {
    name: 'wait_for_chat',
    description: `Hold the line until the user types in the board's chat, then return their new messages (long poll). Returns early with no messages after timeout_seconds (default ${DEFAULT_WAIT_SECONDS}, max ${MAX_WAIT_SECONDS}). While you are waiting, this session answers the chat instead of a background Claude. Loop: wait_for_chat → act on the board → reply → wait_for_chat.`,
    inputSchema: { type: 'object', properties: { timeout_seconds: { type: 'number' } } },
  },
];

export function createToolRunner(store, presence) {
  const apply = (op) => store.apply(op, 'claude');
  const board = () => store.board;

  return {
    async call(name, args = {}) {
      switch (name) {
        case 'view_board': {
          const b = board();
          return {
            title: b.title,
            brief: b.brief.sections.map((x) => ({ id: x.id, title: x.title, text: x.text, last_edited_by: x.updatedBy })),
            nodes: b.flow.nodes.map((n) => nodeSummary(n, args.full_notes)),
            connections: b.flow.edges.map((e) => ({ from: e.from, to: e.to, label: e.label })),
            unanswered_chat: unansweredChat(b),
          };
        }
        case 'get_node': {
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
        }
        case 'add_node': {
          const { node } = apply({ type: 'addNode', title: args.title, notes: args.notes, props: propsToList(args.props), near: args.connect_from });
          if (args.connect_from) apply({ type: 'addEdge', from: args.connect_from, to: node.id, label: args.edge_label });
          return { id: node.id, title: node.title };
        }
        case 'update_node': {
          const { node } = apply({
            type: 'updateNode', id: args.id, title: args.title, notes: args.notes, status: args.status,
            setProps: args.set_props, removeProps: args.remove_props,
          });
          return nodeSummary(node, true);
        }
        case 'delete_node':
          apply({ type: 'deleteNode', id: args.id });
          return { deleted: args.id };
        case 'connect': {
          const { edge } = apply({ type: 'addEdge', from: args.from, to: args.to, label: args.label });
          return { from: edge.from, to: edge.to, label: edge.label };
        }
        case 'disconnect':
          apply({ type: 'deleteEdge', from: args.from, to: args.to });
          return { disconnected: `${args.from} -> ${args.to}` };
        case 'add_brief_section': {
          const { section } = apply({ type: 'addSection', title: args.title, text: args.text });
          return { id: section.id, title: section.title };
        }
        case 'update_brief_section': {
          const { section } = apply({ type: 'updateSection', id: args.id, title: args.title, text: args.text });
          return { id: section.id, title: section.title, text: section.text };
        }
        case 'delete_brief_section':
          apply({ type: 'deleteSection', id: args.id });
          return { deleted: args.id };
        case 'tidy_layout':
          return apply({ type: 'tidy' });
        case 'reply':
          apply({ type: 'chat', text: args.text });
          return { posted: true };
        case 'wait_for_chat': {
          const seconds = Math.min(Math.max(Number(args.timeout_seconds) || DEFAULT_WAIT_SECONDS, 1), MAX_WAIT_SECONDS);
          const messages = await presence.waitForChat(seconds * 1000);
          return messages.length
            ? { messages, next: 'Act on these, reply, then call wait_for_chat again.' }
            : { messages: [], next: 'No new messages. Call wait_for_chat again to keep listening.' };
        }
        default:
          throw new OpError(`unknown tool ${name}`);
      }
    },
  };
}

// Tracks whether an interactive session is listening via wait_for_chat, so
// the background agent knows to stay out of the way.
export class Presence {
  // A session counts as attached while it waits and for a grace period after
  // a wait returns, while it works on what it received.
  constructor(store, { graceMs = 5 * 60_000 } = {}) {
    this.store = store;
    this.graceMs = graceMs;
    this.waiting = 0;
    this.lastSeen = 0;
    this.delivered = new Set();
    this.onDetach = null;
    this.detachTimer = null;
  }

  attached() {
    return this.waiting > 0 || Date.now() - this.lastSeen < this.graceMs;
  }

  #pending() {
    return unansweredChat(this.store.board).filter((m) => !this.delivered.has(m.id));
  }

  #deliver(messages) {
    for (const m of messages) this.delivered.add(m.id);
    return messages;
  }

  waitForChat(timeoutMs) {
    this.waiting += 1;
    this.store.emit({ type: 'presence', attached: true });
    return new Promise((resolve) => {
      const finish = (messages) => {
        clearTimeout(timer);
        unsubscribe();
        this.waiting -= 1;
        this.lastSeen = Date.now();
        this.#scheduleDetachCheck();
        resolve(this.#deliver(messages));
      };
      const ready = this.#pending();
      let unsubscribe = () => {};
      const timer = setTimeout(() => finish([]), ready.length ? 0 : timeoutMs);
      if (ready.length) return;
      unsubscribe = this.store.subscribe((event) => {
        if (event.type === 'board' && event.op === 'chat' && event.author === 'user') finish(this.#pending());
      });
    });
  }

  #scheduleDetachCheck() {
    clearTimeout(this.detachTimer);
    this.detachTimer = setTimeout(() => {
      if (this.attached()) return;
      this.store.emit({ type: 'presence', attached: false });
      this.onDetach?.();
    }, this.graceMs + 50);
    this.detachTimer.unref?.();
  }
}

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

export function createMcpHandler(tools) {
  async function handleOne(msg) {
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return rpcError(msg?.id ?? null, -32600, 'Invalid request');
    const isNotification = msg.id === undefined || msg.id === null;
    if (isNotification) return null;
    switch (msg.method) {
      case 'initialize': {
        const requested = msg.params?.protocolVersion;
        return rpcResult(msg.id, {
          protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'idea-board', version: '0.1.0' },
          instructions: 'A shared idea board (flowchart whiteboard) with the user. Its brief says what you are building together. Use view_board to see it and the other tools to change it. Use wait_for_chat to listen to the board chat.',
        });
      }
      case 'ping':
        return rpcResult(msg.id, {});
      case 'tools/list':
        return rpcResult(msg.id, { tools: TOOLS });
      case 'tools/call': {
        const { name, arguments: args } = msg.params ?? {};
        try {
          const output = await tools.call(name, args ?? {});
          return rpcResult(msg.id, { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }] });
        } catch (error) {
          if (!(error instanceof OpError)) throw error;
          return rpcResult(msg.id, { content: [{ type: 'text', text: error.message }], isError: true });
        }
      }
      default:
        return rpcError(msg.id, -32601, `Method not found: ${msg.method}`);
    }
  }

  // Returns the JSON body to send, or null for a 202 with no body.
  return async function handle(body) {
    if (Array.isArray(body)) {
      const responses = (await Promise.all(body.map(handleOne))).filter(Boolean);
      return responses.length ? responses : null;
    }
    return handleOne(body);
  };
}
