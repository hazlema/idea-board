import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Agent } from '../lib/agent.mjs';
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

    store.apply({ type: 'chat', text: 'first question' }, 'user');
    agent.nudge();
    assert.equal(agent.running, true);
    store.apply({ type: 'chat', text: 'second question' }, 'user');
    agent.nudge();

    const chat = await afterFirstReply;
    assert.deepEqual(chat.map((m) => [m.role, m.handled]), [['user', true], ['user', false], ['claude', true]]);
    assert.equal(chat[2].text, 'answered: first question');

    await idleTwice;
    const final = store.board.chat;
    assert.equal(final.at(-1).text, 'answered: second question');
    assert.ok(final.filter((m) => m.role === 'user').every((m) => m.handled));
    store.historyLog.flush();
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});
