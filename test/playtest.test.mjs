import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Library } from '../lib/colab/library.mjs';
import { OpenRouterError } from '../lib/colab/openrouter.mjs';
import { OpError, applyOp } from '../lib/board.mjs';
import { MAX_ACTIONS, Playtests, parseRuling, refereeMessage } from '../lib/playtest.mjs';
import { BoardStore } from '../lib/store.mjs';
import { withServer } from './helpers.mjs';

const ruling = (fields = {}) => JSON.stringify({ happened: 'The bell rings.', state: ['Crowd: 40'], gaps: [], assumed: [], rolls_used: [], over: false, ...fields });

// A Playtests on a temp board whose referee answers with `answers` in order (each a string or
// an Error), costing 0.01 each. `calls` records what the referee was sent.
function setup(answers = [], { key = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-board-playtest-'));
  const store = new BoardStore(path.join(dir, 'board.json'), { wikiDir: path.join(dir, 'wiki') });
  const library = new Library(path.join(dir, 'colab.json'));
  const calls = [];
  const openrouter = {
    hasKey: () => key,
    complete: async (req) => {
      calls.push(req);
      const next = answers.shift() ?? ruling();
      if (next instanceof Error) throw next;
      return { message: { role: 'assistant', content: next }, cost: 0.01 };
    },
  };
  let tick = 0;
  const playtests = new Playtests({ store, library, openrouter, random: () => 0.5, now: () => new Date(Date.UTC(2026, 10, 5, 12, 0, tick++)) });
  return { store, library, playtests, calls, dir };
}

test('parseRuling reads the rule tool call, else JSON in the text, and refuses an answer without one', () => {
  const call = { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'rule', arguments: ruling({ happened: 'Called.' }) } }] };
  assert.equal(parseRuling(call).happened, 'Called.');
  const said = (content) => ({ role: 'assistant', content });
  assert.deepEqual(parseRuling(said('```json\n{"happened": " Forty stop. ", "state": ["Crowd: 40", ""], "gaps": "none", "rolls_used": [51, "x"], "over": true}\n```')), {
    happened: 'Forty stop.', state: ['Crowd: 40'], gaps: [], assumed: [], rollsUsed: [51], over: true,
  });
  assert.equal(parseRuling(said('The bell rings.')), null);
  assert.equal(parseRuling(said('{"state": []}')), null);
  assert.equal(parseRuling(said('{not json}')), null);
  assert.equal(parseRuling(undefined), null);
});

test('the referee is sent the rules, the dice and the action, never the chat', () => {
  const { store } = setup();
  const board = store.board;
  applyOp(board, { type: 'updateSection', id: board.brief.sections[0].id, text: 'Ring the bell to gather a crowd.' }, 'user');
  board.chat.push({ id: 'm1', role: 'user', text: 'Secretly we mean the crowd fights.', at: '' });
  const game = { turns: [{ action: null, happened: 'A street.', gaps: [] }], state: ['Crowd: 0'], assumed: ['assumed: 10 hold a street'] };
  const message = refereeMessage(board, game, [12, 99], 'ring the bell');
  assert.match(message, /Ring the bell to gather a crowd\./);
  assert.doesNotMatch(message, /Secretly/);
  assert.match(message, /Opening: A street\./);
  assert.match(message, /- Crowd: 0/);
  assert.match(message, /keep using these\):\n- assumed: 10 hold a street/);
  assert.match(message, /12, 99/);
  assert.match(message, /The player does: ring the bell$/);
  assert.match(refereeMessage(board, null, [1], null), /Set up a new game/);
});

test('a game: opening, actions, a gap, assumptions kept, then the verdict', async () => {
  const { store, playtests, calls } = setup([
    ruling({ happened: 'You stand in a street.', state: ['Crowd: 0'] }),
    ruling({ happened: 'Forty turn.', state: ['Crowd: 40'], assumed: ['assumed: 40 answer a bell'], rolls_used: [51] }),
    ruling({ happened: "The rules don't say; nothing happens.", state: ['Crowd: 40', 'Drum: near'], gaps: ['What a drum does to a crowd'], assumed: ['assumed: 40 answer a bell'] }),
    ruling({ happened: 'Time passes.', state: [] }),
  ]);
  const started = await playtests.start('agent:x/y=qa');
  assert.equal(started.turns[0].action, null);
  assert.deepEqual(started.state, ['Crowd: 0']);
  assert.equal(calls[0].model, 'anthropic/claude-sonnet-5.5');
  assert.match(calls[0].messages[0].content, /referee of a paper playtest/);
  assert.match(calls[0].messages[0].content, /calling the rule tool/);
  assert.deepEqual(calls[0].tools.map((t) => t.function.name), ['rule']);
  // random() is 0.5, so every die is 51.
  assert.match(calls[0].messages[1].content, /51, 51, 51, 51, 51, 51/);
  await assert.rejects(playtests.start('agent:x/y=qa'), /already have a playtest open/);

  let game = await playtests.act('agent:x/y=qa', 'ring the bell');
  assert.deepEqual(game.state, ['Crowd: 40']);
  assert.deepEqual(game.turns[1].rollsUsed, [51]);
  game = await playtests.act('agent:x/y=qa', 'march at the drum');
  assert.deepEqual(game.state, ['Crowd: 40', 'Drum: near'], "the state is the referee's");
  game = await playtests.act('agent:x/y=qa', 'wait');
  assert.deepEqual(game.state, ['Crowd: 40', 'Drum: near'], 'a ruling without a state keeps the one before');
  assert.deepEqual(game.turns[2].gaps, ['What a drum does to a crowd']);
  assert.deepEqual(game.assumed, ['assumed: 40 answer a bell']);
  assert.ok(Math.abs(store.board.colab.spent - 0.04) < 1e-9);

  await assert.rejects(playtests.act('agent:x/y=qa', '  '), /action must not be empty/);
  assert.throws(() => playtests.end('agent:x/y=qa', ''), /verdict must not be empty/);
  const ended = playtests.end('agent:x/y=qa', 'Ringing works; the drum has no rule.');
  assert.equal(ended.verdict, 'Ringing works; the drum has no rule.');
  assert.ok(ended.endedAt);
  await assert.rejects(playtests.act('agent:x/y=qa', 'ring again'), /no playtest open/);
  assert.deepEqual(playtests.list().map(({ player, actions, gaps }) => ({ player, actions, gaps })), [{ player: 'agent:x/y=qa', actions: 3, gaps: 1 }]);
  assert.deepEqual(playtests.get(ended.id), ended);
});

