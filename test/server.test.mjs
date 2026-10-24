import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { withServer } from './helpers.mjs';
import { browserCommand } from '../server.mjs';
import { Library } from '../lib/colab/library.mjs';
import { ColabRun } from '../lib/colab/run.mjs';

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
  assert.equal(view.flowchart.nodes.length, 2);
  assert.deepEqual(view.flowchart.connections, [{ id: view.flowchart.connections[0].id, from: root.id, to: child.id, label: 'costs' }]);
  const { board } = await (await fetch(`${base}/api/board`)).json();
  assert.ok(board.flow.nodes.every((n) => n.author === 'claude'));
  const detail = await call('get_node', { id: root.id });
  assert.equal(detail.outgoing[0].to_title, 'Soul tax');
  const bad = await call('get_node', { id: 'missing' });
  assert.match(bad.error, /no node/);
}));

test('user chat nudges the agent; Claude reply answers it', () => withServer(async ({ userOp, call, nudges }) => {
  await userOp({ type: 'chat', text: 'add a mana system', owed: ['claude'] });
  assert.equal(nudges.length, 1);
  assert.equal((await call('view_board', {})).unanswered_chat.length, 1);
  await call('reply', { text: 'Added.' });
  assert.equal((await call('view_board', {})).unanswered_chat.length, 0);
}));

