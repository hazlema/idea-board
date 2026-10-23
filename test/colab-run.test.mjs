import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Agent } from '../lib/agent.mjs';
import { BoardStore } from '../lib/store.mjs';
import { Library } from '../lib/colab/library.mjs';
import { OpenRouterError } from '../lib/colab/openrouter.mjs';
import { ColabRun } from '../lib/colab/run.mjs';

const A = { model: 'acme/alpha-one', roleId: 'creative' };
const B = { model: 'acme/beta-two', roleId: 'qa' };
const presence = { attached: () => false };

function setup({ agents = [A, B], rounds = 2, budget = 5, complete } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-board-'));
  const store = new BoardStore(path.join(dir, 'board.json'));
  Object.assign(store.board.colab.lineup, { agents, rounds, budget });
  const calls = [];
  const openrouter = { complete: async (req) => { calls.push(structuredClone(req)); return complete(req, calls.length); } };
  const run = new ColabRun({ store, presence, library: new Library(path.join(dir, 'colab.json')), openrouter });
  return { dir, store, run, calls };
}

const text = (content) => ({ message: { role: 'assistant', content }, cost: 0.1 });
const toolCall = (name, args, id = 'c1') => ({ message: { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: args } }] }, cost: 0.1 });
// Scripted turn: first call adds a note, the next answers "done".
const noteThenDone = (req) => (req.messages.some((m) => m.role === 'tool') ? text('done') : toolCall('add_note', '{"text":"hi"}'));
const chatPosts = (store) => store.board.chat.filter((m) => m.role !== 'user');
const hostSays = (store, t = 'go') => store.apply({ type: 'chat', text: t }, 'user');

test('a run waits for a user message posted after start', async () => {
  const { store, run, calls } = setup({ complete: noteThenDone });
  hostSays(store, 'before');
  run.start();
  assert.equal(run.status.state, 'waiting');
  run.onUserMessage();
  assert.equal(run.status.state, 'waiting');
  assert.equal(calls.length, 0);
  hostSays(store);
  run.onUserMessage();
  await run.finished;
  assert.ok(calls.length > 0);
});

test('agents take turns in order, author their notes and the run ends idle', async () => {
  const { store, run } = setup({ complete: noteThenDone });
  const events = [];
  store.subscribe((e) => e.type === 'colab' && events.push(e.status.state));
  run.start();
  hostSays(store);
  run.onUserMessage();
  await run.finished;
  const [a, b] = store.board.colab.roster;
  assert.equal(a.name, 'Alpha One · Creative Director & Lore');
  assert.deepEqual(chatPosts(store).map((m) => m.role), [a.id, b.id, a.id, b.id]);
  assert.ok(chatPosts(store).every((m) => m.text === 'done'));
  const notes = store.board.brainstorm.pages[0].objects.filter((o) => o.kind === 'note');
  assert.deepEqual(notes.map((n) => n.author), [a.id, b.id, a.id, b.id]);
  assert.equal(run.status.state, 'idle');
  assert.equal(store.board.colab.run, null);
  assert.ok(events.includes('running'));
  assert.equal(store.board.chat.filter((m) => m.role === 'user' && !m.handled).length, 0);
});

test('bad tool arguments and unknown tools become Error results; the turn completes', async () => {
  const seen = [];
  const { store, run } = setup({
    agents: [A],
    rounds: 1,
    complete: (req, n) => {
      if (n === 1) return toolCall('add_note', '{nope');
      if (n === 2) return toolCall('no_such_tool', '{}');
      seen.push(...req.messages.filter((m) => m.role === 'tool').map((m) => m.content));
      return text('ok');
    },
  });
  run.start();
  hostSays(store);
  run.onUserMessage();
  await run.finished;
  assert.equal(seen.length, 2);
  assert.ok(seen.every((c) => c.startsWith('Error:')));
  assert.equal(chatPosts(store)[0].text, 'ok');
});

test('hidden tools are not offered and the 15 call limit asks for a closing message', async () => {
  const { store, run, calls } = setup({
    agents: [A],
    rounds: 1,
    complete: (req) => (req.tools ? toolCall('view_board', '{}') : text('wrapped up')),
  });
  run.start();
  hostSays(store);
  run.onUserMessage();
  await run.finished;
  const names = calls[0].tools.map((t) => t.function.name);
  assert.ok(names.includes('view_board'));
  for (const hidden of ['wait_for_chat', 'reply', 'undo_reply', 'restore_version']) assert.ok(!names.includes(hidden));
  assert.equal(calls.length, 16);
  assert.equal(calls[15].tools, undefined);
  assert.equal(chatPosts(store)[0].text, 'wrapped up');
});

