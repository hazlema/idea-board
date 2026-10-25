// The server's own wiring (connect, as main uses it) with a fake claude binary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BoardStore } from '../lib/store.mjs';
import { Presence, createToolRunner } from '../lib/mcp.mjs';
import { Library } from '../lib/colab/library.mjs';
import { connect } from '../server.mjs';

// A stand-in for the claude CLI that notes each start in `spawns`, then either
// fails at once or answers with its prompt after `delayMs`.
const fakeClaude = (spawns, { fail = false, delayMs = 0 } = {}) => `#!/usr/bin/env node
require('node:fs').appendFileSync(${JSON.stringify(spawns)}, 'x\\n');
const prompt = require('node:fs').readFileSync(0, 'utf8');
${fail ? 'process.exit(1);' : `setTimeout(() => process.stdout.write(JSON.stringify({ result: 'answered: ' + prompt, session_id: 's_1' })), ${delayMs});`}
`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function setup(fake, { before } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-board-'));
  const spawns = path.join(dir, 'spawns');
  const bin = path.join(dir, 'claude.cjs');
  fs.writeFileSync(bin, fakeClaude(spawns, fake), { mode: 0o755 });
  const file = path.join(dir, 'board.json');
  if (before) {
    const earlier = new BoardStore(file);
    before(earlier);
    earlier.historyLog.flush();
  }
  const store = new BoardStore(file);
  const presence = new Presence(store, { graceMs: 50 });
  const library = new Library(path.join(dir, 'colab.json'));
  const openrouter = { hasKey: () => false, models: async () => [] };
  const wired = connect({ store, presence, library, openrouter, agent: { mcpUrl: 'http://127.0.0.1:1/mcp', cwd: dir, claudeBin: bin, log: () => {} } });
  const spawned = () => (fs.existsSync(spawns) ? fs.readFileSync(spawns, 'utf8').split('\n').filter(Boolean).length : 0);
  const done = async () => {
    // Bounded, so a binary started over and over still lets the test end.
    for (let i = 0; wired.agent.running && i < 20; i += 1) await wired.agent.current;
    await wired.colab.settled();
    store.historyLog.flush();
    fs.rmSync(dir, { recursive: true });
  };
  return { store, presence, spawned, done, ...wired };
}

test('a failing claude binary runs once per user message, not in a loop', async () => {
  const { room, spawned, done } = setup({ fail: true });
  try {
    room.userChat({ text: 'hello' });
    await sleep(1000);
    assert.ok(spawned() >= 1 && spawned() <= 2, `spawned ${spawned()} times`);
  } finally {
    await done();
  }
});

test('starting up with old owed messages does not run the binary', async () => {
  const { spawned, store, done } = setup({}, { before: (s) => s.apply({ type: 'chat', text: 'from before the restart', owed: ['claude'] }, 'user') });
  try {
    await sleep(500);
    assert.equal(spawned(), 0);
    assert.ok(store.board.chat[0].owed.includes('claude'));
  } finally {
    await done();
  }
});

test('a session attaching while the binary answers is not handed the same message', async () => {
  const { room, store, presence, done } = setup({ delayMs: 2000 });
  try {
    room.userChat({ text: 'm1' });
    const tools = createToolRunner(store, presence);
    const result = await tools.call('wait_for_chat', { timeout_seconds: 1 });
    assert.deepEqual(result.messages, []);
  } finally {
    await done();
  }
});

test('/stop during a run does not cut a plain answer already in flight', async () => {
  const { room, store, colab, done } = setup({ delayMs: 600 });
  try {
    const { message } = room.userChat({ text: 'm1' });
    room.userChat({ text: '/start plan the heist' });
    await sleep(100);
    room.userChat({ text: '/stop' });
    await colab.finished;
    const until = Date.now() + 3000;
    while (store.board.chat.find((m) => m.id === message.id).owed.length && Date.now() < until) await sleep(50);
    const answer = store.board.chat.find((m) => m.role === 'claude' && m.text === 'answered: m1');
    assert.ok(answer, store.board.chat.map((m) => m.text).join(' | '));
  } finally {
    await done();
  }
});
