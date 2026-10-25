import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Agent, findOnPath } from '../lib/agent.mjs';
import { BoardStore } from '../lib/store.mjs';
import { Pruner } from '../lib/prune.mjs';
import { boardView } from '../lib/mcp-tools.mjs';

// A stand-in for the claude CLI: waits a moment (so a message can arrive
// mid-run), then answers with the prompt it was given.
const FAKE_CLAUDE = `#!/usr/bin/env node
const prompt = require('node:fs').readFileSync(0, 'utf8');
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
    assert.ok(Date.now() - started < 700);
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

// Answers after 2 s: a plain answer still going when a run turn comes.
const ANSWERING_CLAUDE = `#!/usr/bin/env node
const prompt = require('node:fs').readFileSync(0, 'utf8');
setTimeout(() => process.stdout.write(JSON.stringify({ result: 'answered: ' + prompt, session_id: 's_1' })), 2000);
`;

test('Stop ends a turn still waiting for an answer in flight, and the answer goes on', async () => {
  const { dir, store, agent, idle } = setup(ANSWERING_CLAUDE);
  try {
    store.apply({ type: 'chat', text: 'q', owed: ['claude'] }, 'user');
    const answered = idle();
    agent.nudge();
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 50);
    const started = Date.now();
    const result = await agent.takeTurn('t', { timeoutMs: 10_000, signal: ctl.signal });
    assert.deepEqual(result, { ok: false, error: 'stopped' });
    assert.ok(Date.now() - started < 200, `took ${Date.now() - started} ms`);
    await answered;
    assert.equal(store.board.chat.at(-1).text, 'answered: q');
    store.historyLog.flush();
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test('the turn limit counts the wait for an answer in flight', async () => {
  const { dir, store, agent, idle } = setup(ANSWERING_CLAUDE);
  try {
    store.apply({ type: 'chat', text: 'q', owed: ['claude'] }, 'user');
    const answered = idle();
    agent.nudge();
    const started = Date.now();
    const result = await agent.takeTurn('t', { timeoutMs: 300 });
    assert.deepEqual(result, { ok: false, error: 'out of time' });
    assert.ok(Date.now() - started < 500, `took ${Date.now() - started} ms`);
    await answered;
    store.historyLog.flush();
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test('two turns at once run one after the other', async () => {
  const { dir, store, agent } = setup(FAKE_CLAUDE);
  try {
    const order = [];
    const first = agent.takeTurn('one', { timeoutMs: 5000 }).then((r) => { order.push(r.text); return r; });
    const second = agent.takeTurn('two', { timeoutMs: 5000 }).then((r) => { order.push(r.text); return r; });
    const results = await Promise.all([first, second]);
    assert.ok(results.every((r) => r.ok));
    assert.deepEqual(order, ['answered: one', 'answered: two']);
    assert.equal(agent.running, false);
    store.historyLog.flush();
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

const KEY_RULE = 'Read(~/.config/openrouter/**)';

test('chat answers and turns may read files in the board folder; the key folder is denied', async () => {
  const echo = `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ result: JSON.stringify(process.argv.slice(2)), session_id: 's_1' }));
`;
  const { dir, store, agent } = setup(echo, { canMakePictures: () => true });
  try {
    const argv = JSON.parse((await agent.takeTurn('go', { timeoutMs: 5000 })).text);
    assert.equal(argv[argv.indexOf('--tools') + 1], 'Read,Glob,Grep');
    assert.equal(argv[argv.indexOf('--allowedTools') + 1], 'mcp__board');
    assert.equal(argv[argv.indexOf('--permission-mode') + 1], 'dontAsk');
    assert.equal(argv[argv.indexOf('--disallowedTools') + 1], KEY_RULE);
    store.historyLog.flush();
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test("the binary gets --disallowedTools for generate_image without the permission, and the board's model", async () => {
  const echo = `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ result: JSON.stringify(process.argv.slice(2)), session_id: 's_1' }));
