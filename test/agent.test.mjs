import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Agent, findOnPath } from '../lib/agent.mjs';
import { BoardStore } from '../lib/store.mjs';

// A stand-in for the claude CLI: waits a moment (so a message can arrive
// mid-run), then answers with the prompt it was given.
const FAKE_CLAUDE = `#!/usr/bin/env node
const prompt = process.argv[process.argv.indexOf('-p') + 1];
setTimeout(() => process.stdout.write(JSON.stringify({ result: 'answered: ' + prompt, session_id: 's_1' })), 150);
`;

test('a message sent while Claude is working is answered by a second run', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-board-'));
  try {
    const bin = path.join(dir, 'claude');
    fs.writeFileSync(bin, FAKE_CLAUDE, { mode: 0o755 });
    const store = new BoardStore(path.join(dir, 'board.json'));
    const presence = { attached: () => false };
    const agent = new Agent(store, presence, { mcpUrl: 'http://127.0.0.1:1/mcp', cwd: dir, claudeBin: bin, log: () => {} });

    // After Claude's first reply, the second message must still be waiting.
    const afterFirstReply = new Promise((resolve) => {
      const off = store.subscribe((event) => {
        if (event.type !== 'board' || event.op !== 'chat' || event.author !== 'claude') return;
        off?.();
        resolve(structuredClone(store.board.chat));
      });
    });
    const idleTwice = new Promise((resolve) => {
      let idle = 0;
      store.subscribe((event) => {
        if (event.type === 'agent' && event.state === 'idle' && ++idle === 2) resolve();
      });
    });

    store.apply({ type: 'chat', text: 'first question', owed: ['claude'] }, 'user');
    agent.nudge();
    assert.equal(agent.running, true);
    store.apply({ type: 'chat', text: 'second question', owed: ['claude'] }, 'user');
    agent.nudge();

    const chat = await afterFirstReply;
    assert.deepEqual(chat.map((m) => [m.role, m.owed?.length ?? 0]), [['user', 0], ['user', 1], ['claude', 0]]);
    assert.equal(chat[2].text, 'answered: first question');

    await idleTwice;
    const final = store.board.chat;
    assert.equal(final.at(-1).text, 'answered: second question');
    assert.ok(final.filter((m) => m.role === 'user').every((m) => m.owed.length === 0));
    store.historyLog.flush();
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

function setup(fake, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-board-'));
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(bin, fake, { mode: 0o755 });
  const store = new BoardStore(path.join(dir, 'board.json'));
  const agent = new Agent(store, { attached: () => false }, { mcpUrl: 'http://127.0.0.1:1/mcp', cwd: dir, claudeBin: bin, log: () => {}, ...opts });
  const idle = () => new Promise((resolve) => {
    const off = store.subscribe((event) => {
      if (event.type === 'agent' && event.state === 'idle') { off?.(); resolve(); }
    });
  });
  return { dir, store, agent, idle };
}

test('findOnPath finds an executable in PATH and not a missing one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-board-'));
  try {
    fs.writeFileSync(path.join(dir, 'claude'), '#!/bin/sh\n', { mode: 0o755 });
    assert.equal(findOnPath('claude', { PATH: dir }), true);
    assert.equal(findOnPath('nope', { PATH: dir }), false);
    assert.equal(findOnPath(path.join(dir, 'claude'), {}), true);
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test('nudge does nothing when the binary is missing', async () => {
  const { dir, store, agent } = setup(FAKE_CLAUDE, { found: false });
  try {
    const events = [];
    store.subscribe((event) => { if (event.type === 'agent') events.push(event); });
    store.apply({ type: 'chat', text: 'hello', owed: ['claude'] }, 'user');
    agent.nudge();
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(events, []);
    assert.equal(agent.via(), 'none');
    store.historyLog.flush();
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test('a reply already answered by a session is dropped', async () => {
  const { dir, store, agent, idle } = setup(FAKE_CLAUDE);
  try {
    store.apply({ type: 'chat', text: 'question', owed: ['claude'] }, 'user');
    const done = idle();
    agent.nudge();
    store.apply({ type: 'chat', text: 'session answer' }, 'claude');
    await done;
    const replies = store.board.chat.filter((m) => m.role === 'claude');
    assert.deepEqual(replies.map((m) => m.text), ['session answer']);
    store.historyLog.flush();
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test('the role text is appended to the system prompt', async () => {
  const echo = `#!/usr/bin/env node
const sys = process.argv[process.argv.indexOf('--append-system-prompt') + 1];
process.stdout.write(JSON.stringify({ result: sys, session_id: 's_1' }));
`;
  const { dir, store, agent, idle } = setup(echo, { role: () => 'Be the Foreman.' });
  try {
    store.apply({ type: 'chat', text: 'hi', owed: ['claude'] }, 'user');
    const done = idle();
    agent.nudge();
    await done;
    const text = store.board.chat.find((m) => m.role === 'claude').text;
    assert.ok(text.includes('Your role on this board:'));
    assert.ok(text.includes('Be the Foreman.'));
    store.historyLog.flush();
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test('takeTurn returns the text and posts nothing', async () => {
  const { dir, store, agent } = setup(FAKE_CLAUDE);
  try {
    const before = store.board.chat.length;
    assert.deepEqual(await agent.takeTurn('your turn', { timeoutMs: 5000 }), { ok: true, text: 'answered: your turn' });
    assert.equal(store.board.chat.length, before);
    assert.equal(agent.running, false);
    store.historyLog.flush();
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

const SLOW_CLAUDE = `#!/usr/bin/env node
setTimeout(() => process.stdout.write(JSON.stringify({ result: 'late', session_id: 's_1' })), 5000);
`;

test('aborting the signal kills the turn', async () => {
  const { dir, store, agent } = setup(SLOW_CLAUDE);
  try {
    const ctl = new AbortController();
    const started = Date.now();
    const turn = agent.takeTurn('x', { timeoutMs: 10000, signal: ctl.signal });
    setTimeout(() => ctl.abort(), 100);
    const result = await turn;
    assert.equal(result.ok, false);
    assert.ok(Date.now() - started < 3000);
    store.historyLog.flush();
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test('takeTurn honors timeoutMs, retry included', async () => {
  const { dir, store, agent } = setup(SLOW_CLAUDE);
  try {
    store.setSessionId('old');
    const started = Date.now();
    const result = await agent.takeTurn('x', { timeoutMs: 300 });
    assert.equal(result.ok, false);
    assert.ok(Date.now() - started < 1500);
    store.historyLog.flush();
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test('a message nudged during a turn is answered after the turn', async () => {
  const { dir, store, agent } = setup(FAKE_CLAUDE);
  try {
    const idle = new Promise((resolve) => {
      let n = 0;
      store.subscribe((event) => { if (event.type === 'agent' && event.state === 'idle' && ++n === 2) resolve(); });
    });
    const turn = agent.takeTurn('turn', { timeoutMs: 5000 });
    store.apply({ type: 'chat', text: 'during', owed: ['claude'] }, 'user');
    agent.nudge();
    assert.equal((await turn).ok, true);
    await idle;
    assert.equal(store.board.chat.at(-1).text, 'answered: during');
    store.historyLog.flush();
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test('a turn waits for a run in flight', async () => {
  const { dir, store, agent } = setup(FAKE_CLAUDE);
  try {
    store.apply({ type: 'chat', text: 'q', owed: ['claude'] }, 'user');
    agent.nudge();
    const started = Date.now();
    const result = await agent.takeTurn('t', { timeoutMs: 5000 });
    assert.equal(result.text, 'answered: t');
    assert.ok(Date.now() - started >= 250);
    assert.equal(store.board.chat.at(-1).text, 'answered: q');
    store.historyLog.flush();
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});
