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
import { agentId } from '../lib/authors.mjs';

const A = { model: 'acme/alpha-one', roleId: 'creative' };
const B = { model: 'acme/beta-two', roleId: 'qa' };
const ID_A = agentId(A.model, A.roleId);
const ID_B = agentId(B.model, B.roleId);
const presence = { attached: () => false };
const noClaude = { via: () => 'none', takeTurn: async () => ({ ok: false, error: 'no claude' }) };

function setup({ agents = [A, B], rounds = 2, budget = 5, complete, maxConversation, turnLimit, closingLimit, claude = noClaude, presence: present = presence } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-board-'));
  const store = new BoardStore(path.join(dir, 'board.json'));
  Object.assign(store.board.colab.lineup, { agents, rounds, budget });
  const calls = [];
  const openrouter = {
    hasKey: () => true,
    complete: async (req) => {
      const { signal, ...rest } = req;
      calls.push(structuredClone(rest));
      return complete(req, calls.length);
    },
  };
  const run = new ColabRun({ store, presence: present, claude, library: new Library(path.join(dir, 'colab.json')), openrouter, maxConversation, turnLimit, closingLimit });
  return { dir, store, run, calls };
}

const text = (content) => ({ message: { role: 'assistant', content }, cost: 0.1 });
const toolCall = (name, args, id = 'c1') => ({ message: { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: args } }] }, cost: 0.1 });
// The messages of the turn in progress (conversations carry over between turns).
const thisTurn = (req) => req.messages.slice(req.messages.findLastIndex((m) => m.role === 'user'));
// Scripted turn: first call adds a note, the next answers "done".
const noteThenDone = (req) => (thisTurn(req).some((m) => m.role === 'tool') ? text('done') : toolCall('add_note', '{"text":"hi"}'));
// A call that never answers on its own: it ends only when the turn cuts it short.
const hang = (req) => new Promise((_, reject) => req.signal.addEventListener('abort', () => reject(req.signal.reason)));
const chatPosts = (store) => store.board.chat.filter((m) => m.role !== 'user');
const hostSays = (store, t = 'go', fields = {}) => store.apply({ type: 'chat', text: t, ...fields }, 'user');
// Posts the kickoff and starts the run at once, as /start does.
const kickoff = (store, run, t = 'go') => run.start(hostSays(store, t).message.id);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('agents take turns in order, author their notes and the run ends idle', async () => {
  const { store, run } = setup({ complete: noteThenDone });
  const events = [];
  store.subscribe((e) => e.type === 'colab' && events.push(e.status.state));
  kickoff(store, run);
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
  assert.equal(store.board.chat.filter((m) => m.role === 'user' && m.owed.length).length, 0);
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
  kickoff(store, run);
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
  kickoff(store, run);
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
  kickoff(store, run);
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
  kickoff(store, run);
  await run.finished;
  assert.deepEqual(chatPosts(store).map((m) => m.text), ['last words']);
  assert.equal(run.status.state, 'idle');
});

test('a failed turn is reported and the next agent still plays', async () => {
  const { store, run } = setup({ rounds: 1, complete: (req, n) => { if (n === 1) throw new Error('boom'); return text('fine'); } });
  kickoff(store, run);
  await run.finished;
  assert.deepEqual(chatPosts(store).map((m) => m.text), ['(my turn failed: boom)', 'fine']);
});

test('a 402 ends the run with a note', async () => {
  const { store, run, calls } = setup({ complete: () => { throw new OpenRouterError('Insufficient credits', 402); } });
  kickoff(store, run);
  await run.finished;
  assert.equal(calls.length, 1);
  const last = store.board.chat.at(-1);
  assert.equal(last.role, 'claude');
  assert.match(last.text, /Insufficient credits/);
  assert.equal(run.status.state, 'idle');
});

test('start refuses a second run, an empty order and an unknown role', () => {
  const { store, run } = setup({ complete: () => text('x') });
  kickoff(store, run);
  assert.throws(() => kickoff(store, run), /already/);
  const empty = setup({ agents: [] });
  assert.throws(() => kickoff(empty.store, empty.run), /no one is connected/i);
  const bad = setup({ agents: [{ model: 'a/b', roleId: 'nope' }] });
  assert.throws(() => kickoff(bad.store, bad.run), /nope/);
});

