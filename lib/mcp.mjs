// MCP over Streamable HTTP, hand-rolled: Claude Code POSTs JSON-RPC to /mcp and
// we answer with plain JSON. Only the tools capability is implemented. The
// tools themselves live in mcp-tools.mjs; this file is the protocol layer and
// the wait_for_chat presence tracking.
import { OpError } from './board.mjs';
import { changedIdsOf } from './history.mjs';
import { TOOLS, createToolRunner, unansweredChat } from './mcp-tools.mjs';

export { TOOLS, createToolRunner };

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const INSTRUCTIONS = 'A shared idea board you and the user both edit: Brief (what you are building), Brainstorm (groups, notes, pictures, topics, links) and Flowchart (cards and arrows). Call view_board first and read ruled_out: never re-propose anything on it; if a tool result flags a resemblance, tell the user. Record rejections the user states with rule_out. You may change anything; every change is visible and undoable. Use batch to make several changes in one call. Use wait_for_chat to listen to the board chat; it also reports what the user changed on the board since you last looked.';
const MAX_BOARD_CHANGES = 20;

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
    // How far the session has seen the board's history: the last seq it was
    // shown and when, so a user edit still growing (merged into that entry)
    // shows up again.
    this.seen = null;
  }

  // The session has just seen the whole board (view_board).
  markSeen() {
    const entries = this.store.historyLog.entries();
    this.seen = { seq: entries.at(-1)?.seq ?? 0, at: Date.now() };
  }

  // What the user changed on the board since the session last looked, oldest
  // first, and that it has now seen them. Claude's own changes are left out.
  takeBoardChanges() {
    const since = this.seen;
    this.markSeen();
    if (!since) return { changes: [], more: 0 };
    const changes = this.store.historyLog.entries()
      .filter((e) => e.author === 'user' && (e.seq > since.seq || Date.parse(e.at) > since.at))
      .map((e) => ({ seq: e.seq, summary: e.summary, at: e.at, ids: changedIdsOf(e.changes) }));
    return { changes: changes.slice(-MAX_BOARD_CHANGES), more: Math.max(0, changes.length - MAX_BOARD_CHANGES) };
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
      // Messages already waiting are handed over at once; otherwise wait for one.
      const timer = setTimeout(() => finish(ready.length ? this.#pending() : []), ready.length ? 0 : timeoutMs);
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
          serverInfo: { name: 'idea-board', version: '0.2.0' },
          instructions: INSTRUCTIONS,
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
          // A tool that returns { mcpContent } supplies raw content blocks (e.g. an image).
          const content = output?.mcpContent ?? [{ type: 'text', text: JSON.stringify(output, null, 2) }];
          return rpcResult(msg.id, { content });
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