test('wait_for_chat long-polls until the user writes', () => withServer(async ({ call, userOp }) => {
  const waiting = call('wait_for_chat', { timeout_seconds: 5 });
  await new Promise((r) => setTimeout(r, 100));
  await userOp({ type: 'chat', text: 'hello from the board', owed: ['claude'] });
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

test('static files are served and path traversal is blocked', () => withServer(async ({ base, store }) => {
  // Sits beside dist/, so only the traversal check keeps it private.
  fs.writeFileSync(path.join(path.dirname(store.file), 'secret.txt'), 'private');
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Idea board/);
  const status = await new Promise((resolve) => {
    http.get(`${base}/..%2fsecret.txt`, (res) => { res.resume(); resolve(res.statusCode); });
  });
  assert.equal(status, 404);
}));

test('the server explains how to build when dist is missing', async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-board-dist-'));
  try {
    await withServer(async ({ base }) => {
      const page = await fetch(`${base}/`);
      assert.equal(page.status, 503);
      assert.match(await page.text(), /Idea board is not built yet\. Run: npm install && npm run build/);
    }, { distDir: empty });
  } finally {
    fs.rmSync(empty, { recursive: true });
  }
});

test('Claude sees the brief first and can add to it', () => withServer(async ({ call, userOp, store }) => {
  const [section] = store.board.brief.sections;
  await userOp({ type: 'updateSection', id: section.id, text: 'A deck-building warlock game' });
  const added = await call('add_brief_section', { title: 'Decided', text: 'No permadeath' });
  const view = await call('view_board', {});
  assert.deepEqual(Object.keys(view).slice(0, 2), ['title', 'brief']);
  assert.equal(view.brief[0].text, 'A deck-building warlock game');
  assert.equal(view.brief[1].id, added.id);
  assert.equal(view.brief[1].text, 'No permadeath');
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

test('versions endpoints save, list, preview and restore', () => withServer(async ({ base, userOp }) => {
  const post = (url, body) => fetch(`${base}${url}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  assert.equal((await post('/api/versions', { name: '  ' })).status, 400);
  await userOp({ type: 'addObject', kind: 'note', text: 'keep me' });
  const { version } = await (await post('/api/versions', { name: 'before' })).json();
  assert.equal(version.name, 'before');
  assert.equal(version.stats.notes, 1);
  await userOp({ type: 'addObject', kind: 'note', text: 'extra' });
  const { versions } = await (await fetch(`${base}/api/versions`)).json();
  assert.deepEqual(versions.map((v) => v.id), [version.id]);
  const preview = await (await fetch(`${base}/api/versions/${version.id}`)).json();
  assert.equal(preview.meta.id, version.id);
  assert.equal(preview.content.brainstorm.pages[0].objects.length, 1);
  const restored = await post(`/api/versions/${version.id}/restore`);
  assert.equal(restored.status, 200);
  const body = await restored.json();
  assert.equal(body.backup.auto, true);
  const { board } = await (await fetch(`${base}/api/board`)).json();
  assert.equal(board.brainstorm.pages[0].objects.length, 1);
  for (const id of ['v_20200101-000000_abcd', '..%2Fboard', 'nope']) {
    assert.equal((await fetch(`${base}/api/versions/${id}`)).status, 404, id);
    assert.equal((await post(`/api/versions/${id}/restore`)).status, 404, id);
  }
}));

test('export endpoint writes the design doc and returns its path', () => withServer(async ({ base, userOp, store }) => {
  await userOp({ type: 'addObject', kind: 'note', text: 'exported note' });
  const res = await fetch(`${base}/api/export`, { method: 'POST' });
  assert.equal(res.status, 200);
  const { path: file } = await res.json();
  assert.equal(file, store.paths.design);
  assert.match(fs.readFileSync(file, 'utf8'), /> exported note/);
  const blocked = await fetch(`${base}/api/export`, { method: 'POST', headers: { origin: 'http://evil.example' } });
  assert.equal(blocked.status, 403);
}));

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const ASSET_NAME = /^[0-9a-f]{32}\.png$/;

// A tiny picture host on 127.0.0.1: /pic.png is an image, /page is HTML.
async function withPictureHost(fn) {
  const host = http.createServer((req, res) => {
    if (req.url === '/pic.png') { res.writeHead(200, { 'content-type': 'image/png' }); res.end(PNG); }
    else if (req.url === '/page') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html></html>'); }
  });
  await new Promise((resolve) => host.listen(0, '127.0.0.1', resolve));
  try { await fn(`http://127.0.0.1:${host.address().port}`); } finally { host.closeAllConnections(); host.close(); }
}

test('the server refuses a 40 MB upload and serves stored pictures safely', () => withServer(async ({ base, store }) => {
  const big = await fetch(`${base}/api/assets`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: Buffer.alloc(40 * 1024 * 1024) });
  assert.equal(big.status, 413);
  assert.match((await big.json()).error, /30 MB/);
  assert.equal(fs.existsSync(store.paths.assets), false);

  const notImage = await fetch(`${base}/api/assets`, { method: 'POST', body: Buffer.from('%PDF-1.4') });
  assert.equal(notImage.status, 400);
  assert.match((await notImage.json()).error, /not an image/);

  const up = await fetch(`${base}/api/assets`, { method: 'POST', headers: { 'content-type': 'image/png' }, body: PNG });
  assert.equal(up.status, 200);
  const { asset } = await up.json();
  assert.match(asset, ASSET_NAME);

  const got = await fetch(`${base}/assets/${asset}`);
  assert.equal(got.status, 200);
  assert.equal(got.headers.get('content-type'), 'image/png');
  assert.equal(got.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(got.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.deepEqual(Buffer.from(await got.arrayBuffer()), PNG);

  fs.writeFileSync(path.join(store.paths.assets, 'evil.svg'), '<svg/>');
  for (const bad of ['../board.json', '..%2Fboard.json', '%2e%2e/board.json', 'evil.svg', `${'0'.repeat(32)}.png/`]) {
    const res = await fetch(`${base}/assets/${bad}`);
    assert.ok([400, 404].includes(res.status), `${bad} -> ${res.status}`);
  }
  assert.equal((await fetch(`${base}/assets/evil.svg`)).status, 400);
  assert.equal((await fetch(`${base}/assets/${'0'.repeat(32)}.png`)).status, 404);
}));

test('POST /api/assets/url fetches a picture and reports failures as 400', () => withPictureHost((pics) => withServer(async ({ base }) => {
  const post = (url) => fetch(`${base}/api/assets/url`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url }) });
  const ok = await post(`${pics}/pic.png`);
  assert.equal(ok.status, 200);
  assert.match((await ok.json()).asset, ASSET_NAME);
  const html = await post(`${pics}/page`);
  assert.equal(html.status, 400);
  assert.match((await html.json()).error, /not an image/);
  assert.equal((await post(undefined)).status, 400);
  assert.equal((await post('file:///etc/passwd')).status, 400);
})));

test('asset routes keep the Host and Origin checks', () => withServer(async ({ base }) => {
  const res = await fetch(`${base}/api/assets`, { method: 'POST', headers: { origin: 'http://evil.example' }, body: PNG });
  assert.equal(res.status, 403);
}));

test('the browser opens with each platform\'s own command', () => {
  const url = 'http://127.0.0.1:4777';
  assert.deepEqual(browserCommand('darwin', url), { command: 'open', args: [url] });
  assert.deepEqual(browserCommand('win32', url), { command: 'cmd', args: ['/c', 'start', '', url] });
  assert.deepEqual(browserCommand('linux', url), { command: 'xdg-open', args: [url] });
});

// A real ColabRun on the test's store, with a fake OpenRouter that never touches the network.
const SECRET = 'sk-or-test-secret-123';
function colabFor({ key = SECRET, complete = async () => ({ message: { role: 'assistant', content: 'hello' }, cost: 0.1 }), models } = {}) {
  const calls = [];
  const factory = (store, presence) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-board-lib-'));
    const openrouter = { hasKey: () => Boolean(key), models: models ?? (async () => [{ id: 'acme/alpha-one' }]), complete: async (req) => { calls.push(req); return complete(req); } };
    return new ColabRun({ store, presence, library: new Library(path.join(dir, 'colab.json')), openrouter });
  };
  return { factory, calls };
}
const LINEUP = { type: 'setColabLineup', agents: [{ model: 'acme/alpha-one', roleId: 'creative' }], rounds: 2, budget: 1 };
const post = (base, route, body) => fetch(`${base}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });

test('GET /api/colab reports hasKey and never the key itself', async () => {
  const { factory } = colabFor();
  await withServer(async ({ base }) => {
    const text = await (await fetch(`${base}/api/colab`)).text();
    assert.ok(!text.includes(SECRET));
    const body = JSON.parse(text);
    assert.equal(body.hasKey, true);
    assert.equal(body.status.state, 'idle');
    assert.ok(body.library.roles.length > 0);
    const models = await (await fetch(`${base}/api/colab/models`)).text();
    assert.ok(!models.includes(SECRET));
  }, { colab: factory });
  const none = colabFor({ key: null });
  await withServer(async ({ base }) => {
    assert.equal((await (await fetch(`${base}/api/colab`)).json()).hasKey, false);
    assert.equal((await post(base, '/api/colab/start')).status, 400);
  }, { colab: none.factory });
});

test('models failure answers 502', async () => {
  const { factory } = colabFor({ models: async () => { throw new Error('offline'); } });
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/api/colab/models`);
    assert.equal(res.status, 502);
    assert.equal((await res.json()).error, 'offline');
  }, { colab: factory });
});