test('start with no cards but a connected Claude runs Claude alone', async () => {
  const { store, run } = setup({ agents: [], rounds: 1, complete: () => text('x'), claude: { via: () => 'binary', takeTurn: async () => ({ ok: true, text: 'solo' }) } });
  kickoff(store, run);
  await run.finished;
  assert.deepEqual(chatPosts(store).map((m) => [m.role, m.text]), [['claude', 'solo']]);
});

test('extras are joined to the library text for the turn', async () => {
  const { store, run, calls } = setup({ agents: [A], rounds: 1, complete: () => text('x') });
  store.board.colab.extras = { rules: 'EXTRA RULES', roles: { creative: 'EXTRA JOB' } };
  kickoff(store, run);
  await run.finished;
  const system = calls[0].messages[0].content;
  assert.match(system, /EXTRA RULES/);
  assert.match(system, /EXTRA JOB/);
});

test('the background agent stays quiet during a run', async () => {
  const { dir, store, run } = setup({ complete: noteThenDone });
  const agent = new Agent(store, presence, { mcpUrl: 'http://127.0.0.1:1/mcp', cwd: dir, claudeBin: '/nonexistent', log: () => {}, quiet: () => run.status.state !== 'idle' });
  kickoff(store, run);
  agent.nudge();
  assert.equal(agent.running, false);
  await run.finished;
  assert.equal(agent.hasUnanswered(), false);
});

test('recoverAfterRestart reports a cut-short run and clears it', () => {
  const { store, run } = setup({ complete: () => text('x') });
  store.setColabRun({ round: 2, spent: 0.61 });
  run.recoverAfterRestart();
  assert.match(store.board.chat.at(-1).text, /during round 2; \$0\.61 spent/);
  assert.equal(store.board.colab.run, null);
});

test('entering running saves the run at once, so a restart during turn one is noticed', async () => {
  let seen;
  const { store, run } = setup({ complete: async () => { seen ??= structuredClone(store.board.colab.run); return text('done'); } });
  kickoff(store, run);
  assert.deepEqual(store.board.colab.run, { round: 1, spent: 0 });
  await run.finished;
  assert.deepEqual(seen, { round: 1, spent: 0 });
});

test('spend inside a turn is saved and announced per call', async () => {
  const { store, run } = setup({ agents: [A], rounds: 1, complete: noteThenDone });
  const spends = [];
  store.subscribe((e) => e.type === 'colab' && spends.push(e.status.spent));
  const saved = [];
  const real = store.setColabRun.bind(store);
  store.setColabRun = (v) => (saved.push(v?.spent), real(v));
  kickoff(store, run);
  await run.finished;
  assert.ok(spends.includes(0.1) && spends.some((s) => Math.abs(s - 0.2) < 1e-9));
  assert.ok(saved.includes(0.1));
});

test('display names prefer the OpenRouter name without its provider prefix', async () => {
  const { run, store } = setup({ complete: noteThenDone });
  run.openrouter.models = async () => [{ id: 'acme/alpha-one', name: 'Acme: Y Large' }];
  await run.prepare();
  run.ensureRoster();
  const [a, b] = store.board.colab.roster;
  assert.equal(a.modelName, 'Y Large');
  assert.equal(b.modelName, 'Beta Two');
  const off = setup({ complete: noteThenDone });
  off.run.openrouter.models = async () => { throw new Error('offline'); };
  await off.run.prepare();
  off.run.ensureRoster();
  assert.equal(off.store.board.colab.roster[0].modelName, 'Alpha One');
});

test('run notes answer nothing, so earlier host messages stay owed', () => {
  const { store, run } = setup({ complete: () => text('x') });
  const m = store.apply({ type: 'chat', text: 'hello', owed: ['claude'] }, 'user').message;
  store.setColabRun({ round: 1, spent: 0 });
  run.recoverAfterRestart();
  assert.deepEqual(store.board.chat.find((c) => c.id === m.id).owed, ['claude']);
});

test('a reply over 20 000 characters is posted cut, not lost', async () => {
  const { store, run } = setup({ agents: [A], rounds: 1, complete: () => text('x'.repeat(25_000)) });
  kickoff(store, run);
  await run.finished;
  const post = chatPosts(store)[0].text;
  assert.ok(post.length < 20_000 && post.endsWith('… (cut)'));
});