test('each player has their own game, newest first in the list', async () => {
  const { playtests } = setup();
  const a = await playtests.start('user');
  const b = await playtests.start('claude');
  assert.deepEqual(playtests.list().map((g) => g.id), [b.id, a.id]);
  assert.throws(() => playtests.get('../board'), OpError);
  assert.throws(() => playtests.get('pt_00000000'), /no playtest pt_00000000/);
});

test('a game the rules end, or one out of actions, takes no more actions', async () => {
  const over = setup([ruling(), ruling({ happened: 'The gate falls.', over: true })]);
  await over.playtests.start('user');
  assert.equal((await over.playtests.act('user', 'wait')).over, true);
  await assert.rejects(over.playtests.act('user', 'wait'), /game is over/);

  const long = setup();
  await long.playtests.start('user');
  for (let i = 0; i < MAX_ACTIONS; i += 1) await long.playtests.act('user', `step ${i}`);
  await assert.rejects(long.playtests.act('user', 'one more'), new RegExp(`its ${MAX_ACTIONS} actions`));
});

test('no key, a spent budget, a failed call or an unreadable answer is refused', async () => {
  await assert.rejects(setup([], { key: false }).playtests.start('user'), /need an OpenRouter key/);

  const broke = setup();
  broke.store.setColabSpent(broke.store.board.colab.lineup.budget);
  await assert.rejects(broke.playtests.start('user'), /budget is used up/);

  await assert.rejects(setup([new OpenRouterError('rate limited', 429)]).playtests.start('user'), /referee couldn't answer: rate limited/);

  const garbled = setup(['I think the bell rings.']);
  await assert.rejects(garbled.playtests.start('user'), /couldn't be read/);
  assert.equal(garbled.store.board.colab.spent, 0.01, 'the call is still paid for');
  assert.deepEqual(garbled.playtests.list(), []);
});

test('the referee model follows the board setting', async () => {
  const { store, playtests, calls } = setup();
  store.board.colab.lineup.refereeModel = 'acme/judge';
  await playtests.start('user');
  assert.equal(calls[0].model, 'acme/judge');
});

const servedPlaytests = (store, library) => new Playtests({
  store,
  library,
  random: () => 0,
  openrouter: { hasKey: () => true, complete: async () => ({ message: { content: ruling() }, cost: 0 }) },
});

test('agents play through the tools and anyone reads the result', () => withServer(async ({ call }) => {
  const started = await call('playtest_start', {});
  assert.equal(started.player, 'Claude');
  assert.equal(started.turns[0].opening, true);
  const acted = await call('playtest_act', { action: 'ring the bell' });
  assert.deepEqual(acted, { happened: 'The bell rings.', state: ['Crowd: 40'], over: false, actions_left: MAX_ACTIONS - 1 });
  const ended = await call('playtest_end', { verdict: 'Fine.' });
  assert.equal(ended.verdict, 'Fine.');
  const { playtests } = await call('read_playtest', {});
  assert.deepEqual(playtests.map(({ player, actions }) => ({ player, actions })), [{ player: 'Claude', actions: 1 }]);
  assert.equal((await call('read_playtest', { id: started.id })).turns[1].action, 'ring the bell');
  assert.match((await call('batch', { calls: [{ tool: 'playtest_start' }] })).failed.error, /can't run inside a batch/);
}, { playtests: servedPlaytests }));

test('the host plays from the Playtest tab', () => withServer(async ({ base }) => {
  const post = (url, body) => fetch(`${base}${url}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  const { playtest } = await (await post('/api/playtests')).json();
  assert.equal(playtest.player, 'user');
  assert.equal((await (await post('/api/playtests/act', { action: 'ring' })).json()).playtest.turns.length, 2);
  const refused = await post('/api/playtests/end', {});
  assert.equal(refused.status, 400);
  assert.match((await refused.json()).error, /verdict is required/);
  assert.equal((await (await post('/api/playtests/end', { verdict: 'Good.' })).json()).playtest.verdict, 'Good.');
  const { playtests } = await (await fetch(`${base}/api/playtests`)).json();
  assert.equal(playtests.length, 1);
  assert.equal((await (await fetch(`${base}/api/playtests/${playtest.id}`)).json()).playtest.verdict, 'Good.');
  assert.equal((await fetch(`${base}/api/playtests/pt_00000000`)).status, 400);
}, { playtests: servedPlaytests }));