test('the budget is checked before each turn', async () => {
  const { store, run, calls } = setup({ budget: 0.25, rounds: 3, complete: () => text('done') });
  run.start();
  hostSays(store);
  run.onUserMessage();
  await run.finished;
  assert.equal(calls.length, 3);
  const last = store.board.chat.at(-1);
  assert.equal(last.role, 'claude');
  assert.match(last.text, /budget of \$0\.25 reached \(\$0\.30 spent\)/);
  assert.equal(run.status.state, 'idle');
});

test('stop during a turn finishes that turn and plays no more', async () => {
  let run;
  const { store, ...rest } = setup({
    complete: () => {
      run.stop();
      assert.equal(run.status.state, 'stopping');
      return text('last words');
    },
  });
  run = rest.run;
  run.start();
  hostSays(store);
  run.onUserMessage();
  await run.finished;
  assert.deepEqual(chatPosts(store).map((m) => m.text), ['last words']);
  assert.equal(run.status.state, 'idle');
});

test('stop while waiting returns straight to idle', () => {
  const { store, run } = setup({ complete: () => text('x') });
  run.start();
  run.stop();
  assert.equal(run.status.state, 'idle');
  hostSays(store);
  run.onUserMessage();
  assert.equal(run.status.state, 'idle');
});

test('a failed turn is reported and the next agent still plays', async () => {
  const { store, run } = setup({ rounds: 1, complete: (req, n) => { if (n === 1) throw new Error('boom'); return text('fine'); } });
  run.start();
  hostSays(store);
  run.onUserMessage();
  await run.finished;
  assert.deepEqual(chatPosts(store).map((m) => m.text), ['(my turn failed: boom)', 'fine']);
});

test('a 402 ends the run with a note', async () => {
  const { store, run, calls } = setup({ complete: () => { throw new OpenRouterError('Insufficient credits', 402); } });
  run.start();
  hostSays(store);
  run.onUserMessage();
  await run.finished;
  assert.equal(calls.length, 1);
  const last = store.board.chat.at(-1);
  assert.equal(last.role, 'claude');
  assert.match(last.text, /Insufficient credits/);
  assert.equal(run.status.state, 'idle');
});

test('start refuses a second run, an empty line-up and an unknown role', () => {
  const { run } = setup({ complete: () => text('x') });
  run.start();
  assert.throws(() => run.start(), /already/);
  assert.throws(() => setup({ agents: [] }).run.start(), /at least one/);
  assert.throws(() => setup({ agents: [{ model: 'a/b', roleId: 'nope' }] }).run.start(), /nope/);
});

test('extras are joined to the library text for the turn', async () => {
  const { store, run, calls } = setup({ agents: [A], rounds: 1, complete: () => text('x') });
  store.board.colab.extras = { rules: 'EXTRA RULES', roles: { creative: 'EXTRA JOB' } };
  run.start();
  hostSays(store);
  run.onUserMessage();
  await run.finished;
  const system = calls[0].messages[0].content;
  assert.match(system, /EXTRA RULES/);
  assert.match(system, /EXTRA JOB/);
});

test('the background agent stays quiet during a run', async () => {
  const { dir, store, run } = setup({ complete: noteThenDone });
  const agent = new Agent(store, presence, { mcpUrl: 'http://127.0.0.1:1/mcp', cwd: dir, claudeBin: '/nonexistent', log: () => {}, quiet: () => run.status.state !== 'idle' });
  run.start();
  hostSays(store);
  agent.nudge();
  assert.equal(agent.running, false);
  run.onUserMessage();
  agent.nudge();
  assert.equal(agent.running, false);
  await run.finished;
  assert.equal(agent.hasUnanswered(), false);
});

test('recoverAfterRestart reports a cut-short run and clears it', () => {
  const { store, run } = setup({ complete: () => text('x') });
  store.setColabRun({ round: 2, spent: 0.61 });
  run.recoverAfterRestart();
  assert.match(store.board.chat.at(-1).text, /after round 2; \$0\.61 spent/);
  assert.equal(store.board.colab.run, null);
});

test('entering running saves the run at once, so a restart during turn one is noticed', async () => {
  let seen;
  const { store, run } = setup({ complete: async () => { seen ??= structuredClone(store.board.colab.run); return text('done'); } });
  run.start();
  hostSays(store);
  run.onUserMessage();
  assert.deepEqual(store.board.colab.run, { round: 1, spent: 0 });
  await run.finished;
  assert.deepEqual(seen, { round: 1, spent: 0 });
});