test('the run says what the working agent is doing, step by step, and clears it when the turn ends', async () => {
  const { store, run } = setup({
    agents: [A],
    rounds: 1,
    complete: (req) => {
      const tools = req.messages.filter((m) => m.role === 'tool').length;
      if (tools === 0) return toolCall('view_board', '{}');
      if (tools === 1) return toolCall('add_group', '{"title":"Heists"}', 'c2');
      return text('done');
    },
  });
  const seen = [];
  const activity = (status) => status.connections[ID_A]?.activity ?? null;
  store.subscribe((e) => e.type === 'colab' && seen.at(-1) !== activity(e.status) && seen.push(activity(e.status)));
  kickoff(store, run);
  await run.finished;
  assert.deepEqual(seen.filter(Boolean), ['thinking', 'reading the board', 'thinking', 'adding group “Heists”', 'thinking']);
  assert.equal(run.status.connections[ID_A].activity, null);
});

test('the run lists what the working agent has done so far this turn; a batch counts its changes', async () => {
  const { store, run } = setup({
    agents: [A],
    rounds: 1,
    complete: (req) => {
      const tools = req.messages.filter((m) => m.role === 'tool').length;
      if (tools === 0) return toolCall('list_versions', '{}');
      if (tools === 1) return toolCall('batch', JSON.stringify({ calls: [{ tool: 'add_note', args: { text: 'a' } }, { tool: 'add_note', args: { text: 'b' } }] }), 'c2');
      if (tools === 2) return toolCall('add_group', '{"title":"Heists"}', 'c3');
      return text('done');
    },
  });
  const dones = [];
  store.subscribe((e) => e.type === 'colab' && dones.push(JSON.stringify(e.status.connections[ID_A]?.done)));
  kickoff(store, run);
  await run.finished;
  assert.ok(dones.includes(JSON.stringify(["looked up versions", "made 2 changes", "added group “Heists”"])), dones.join("\n"));
  assert.deepEqual(run.status.connections[ID_A].done, []);
});

// ---- conversations kept between turns ----

const lastUser = (req) => req.messages.filter((m) => m.role === 'user').at(-1);
const textOf = (content) => (Array.isArray(content) ? content.map((p) => p.text).join('') : content);

test("an agent's first turn carries the full board, so it doesn't have to ask for it", async () => {
  const { store, run, calls } = setup({ agents: [A], rounds: 1, complete: () => text('done') });
  store.apply({ type: 'addObject', kind: 'group', title: 'Heists' }, 'user');
  kickoff(store, run);
  await run.finished;
  assert.match(textOf(lastUser(calls[0]).content), /The board right now[\s\S]*Heists/);
});

test('its next turn continues the same conversation and adds only what changed since', async () => {
  const { store, run, calls } = setup({ rounds: 2, complete: noteThenDone });
  kickoff(store, run, 'kickoff');
  await run.finished;
  const forA = calls.filter((c) => c.model === A.model);
  const firstOfTurn2 = forA.find((c) => textOf(lastUser(c).content).includes('Since your last turn'));
  assert.ok(firstOfTurn2, 'a later turn says what changed');
  // The same conversation: it starts with turn one's messages.
  assert.deepEqual(firstOfTurn2.messages.slice(0, 2), forA[0].messages.slice(0, 2));
  const update = textOf(lastUser(firstOfTurn2).content);
  assert.match(update, /Beta Two/); // the other agent's change and its chat note
  assert.match(update, /done/);
  assert.doesNotMatch(update, /The board right now/);
});

test('Claude and Gemini models get cache markers; others are left to cache on their own', async () => {
  const claude = { model: 'anthropic/claude-x', roleId: 'creative' };
  const { store, run, calls } = setup({ agents: [claude, B], rounds: 1, complete: () => text('done') });
  kickoff(store, run);
  await run.finished;
  const forClaude = calls.find((c) => c.model === claude.model);
  assert.deepEqual(forClaude.messages[0].content.at(-1).cache_control, { type: 'ephemeral' });
  assert.equal(typeof calls.find((c) => c.model === B.model).messages[0].content, 'string');
});