`;
  let allowed = false;
  const { dir, store, agent } = setup(echo, { canMakePictures: () => allowed, model: () => 'opus' });
  try {
    const argvOf = async () => JSON.parse((await agent.takeTurn('go', { timeoutMs: 5000 })).text);
    const denied = await argvOf();
    assert.equal(denied[denied.indexOf('--disallowedTools') + 1], `${KEY_RULE},mcp__board__generate_image`);
    assert.equal(denied[denied.indexOf('--model') + 1], 'opus');
    allowed = true;
    const granted = await argvOf();
    assert.equal(granted[granted.indexOf('--disallowedTools') + 1], KEY_RULE);
    assert.equal(granted[granted.indexOf('--model') + 1], 'opus');
    store.historyLog.flush();
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test('no --model when the model is empty; a string model still works', async () => {
  const echo = `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ result: JSON.stringify(process.argv.slice(2)), session_id: 's_1' }));
`;
  for (const [model, expected] of [[() => '', null], ['haiku', 'haiku']]) {
    const { dir, store, agent } = setup(echo, { model });
    try {
      const argv = JSON.parse((await agent.takeTurn('go', { timeoutMs: 5000 })).text);
      assert.equal(argv.includes('--model') ? argv[argv.indexOf('--model') + 1] : null, expected);
      store.historyLog.flush();
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  }
});

test('the binary starting a run tells onRunStart', async () => {
  const echo = `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ result: 'ok', session_id: 's_1' }));
`;
  let starts = 0;
  const { dir, store, agent } = setup(echo, { onRunStart: () => (starts += 1) });
  try {
    await agent.takeTurn('go', { timeoutMs: 5000 });
    assert.equal(starts, 1);
    store.historyLog.flush();
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test('the prompt goes to claude on stdin, not as an argument', async () => {
  const echo = `#!/usr/bin/env node
const prompt = require('node:fs').readFileSync(0, 'utf8');
process.stdout.write(JSON.stringify({ result: JSON.stringify({ argv: process.argv.slice(2), prompt }), session_id: 's_1' }));
`;
  const { dir, store, agent } = setup(echo);
  try {
    const big = 'x'.repeat(200_000);
    const got = JSON.parse((await agent.takeTurn(big, { timeoutMs: 10_000 })).text);
    assert.equal(got.prompt, big);
    assert.equal(got.argv[0], '-p');
    assert.equal(got.argv[1], '--output-format');
    assert.ok(!got.argv.some((a) => a.length > 50_000));
    store.historyLog.flush();
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test('prune runs a fresh session with its own system prompt and without the chat tools', async () => {
  const echo = `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ result: JSON.stringify(process.argv.slice(2)), session_id: 's_new' }));
