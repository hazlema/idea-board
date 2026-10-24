import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BoardStore } from '../lib/store.mjs';
import { Presence } from '../lib/mcp.mjs';
import { Library } from '../lib/colab/library.mjs';
import { ColabRun } from '../lib/colab/run.mjs';
import { Room } from '../lib/room.mjs';
import { createServer } from '../server.mjs';

// Runs `fn` against a real server on a temp board. It gets `rpc` (raw JSON-RPC
// to /mcp), `call` (a tool call parsed from its text block), `userOp` (the
// browser's op endpoint), the store and the agent nudges seen so far. `agent`
// overrides fields of the fake agent (it is connected through the binary by default).
// `pictures` is a function of (store, library) returning a PictureMaker for the MCP runner.
export async function withServer(fn, { graceMs, distDir, colab, agent: agentFields, pictures: makePictures } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-board-'));
  // The built page is dist/ in real use; tests get a tiny stand-in.
  if (!distDir) {
    distDir = path.join(dir, 'dist');
    fs.mkdirSync(distDir);
    fs.writeFileSync(path.join(distDir, 'index.html'), '<!doctype html><title>Idea board</title>');
  }
  const store = new BoardStore(path.join(dir, 'board.json'));
  const presence = new Presence(store, { graceMs: graceMs ?? 50 });
  const nudges = [];
  // A stand-in for the binary: its run turns say one line.
  const agent = { running: false, found: true, via: () => 'binary', nudge: () => nudges.push(Date.now()), takeTurn: async () => ({ ok: true, text: 'my turn' }), ...agentFields };
  // `colab` is a function of (store, presence, claude) returning a ColabRun, since it needs this store.
  // Without one, a run with no OpenRouter key, so only Claude can answer.
  const colabRun = colab?.(store, presence, agent) ?? new ColabRun({ store, presence, claude: agent, library: new Library(path.join(dir, 'colab.json')), openrouter: { hasKey: () => false, models: async () => [] } });
  const library = colabRun.library;
  const room = new Room({ store, agent, presence, colab: colabRun, library });
  const pictures = makePictures?.(store, library);
  const server = createServer({ store, agent, presence, colab: colabRun, room, pictures, port: 0, distDir });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  // createServer validated against port 0; rebuild with the real port.
  server.close();
  const real = createServer({ store, agent, presence, colab: colabRun, room, pictures, port, distDir });
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
    await fn({ base, colab: colabRun, room, agent, rpc, call, userOp, store, presence, nudges, port });
  } finally {
    real.close();
    store.historyLog.flush();
    fs.rmSync(dir, { recursive: true });
  }
}