test('a conversation that grows too long starts over with the full board', async () => {
  const { store, run, calls } = setup({ agents: [A], rounds: 2, complete: noteThenDone, maxConversation: 10 });
  kickoff(store, run);
  await run.finished;
  const turnStarts = calls.filter((c) => c.messages.length === 2);
  assert.equal(turnStarts.length, 2);
  for (const c of turnStarts) assert.match(textOf(lastUser(c).content), /The board right now/);
});

test("each agent's chat note carries its turn's stats: time, cost, calls and cache share", async () => {
  const { store, run } = setup({
    agents: [A],
    rounds: 1,
    complete: (req) => ({ ...noteThenDone(req), promptTokens: 1000, cachedTokens: 600 }),
  });
  kickoff(store, run);
  await run.finished;
  const { stats } = chatPosts(store)[0];
  assert.equal(stats.calls, 2);
  assert.ok(Math.abs(stats.cost - 0.2) < 1e-9);
  assert.equal(stats.promptTokens, 2000);
  assert.equal(stats.cachedTokens, 1200);
  assert.ok(stats.seconds >= 0);
});

test('a turn that runs past its time limit is cut short and asked for its closing message', async () => {
  const { store, run, calls } = setup({ rounds: 1, turnLimit: 30, complete: (req, n) => (n === 1 ? hang(req) : n === 2 ? text('wrapped up') : text('fine')) });
  kickoff(store, run);
  await run.finished;
  assert.equal(calls[1].tools, undefined);
  assert.match(calls[1].messages.at(-1).content, /turn is up/);
  const [first, second] = chatPosts(store);
  assert.equal(first.text, 'wrapped up');
  assert.equal(first.stats.calls, 2);
  assert.equal(second.text, 'fine');
});

test('when even the closing message is too slow, the turn ends with a note and the next agent plays', async () => {
  const { store, run } = setup({ rounds: 1, turnLimit: 30, closingLimit: 30, complete: (req, n) => (n <= 2 ? hang(req) : text('fine')) });
  kickoff(store, run);
  await run.finished;
  const [first, second] = chatPosts(store);
  assert.match(first.text, /out of time/);
  assert.ok(first.stats);
  assert.equal(second.text, 'fine');
});

test('stop cuts the working call short instead of waiting for it', async () => {
  let run;
  const { store, calls, ...rest } = setup({
    complete: (req) => {
      setTimeout(() => run.stop(), 5);
      return hang(req);
    },
  });
  run = rest.run;
  kickoff(store, run);
  await run.finished;
  assert.equal(calls.length, 1);
  assert.deepEqual(chatPosts(store).map((m) => m.text), ['(stopped partway through my turn)']);
  assert.equal(run.status.state, 'idle');
});

test("the turn limit comes from the line-up, in minutes", async () => {
  const { store, run } = setup({ agents: [A], rounds: 1, complete: (req, n) => (n === 1 ? hang(req) : text('wrapped up')) });
  store.board.colab.lineup.turnLimit = 0.0005; // 30 ms
  kickoff(store, run);
  await run.finished;
  assert.equal(chatPosts(store)[0].text, 'wrapped up');
});

// ---- parallel answers, spend on the board, Claude in runs ----

const near = (a, b) => Math.abs(a - b) < 1e-9;
const slowText = (ms, content = 'answer') => async () => { await sleep(ms); return text(content); };

test('a plain message is answered once by each card, in parallel', async () => {
  const { store, run } = setup({ complete: slowText(50) });
  run.ensureRoster();
  const m = hostSays(store, 'what do you think?', { owed: [ID_A, ID_B] }).message;
  const started = Date.now();
  run.answer(ID_A);
  run.answer(ID_B);
  await run.settled();
  const took = Date.now() - started;
  assert.deepEqual(chatPosts(store).map((p) => p.role).sort(), [ID_A, ID_B].sort());
  assert.deepEqual(store.board.chat.find((c) => c.id === m.id).owed, []);
  assert.ok(took < 100, `answers overlap (took ${took} ms)`);
});