test('setColabLineup saves, is not in history, and rejects bad numbers', async () => {
  const { factory } = colabFor();
  await withServer(async ({ base, userOp, store }) => {
    assert.equal((await userOp(LINEUP)).status, 200);
    assert.deepEqual(store.board.colab.lineup, { agents: [{ model: 'acme/alpha-one', roleId: 'creative' }], rounds: 2, budget: 1, turnLimit: 30, claudeRoleId: 'foreman' });
    assert.equal((await userOp({ ...LINEUP, turnLimit: 45 })).status, 200);
    assert.equal(store.board.colab.lineup.turnLimit, 45);
    assert.equal((await userOp({ type: 'setColabExtras', rules: 'be kind', roles: { creative: 'wild' } })).status, 200);
    assert.equal(store.board.colab.extras.rules, 'be kind');
    assert.equal((await (await fetch(`${base}/api/history`)).json()).entries.length, 0);
    assert.equal((await userOp({ ...LINEUP, rounds: 51 })).status, 400);
    assert.equal((await userOp({ ...LINEUP, budget: 0.01 })).status, 400);
    assert.equal((await userOp({ ...LINEUP, turnLimit: 0 })).status, 400);
    assert.equal((await userOp({ ...LINEUP, turnLimit: 121 })).status, 400);
    assert.equal((await userOp({ ...LINEUP, turnLimit: 2.5 })).status, 400);
    assert.equal((await userOp({ ...LINEUP, agents: Array(9).fill(LINEUP.agents[0]) })).status, 400);
  }, { colab: factory });
});

