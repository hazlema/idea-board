// MCP over Streamable HTTP, hand-rolled: Claude Code POSTs JSON-RPC to /mcp and
// we answer with plain JSON. Only the tools capability is implemented. The
// tools themselves live in mcp-tools.mjs; this file is the protocol layer and
// the wait_for_chat presence tracking.
import { OpError } from './board.mjs';
import { changedIdsOf } from './history.mjs';
import { PRUNE_DENIED, TOOLS, createToolRunner, unansweredChat } from './mcp-tools.mjs';

export { PRUNE_DENIED, TOOLS, createToolRunner };

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const INSTRUCTIONS = 'A shared idea board you and the user both edit: Brief (what you are building), Brainstorm (groups, notes, pictures, topics, links) and Flowchart (cards and arrows). Call view_board first and read ruled_out: never re-propose anything on it; if a tool result flags a resemblance, tell the user. Record rejections the user states with rule_out. You may change anything; every change is visible and undoable. Use batch to make several changes in one call. Use wait_for_chat to listen to the board chat; it also reports what the user changed on the board since you last looked.';
const MAX_BOARD_CHANGES = 20;
const DEFAULT_TURN_MS = 30 * 60_000;
const NONE = new Set();

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
    // Set by the Room: the text of Claude's role in the agents' run.
    this.role = () => '';
    // A run turn offered to the session: { prompt, handed, settle }.
    this.turn = null;
    this.wakers = new Set();
    // Set by the Room: the ids of messages the claude binary is answering, which the
    // session is not handed (both would answer).
    this.busy = () => NONE;
  }

  // Gives the session its turn in the agents' run: the next or current
  // wait_for_chat returns it. Resolves true when the session replies, false
  // on timeout or abort, and 'detached' when the session goes before taking
  // it (in each case but true the turn is withdrawn).
  offerTurn(prompt, { timeoutMs = DEFAULT_TURN_MS, signal } = {}) {
    if (this.turn) return Promise.reject(new Error('a turn is already offered'));
    return new Promise((resolve) => {
      const turn = { prompt, handed: false };
      const settle = (done) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (this.turn === turn) this.turn = null;
        resolve(done);
      };
      const onAbort = () => settle(false);
      const timer = setTimeout(() => settle(false), timeoutMs);
      turn.settle = settle;
      this.turn = turn;
      if (signal?.aborted) return settle(false);
      signal?.addEventListener('abort', onAbort, { once: true });
      for (const wake of this.wakers) wake();
    });
  }

  // The session has replied: true if that finished the offered turn. A turn
  // not yet handed to the session is not its to finish.
  finishTurn() {
    if (!this.turn?.handed) return false;
    this.turn.settle(true);
    return true;
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
    const busy = this.busy();
    return unansweredChat(this.store.board).filter((m) => !this.delivered.has(m.id) && !busy.has(m.id));
  }

  #deliver(messages) {
    for (const m of messages) this.delivered.add(m.id);
    return messages;
  }

  // Resolves { messages, turn }: turn is { prompt } when the session's turn in
  // the agents' run has come, in which case there are no messages.
  waitForChat(timeoutMs) {
    this.waiting += 1;
    this.store.emit({ type: 'presence', attached: true });
    return new Promise((resolve) => {
      let done = false;
      const finish = (result) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        unsubscribe();
        this.wakers.delete(wake);
        this.waiting -= 1;
        this.lastSeen = Date.now();
        this.#scheduleDetachCheck();
        resolve(result);
      };
      const handOver = () => {
        if (this.turn && !this.turn.handed) {
          this.turn.handed = true;
          return finish({ messages: [], turn: { prompt: this.turn.prompt } });
        }
        // While a prune runs, the session is held: messages wait, and are handed over when it ends.
        if (this.store.pruning) return;
        const messages = this.#pending();
        if (messages.length) finish({ messages: this.#deliver(messages) });
      };
      const wake = () => handOver();
      let unsubscribe = () => {};
      const timer = setTimeout(() => finish({ messages: [] }), timeoutMs);
      this.wakers.add(wake);
      // A turn or messages already waiting are handed over at once; otherwise
      // wait for one. Only a message owed to Claude wakes the wait, the binary
      // finishing (a message it failed to answer is the session's now), or a prune ending.
      handOver();
      if (done) return;
      unsubscribe = this.store.subscribe((event) => {
        if ((event.type === 'board' && event.op === 'chat' && event.author === 'user') || (event.type === 'agent' && event.state === 'idle') || event.type === 'prune') handOver();
      });
    });
  }

  #scheduleDetachCheck() {
    clearTimeout(this.detachTimer);
    this.detachTimer = setTimeout(() => {
      if (this.attached()) return;
      // A turn the session never took is nobody's now.
      if (this.turn && !this.turn.handed) this.turn.settle('detached');
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

// `listTools` gives the tools/list answer (the server hides generate_image from a Claude that can't use it).
export function createMcpHandler(tools, { listTools = () => TOOLS } = {}) {
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
        return rpcResult(msg.id, { tools: listTools() });
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