test('a second message while answering is answered in one follow-up call', async () => {
  const { store, run, calls } = setup({ agents: [A], complete: slowText(50) });
  run.ensureRoster();
  hostSays(store, 'first question', { owed: [ID_A] });
  run.answer(ID_A);
  await sleep(10);
  hostSays(store, 'second question', { owed: [ID_A] });
  run.answer(ID_A);
  await run.settled();
  assert.equal(chatPosts(store).filter((p) => p.role === ID_A).length, 2);
  assert.equal(calls.length, 2);
  const last = textOf(lastUser(calls[1]).content);
  assert.match(last, /second question/);
  assert.doesNotMatch(last, /first question/);
  assert.equal(store.board.chat.filter((c) => c.role === 'user' && c.owed.length).length, 0);
});

test('spend persists on the board across answers and runs', async () => {
  const { store, run } = setup({ agents: [A], rounds: 1, complete: noteThenDone });
  run.openrouter.complete = async () => text('hi');
  run.ensureRoster();
  hostSays(store, 'hello', { owed: [ID_A] });
  run.answer(ID_A);
  await run.settled();
  assert.ok(near(store.board.colab.spent, 0.1));
  run.openrouter.complete = async (req) => noteThenDone(req);
  kickoff(store, run);
  await run.finished;
  assert.ok(near(store.board.colab.spent, 0.3), String(store.board.colab.spent));
  assert.ok(near(run.status.spent, 0.3));
});

test('no call starts once over budget', async () => {
  let late = 0;
  let store;
  const made = setup({ budget: 0.15, complete: (req) => { if (store.board.colab.spent >= 0.15) late += 1; return noteThenDone(req); } });
  ({ store } = made);
  const { run } = made;
  run.ensureRoster();
  hostSays(store, 'both of you', { owed: [ID_A, ID_B] });
  run.answer(ID_A);
  run.answer(ID_B);
  await run.settled();
  assert.ok(late <= 2, `${late} calls after the budget`);
  assert.ok(chatPosts(store).some((p) => p.text === '(stopped: budget reached)'));
  const notes = store.board.chat.filter((m) => m.text.startsWith('OpenRouter agents stopped: budget'));
  assert.equal(notes.length, 1);
  assert.match(notes[0].text, /budget of \$0\.15 reached \(\$0\.20 spent\)\. Raise the budget or press Reset to go on\./);
  assert.equal(run.overBudget(), true);
  assert.deepEqual(run.canAnswer(ID_A), { ok: false, why: 'over-budget' });
});

test('Claude takes its turn first in a run', async () => {
  const prompts = [];
  const claude = { via: () => 'binary', takeTurn: async (prompt) => { prompts.push(prompt); return { ok: true, text: 'claude turn' }; } };
  const { store, run } = setup({ agents: [A], rounds: 1, claude, complete: () => text('card turn') });
  kickoff(store, run, 'let us build the classes');
  await run.finished;
  assert.deepEqual(chatPosts(store).map((m) => m.role), ['claude', ID_A]);
  assert.equal(chatPosts(store)[0].text, 'claude turn');
  assert.match(prompts[0], /let us build the classes/);
});

test('an MCP Claude turn that times out says so', async () => {
  const claude = { via: () => 'mcp', takeTurn: async () => { throw new Error('not the binary'); } };
  const present = { attached: () => true, offerTurn: async () => false };
  const { store, run } = setup({ agents: [A], rounds: 1, claude, presence: present, complete: () => text('card turn') });
  kickoff(store, run);
  await run.finished;
  const [first] = chatPosts(store);
  assert.equal(first.role, 'claude');
  assert.match(first.text, /^\(out of time after/);
});

test("a /chat to a card during a run reaches only that card's next turn as addressed", async () => {
  let store;
  const made = setup({
    rounds: 2,
    complete: (req, n) => {
      if (n === 1) store.apply({ type: 'chat', text: 'just you', to: [ID_B], owed: [] }, 'user');
      return noteThenDone(req);
    },
  });
  ({ store } = made);
  const { run, calls } = made;
  kickoff(store, run);
  await run.finished;
  const bName = store.board.colab.roster.find((r) => r.id === ID_B).name;
  const line = `Host (to ${bName}): just you`;
  const forB = calls.find((c) => c.model === B.model);
  assert.ok(textOf(lastUser(forB).content).includes(line));
  const nextForA = calls.filter((c) => c.model === A.model).find((c) => textOf(lastUser(c).content).includes('Since your last turn'));
  assert.ok(textOf(lastUser(nextForA).content).includes(line));
});

test('conversations survive between an answer and a later run', async () => {
  const { store, run, calls } = setup({ agents: [A], rounds: 1, complete: () => text('ok') });
  run.ensureRoster();
  hostSays(store, 'hello', { owed: [ID_A] });
  run.answer(ID_A);
  await run.settled();
  kickoff(store, run);
  await run.finished;
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].messages[1], calls[0].messages[1]);
  assert.match(textOf(lastUser(calls[1]).content), /Since your last turn/);
});

