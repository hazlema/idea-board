import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BoardStore } from '../lib/store.mjs';
import { Presence } from '../lib/mcp.mjs';
import { createServer } from '../server.mjs';

async function withServer(fn, { graceMs } = {}) {
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

test('MCP initialize and tools/list', () => withServer(async ({ rpc }) => {
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.ok(init.result.capabilities.tools);
  const list = await rpc('tools/list', {});
  const names = list.result.tools.map((t) => t.name);
  for (const name of ['view_board', 'get_node', 'add_node', 'update_node', 'delete_node', 'connect', 'disconnect', 'reply', 'wait_for_chat']) assert.ok(names.includes(name), name);
}));

test('Claude edits through MCP show up for the user, attributed to Claude', () => withServer(async ({ call, base }) => {
  const root = await call('add_node', { title: 'Warlock pact', props: { theme: 'debt' } });
  const child = await call('add_node', { title: 'Soul tax', connect_from: root.id, edge_label: 'costs' });
  await call('update_node', { id: child.id, set_props: { rate: '10%' } });
  const view = await call('view_board', {});
  assert.equal(view.nodes.length, 2);
  assert.deepEqual(view.connections, [{ from: root.id, to: child.id, label: 'costs' }]);
  const { board } = await (await fetch(`${base}/api/board`)).json();
  assert.ok(board.flow.nodes.every((n) => n.author === 'claude'));
  const detail = await call('get_node', { id: root.id });
  assert.equal(detail.outgoing[0].to_title, 'Soul tax');
  const bad = await call('get_node', { id: 'missing' });
  assert.match(bad.error, /no node/);
}));

test('user chat nudges the agent; Claude reply answers it', () => withServer(async ({ userOp, call, nudges }) => {
  await userOp({ type: 'chat', text: 'add a mana system' });
  assert.equal(nudges.length, 1);
  assert.equal((await call('view_board', {})).unanswered_chat.length, 1);
  await call('reply', { text: 'Added.' });
  assert.equal((await call('view_board', {})).unanswered_chat.length, 0);
}));

test('wait_for_chat long-polls until the user writes', () => withServer(async ({ call, userOp }) => {
  const waiting = call('wait_for_chat', { timeout_seconds: 5 });
  await new Promise((r) => setTimeout(r, 100));
  await userOp({ type: 'chat', text: 'hello from the board' });
  const result = await waiting;
  assert.equal(result.messages[0].text, 'hello from the board');
  // Already delivered messages are not handed out twice.
  const again = await call('wait_for_chat', { timeout_seconds: 1 });
  assert.equal(again.messages.length, 0);
}));

test('cross-site requests and foreign Host headers are refused', () => withServer(async ({ userOp, base, port, store }) => {
  const evil = await userOp({ type: 'chat', text: 'pwned' }, { origin: 'https://evil.example' });
  assert.equal(evil.status, 403);
  const ok = await userOp({ type: 'addNode', title: 'Fine', x: 0, y: 0 }, { origin: `http://127.0.0.1:${port}` });
  assert.equal(ok.status, 200);
  const http = await import('node:http');
  const status = await new Promise((resolve) => {
    http.get(`${base}/api/board`, { headers: { host: `attacker.example:${port}` } }, (res) => { res.resume(); resolve(res.statusCode); });
  });
  assert.equal(status, 403);
  assert.equal(store.board.chat.length, 0);
}));

test('static files are served and path traversal is blocked', () => withServer(async ({ base }) => {
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Idea board/);
  const http = await import('node:http');
  const status = await new Promise((resolve) => {
    http.get(`${base}/..%2fpackage.json`, (res) => { res.resume(); resolve(res.statusCode); });
  });
  assert.equal(status, 404);
}));

test('Claude sees the brief first and can add to it', () => withServer(async ({ call, userOp, store }) => {
  const [section] = store.board.brief.sections;
  await userOp({ type: 'updateSection', id: section.id, text: 'A deck-building warlock game' });
  const added = await call('add_brief_section', { title: 'Decided', text: 'No permadeath' });
  const view = await call('view_board', {});
  assert.deepEqual(Object.keys(view).slice(0, 2), ['title', 'brief']);
  assert.equal(view.brief[0].text, 'A deck-building warlock game');
  assert.equal(view.brief[1].id, added.id);
  assert.equal(view.brief[1].last_edited_by, 'claude');
}));

test('history endpoint lists newest first with undone flags', () => withServer(async ({ base, userOp, call, store }) => {
  const post = (route, body) => fetch(`${base}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  const history = async (query = '') => (await (await fetch(`${base}/api/history${query}`)).json()).entries;
  await userOp({ type: 'addNode', title: 'One', x: 0, y: 0 });
  await userOp({ type: 'addNode', title: 'Two', x: 0, y: 100 });
  const undo = await post('/api/undo');
  assert.equal(undo.status, 200);
  assert.equal((await undo.json()).undone.summary, 'added card “Two”');
  const entries = await history();
  assert.equal(entries[0].kind, 'undo');
  assert.equal(entries.find((e) => e.summary === 'added card “Two”').undone, true);
  assert.equal(entries.find((e) => e.summary === 'added card “One”').undone, false);
  assert.deepEqual((await history('?limit=1&before=3')).map((e) => e.seq), [2]);
  assert.equal((await post('/api/redo')).status, 200);
  assert.deepEqual(store.board.flow.nodes.map((n) => n.title), ['One', 'Two']);

  const added = await call('add_node', { title: 'From Claude' });
  const [claudeRow] = await history();
  assert.match(claudeRow.turn, /^t_/);
  const undoTurn = await post('/api/undo-turn', { turn: claudeRow.turn });
  assert.deepEqual(await undoTurn.json(), { undone: 1, skipped: [] });
  assert.ok(!store.board.flow.nodes.some((n) => n.id === added.id));
  assert.equal((await post('/api/undo-turn', {})).status, 400);
  assert.equal((await fetch(`${base}/api/history?limit=abc`)).status, 400);
}));