`;
  const { dir, store, agent, idle } = setup(echo);
  try {
    store.setSessionId('chat-session');
    const done = idle();
    let token = null;
    const result = await agent.prune('tidy', { systemPrompt: 'You prune.', timeoutMs: 5000, onStart: (t) => { token = t; } });
    await done;
    assert.equal(result.ok, true);
    const argv = JSON.parse(result.text);
    // The pass reaches the board with its own token, so the server knows its calls.
    assert.match(token, /^[0-9a-f-]{36}$/);
    const config = JSON.parse(argv[argv.indexOf('--mcp-config') + 1]);
    assert.equal(config.mcpServers.board.url, `http://127.0.0.1:1/mcp?prune=${token}`);
    assert.ok(!argv.includes('--resume'));
    assert.ok(argv.includes('--session-id'));
    assert.notEqual(argv[argv.indexOf('--session-id') + 1], 'chat-session');
    assert.equal(argv[argv.indexOf('--append-system-prompt') + 1], 'You prune.');
    // The pass works from the board in its prompt; it gets no file tools.
    assert.equal(argv[argv.indexOf('--tools') + 1], '');
    const denied = argv[argv.indexOf('--disallowedTools') + 1];
    for (const name of ['generate_image', 'add_picture_from_url', 'reply', 'undo_reply', 'wait_for_chat', 'restore_version', 'save_version', 'rename_board']) {
      assert.ok(denied.split(/[ ,]/).includes(`mcp__board__${name}`), name);
    }
    assert.equal(store.board.claudeSessionId, 'chat-session');
    assert.equal(agent.running, false);
    store.historyLog.flush();
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test('prune waits for a chat answer in flight, and Stop cuts the wait', async () => {
  const { dir, store, agent } = setup(`#!/usr/bin/env node
require('node:fs').appendFileSync(__dirname + '/spawns', 'x');
setTimeout(() => process.stdout.write(JSON.stringify({ result: 'late', session_id: 's_1' })), 3000);
`);
  try {
    const first = agent.takeTurn('slow', { timeoutMs: 10_000 });
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 100);
    let starts = 0;
    const result = await agent.prune('p', { systemPrompt: 's', timeoutMs: 10_000, signal: ctl.signal, onStart: () => { starts += 1; } });
    assert.deepEqual(result, { ok: false, error: 'stopped' });
    assert.equal(starts, 0);
    assert.equal(fs.readFileSync(path.join(dir, 'spawns'), 'utf8'), 'x');
    assert.equal(agent.running, true);
    await first;
    store.historyLog.flush();
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test('prune calls onStart once the lock is free; its time limit counts from then', async () => {
  const { dir, store, agent } = setup(`#!/usr/bin/env node
const prompt = require('node:fs').readFileSync(0, 'utf8');
setTimeout(() => process.stdout.write(JSON.stringify({ result: prompt, session_id: 's_1' })), prompt === 'slow' ? 400 : 0);
`);
  try {
    const t0 = Date.now();
    const first = agent.takeTurn('slow', { timeoutMs: 10_000 });
    const seen = [];
    // The 300 ms limit would be gone during the 400 ms wait if the wait counted.
    const result = await agent.prune(() => 'built late', { systemPrompt: 's', timeoutMs: 300, onStart: () => seen.push(Date.now() - t0) });
    assert.equal(seen.length, 1);
    assert.ok(seen[0] >= 380, `onStart after the chat run (${seen[0]} ms)`);
    assert.deepEqual(result, { ok: true, text: 'built late' });
    assert.equal((await first).ok, true);
    // An onStart that throws rejects the pass and frees the lock.
    await assert.rejects(agent.prune('p', { systemPrompt: 's', onStart: () => { throw new Error('no disk'); } }), /no disk/);
    assert.equal(agent.running, false);
    store.historyLog.flush();
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test('a board over 90,000 characters reaches the claude binary whole, on stdin, through Pruner and Agent.prune', async () => {
  const { dir, store, agent } = setup(`#!/usr/bin/env node
const prompt = require('node:fs').readFileSync(0, 'utf8');
require('node:fs').writeFileSync(__dirname + '/stdin.txt', prompt);
process.stdout.write(JSON.stringify({ result: 'Pruned.', session_id: 's_p' }));
`);
  try {
    for (let i = 0; i < 40; i += 1) {
      store.apply({ type: 'addSection', title: `Section ${i}`, text: `${i} `.repeat(1200) }, 'user');
    }
    // The view the prompt carries, as it is once the pass starts (the version it saves is not on the board).
    const view = JSON.stringify(boardView(store, { fullNotes: true }));
    assert.ok(view.length > 90_000, `view is ${view.length}`);
    const result = await new Pruner({ store, agent }).run({ timeoutMs: 10_000 });
    assert.equal(result.ok, true);
    const got = fs.readFileSync(path.join(dir, 'stdin.txt'), 'utf8');
    assert.ok(got.includes(view), `the fake got ${got.length} characters`);
    assert.match(store.board.chat.at(-1).text, /^Pruned\./);
    store.historyLog.flush();
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});
