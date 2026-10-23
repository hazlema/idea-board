import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BoardStore } from '../lib/store.mjs';
import { Presence } from '../lib/mcp.mjs';
import { createServer } from '../server.mjs';

// Runs `fn` against a real server on a temp board. It gets `rpc` (raw JSON-RPC
// to /mcp), `call` (a tool call parsed from its text block), `userOp` (the
// browser's op endpoint), the store and the agent nudges seen so far.
export async function withServer(fn, { graceMs } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-board-'));
  const store = new BoardStore(path.join(dir, 'board.json'));
  const presence = new Presence(store, { graceMs: graceMs ?? 50 });
  const nudges = [];
  const agent = { running: false, nudge: () => nudges.push(Date.now()) };
  const server = createServer({ store, agent, presence, port: 0 });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  // createServer validated against port 0; rebuild with the real port.
  server.close();
  const real = createServer({ store, agent, presence, port });
  await new Promise((resolve) => real.listen(port, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${port}`;
  let rpcId = 0;
  const rpc = async (method, params) => {
    const res = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) });
    return res.json();
  };
  const call = async (name, args) => {
    const reply = await rpc('tools/call', { name, arguments: args });
    const text = reply.result.content[0].text;
    return reply.result.isError ? { error: text } : JSON.parse(text);
  };
  const userOp = (op, headers = {}) => fetch(`${base}/api/op`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ op }) });
  try {
    await fn({ base, rpc, call, userOp, store, nudges, port });
  } finally {
    real.close();
    store.historyLog.flush();
    fs.rmSync(dir, { recursive: true });
  }
}