test('canAnswer explains why a card cannot answer, and answer does nothing then', async () => {
  const { store, run, calls } = setup({ agents: [A, { model: '', roleId: 'qa' }, { model: 'a/b', roleId: 'nope' }], complete: () => text('x') });
  run.openrouter.hasKey = () => true;
  run.ensureRoster();
  assert.deepEqual(run.canAnswer(ID_A), { ok: true });
  assert.deepEqual(run.canAnswer('agent:=qa'), { ok: false, why: 'no-model' });
  assert.deepEqual(run.canAnswer('agent:a/b=nope'), { ok: false, why: 'no-role' });
  run.openrouter.hasKey = () => false;
  assert.deepEqual(run.canAnswer(ID_A), { ok: false, why: 'no-key' });
  hostSays(store, 'hi', { owed: [ID_A] });
  run.answer(ID_A);
  await run.settled();
  assert.equal(calls.length, 0);
});

test('duplicate cards get their own roster entries, and status lists every connection', () => {
  const { store, run } = setup({ agents: [A, A], complete: () => text('x') });
  run.ensureRoster();
  assert.deepEqual(store.board.colab.roster.map((r) => r.id), [ID_A, `${ID_A}#2`]);
  const { connections, claude, spent, budget, state } = run.status;
  assert.deepEqual(Object.keys(connections).sort(), ['claude', ID_A, `${ID_A}#2`].sort());
  assert.deepEqual(connections[ID_A], { state: 'waiting', activity: null, done: [] });
  assert.equal(claude, 'none');
  assert.equal(spent, 0);
  assert.equal(budget, 5);
  assert.equal(state, 'idle');
});

test("a failed answer is reported and its card stops showing 'thinking'", async () => {
  const { store, run } = setup({ agents: [A], complete: () => { throw new Error('boom'); } });
  run.ensureRoster();
  let last;
  store.subscribe((e) => { if (e.type === 'colab') last = e.status; });
  const m = hostSays(store, 'hello', { owed: [ID_A] }).message;
  run.answer(ID_A);
  await run.settled();
  assert.equal(chatPosts(store).at(-1).text, '(my turn failed: boom)');
  assert.deepEqual(store.board.chat.find((c) => c.id === m.id).owed, []);
  assert.equal(last.connections[ID_A].state, 'waiting');
});

test('an answer names the owed message even when the card saw it already', async () => {
  const { store, run, calls } = setup({ agents: [A], rounds: 1, complete: () => text('ok') });
  run.ensureRoster();
  hostSays(store, 'what about dragons?', { owed: [ID_A] });
  kickoff(store, run);
  await run.finished;
  run.answer(ID_A);
  await run.settled();
  const last = textOf(lastUser(calls.at(-1)).content);
  assert.match(last, /Still to answer:[\s\S]*what about dragons\?/);
  assert.match(last, /Answer the host/);
});

test('a budget crossed in a run is noted once, not again by a later answer', async () => {
  const { store, run } = setup({ agents: [A], rounds: 2, budget: 0.15, complete: noteThenDone });
  kickoff(store, run);
  await run.finished;
  assert.equal(store.board.chat.filter((m) => m.text.startsWith('Agent run stopped: budget')).length, 1);
  hostSays(store, 'still there?', { owed: [ID_A] });
  run.answer(ID_A);
  await run.settled();
  assert.equal(chatPosts(store).at(-1).text, '(stopped: budget reached)');
  assert.equal(store.board.chat.filter((m) => m.text.startsWith('OpenRouter agents stopped')).length, 0);
});