test('a line-up with an empty model saves, but cannot start', async () => {
  const { factory } = colabFor();
  await withServer(async ({ base, userOp, store }) => {
    const agents = [LINEUP.agents[0], { model: '', roleId: 'creative' }];
    assert.equal((await userOp({ ...LINEUP, agents })).status, 200);
    assert.equal(store.board.colab.lineup.agents[1].model, '');
    const res = await post(base, '/api/colab/start');
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /Agent 2 has no model/);
  }, { colab: factory });
});

test('the library round-trips and rejects duplicate role ids', async () => {
  const { factory } = colabFor();
  await withServer(async ({ base }) => {
    const put = (body) => fetch(`${base}/api/colab/library`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const lib = { rules: 'r', roles: [{ id: 'a', name: 'A', job: 'j' }] };
    assert.equal((await put(lib)).status, 200);
    assert.deepEqual((await (await fetch(`${base}/api/colab`)).json()).library, lib);
    assert.equal((await put({ rules: 'r', roles: [lib.roles[0], lib.roles[0]] })).status, 400);
  }, { colab: factory });
});

test('a waiting run refuses a new line-up and a second start; a user chat starts round 1', async () => {
  const { factory, calls } = colabFor();
  await withServer(async ({ base, userOp, colab }) => {
    await userOp(LINEUP);
    assert.equal((await post(base, '/api/colab/start')).status, 200);
    assert.equal((await post(base, '/api/colab/start')).status, 409);
    assert.equal((await userOp(LINEUP)).status, 409);
    assert.equal(calls.length, 0);
    await userOp({ type: 'chat', text: 'go' });
    await colab.finished;
    assert.ok(calls.length > 0);
    assert.equal(colab.status.state, 'idle');
  }, { colab: factory });
});

test('start with an empty line-up is 400 and stop returns idle', async () => {
  const { factory } = colabFor();
  await withServer(async ({ base }) => {
    assert.equal((await post(base, '/api/colab/start')).status, 400);
    await post(base, '/api/colab/stop');
    assert.equal((await (await fetch(`${base}/api/colab`)).json()).status.state, 'idle');
  }, { colab: factory });
});

test('a new event stream starts with the board and the current run status', async () => {
  const { factory } = colabFor();
  await withServer(async ({ base }) => {
    const ctl = new AbortController();
    const res = await fetch(`${base}/api/events`, { signal: ctl.signal });
    const reader = res.body.getReader();
    let seen = '';
    while (!seen.includes('"type":"colab"')) seen += new TextDecoder().decode((await reader.read()).value);
    ctl.abort();
    const events = seen.split('\n\n').filter((c) => c.startsWith('data: ')).map((c) => JSON.parse(c.slice(6)));
    assert.deepEqual(events.map((e) => e.type), ['board', 'colab']);
    assert.equal(events[1].status.state, 'idle');
  }, { colab: factory });
});

test('start without a key does not tell the host to restart', async () => {
  const none = colabFor({ key: null });
  await withServer(async ({ base }) => {
    const body = await (await post(base, '/api/colab/start')).json();
    assert.doesNotMatch(body.error, /restart/);
  }, { colab: none.factory });
});
