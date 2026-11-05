// Paper playtests: a player says what they do and the referee, one OpenRouter call that knows
// only the board, says what happens. Where the rules don't say, the action doesn't happen and
// the gap is logged. The state is the referee's, kept here and handed back each turn. Each game is a JSON file in the board's playtests folder; none of it is
// board content (no history, no undo).
import fs from 'node:fs';
import path from 'node:path';
import { authorName } from './authors.mjs';
import { OpError, shortId, text } from './board.mjs';
import { OpenRouterError } from './colab/openrouter.mjs';
import { renderRules } from './export.mjs';

// The most actions in one game, so a player can't spend the budget in a loop.
export const MAX_ACTIONS = 20;
// Dice the server rolls for each referee call (1–100), used in order when something is left to chance.
export const ROLLS = 6;
const ID = /^pt_[0-9a-f]{8}$/;

// How the referee must answer: through the rule tool, its only tool. Some models refuse a forced
// tool choice, so it is asked for, not forced. Its prompt (the library's) says how to referee.
export const REFEREE_FORMAT = 'Give your ruling by calling the rule tool. Use an empty list where there is nothing to say.';
const list = (description, items = { type: 'string' }) => ({ type: 'array', items, description });
export const RULE_TOOL = {
  type: 'function',
  function: {
    name: 'rule',
    description: 'Your ruling on the player\'s action, or the opening of a new game.',
    parameters: {
      type: 'object',
      properties: {
        happened: { type: 'string', description: 'What happens, in a few plain sentences' },
        state: list("The whole state of the game after this, every fact, one short line each. Give all of it every time, even when nothing changed"),
        gaps: list("Each thing the rules don't say that stopped the action; when there is one, the action doesn't happen and the state stays as it was"),
        assumed: list("Each number or detail you had to make up, as 'assumed: …'"),
        rolls_used: list('The dice you used, in order', { type: 'integer' }),
        over: { type: 'boolean', description: 'True only when the rules say the game has ended (won or lost)' },
      },
      required: ['happened', 'state', 'gaps', 'assumed', 'rolls_used', 'over'],
    },
  },
};

const sentence = (value) => (typeof value === 'string' ? value.trim() : '');
const lines = (value) => (Array.isArray(value) ? value.map(sentence).filter(Boolean) : []);

// The referee's answer as {happened, state, gaps, assumed, rollsUsed, over}, or null when it
// isn't one: the rule tool's arguments, else a JSON object in its text.
export function parseRuling(message) {
  const { content, tool_calls: calls } = message ?? {};
  const call = calls?.find((c) => c.function?.name === 'rule');
  const written = typeof content === 'string' ? content : Array.isArray(content) ? content.map((p) => p?.text ?? '').join('') : '';
  const raw = call ? String(call.function.arguments ?? '') : written;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end < start) return null;
  let data;
  try {
    data = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  const happened = sentence(data?.happened);
  if (!happened) return null;
  const rollsUsed = Array.isArray(data.rolls_used) ? data.rolls_used.filter((n) => Number.isInteger(n)) : [];
  return { happened, state: lines(data.state), gaps: lines(data.gaps), assumed: lines(data.assumed), rollsUsed, over: data.over === true };
}

// One referee call's message: the board, the game so far, the dice and what to rule on.
export function refereeMessage(board, game, rolls, action) {
  const parts = [`The game's rules, as the board has them:\n\n${renderRules(board)}`];
  if (game) {
    const told = game.turns.map((t, i) => (t.action === null ? `Opening: ${t.happened}` : `${i}. The player: ${t.action}\n   ${t.happened}`));
    parts.push(`The game so far:\n\n${told.join('\n')}`);
    parts.push(`The state now:\n${game.state.map((s) => `- ${s}`).join('\n') || '- (nothing yet)'}`);
    if (game.assumed.length) parts.push(`Assumed so far (keep using these):\n${game.assumed.map((s) => `- ${s}`).join('\n')}`);
  }
  parts.push(`Dice for this ruling (1–100; use them in order, only when something is left to chance): ${rolls.join(', ')}`);
  parts.push(action === null ? 'Set up a new game: say how it opens and give the starting state.' : `The player does: ${action}`);
  return parts.join('\n\n');
}

// A game as the list shows it.
export const summary = (game) => ({
  id: game.id,
  player: game.player,
  startedAt: game.startedAt,
  endedAt: game.endedAt,
  over: game.over,
  actions: game.turns.filter((t) => t.action !== null).length,
  gaps: game.turns.reduce((n, t) => n + t.gaps.length, 0),
});

export class Playtests {
  #random;
  #now;

  // `openrouter` makes the referee's calls; `random()` (0 ≤ n < 1) rolls the dice.
  constructor({ store, library, openrouter, dir = store.paths.playtests, random = Math.random, now = () => new Date() }) {
    this.store = store;
    this.library = library;
    this.openrouter = openrouter;
    this.dir = dir;
    this.#random = random;
    this.#now = now;
  }

  #file(id) {
    if (!ID.test(String(id))) throw new OpError(`no playtest ${id}`);
    return path.join(this.dir, `${id}.json`);
  }

  #save(game) {
    fs.mkdirSync(this.dir, { recursive: true });
    const file = this.#file(game.id);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(game, null, 2)}\n`);
    fs.renameSync(tmp, file);
    this.store.emit({ type: 'playtest', playtest: game });
  }

  get(id) {
    try {
      return JSON.parse(fs.readFileSync(this.#file(id), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') throw new OpError(`no playtest ${id}`);
      throw error;
    }
  }

  // Every game, newest first.
  list() {
    let names;
    try {
      names = fs.readdirSync(this.dir);
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    return names
      .filter((n) => /^pt_[0-9a-f]{8}\.json$/.test(n))
      .map((n) => this.get(n.slice(0, -5)))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .map(summary);
  }

  // The player's open game, or undefined.
  openGame(player) {
    const open = this.list().find((g) => g.player === player && !g.endedAt);
    return open && this.get(open.id);
  }

  // `signal` cuts the referee's call short; `onSpend(cost)` hears what it cost.
  async start(player, { signal, onSpend } = {}) {
    const open = this.openGame(player);
    if (open) throw new OpError(`You already have a playtest open (${open.id}); end it with playtest_end first.`);
    const ruling = await this.#rule(null, null, { signal, onSpend });
    const game = {
      id: shortId('pt'),
      player,
      startedAt: this.#now().toISOString(),
      endedAt: null,
      over: ruling.over,
      verdict: '',
      state: ruling.state,
      assumed: ruling.assumed,
      turns: [this.#turn(null, ruling)],
    };
    this.#save(game);
    return game;
  }

  async act(player, action, { signal, onSpend } = {}) {
    const said = text(action, 'action', { required: true, max: 2000 });
    const game = this.openGame(player);
    if (!game) throw new OpError('You have no playtest open; start one with playtest_start.');
    if (game.over) throw new OpError('This game is over; end it with playtest_end and your verdict.');
    if (summary(game).actions >= MAX_ACTIONS) throw new OpError(`This game has had its ${MAX_ACTIONS} actions; end it with playtest_end and your verdict.`);
    const ruling = await this.#rule(game, said, { signal, onSpend });
    game.turns.push(this.#turn(said, ruling));
    // A ruling that leaves the state out keeps the one before.
    if (ruling.state.length) game.state = ruling.state;
    for (const a of ruling.assumed) if (!game.assumed.includes(a)) game.assumed.push(a);
    game.over = ruling.over;
    this.#save(game);
    return game;
  }

  end(player, verdict) {
    const said = text(verdict, 'verdict', { required: true, max: 4000 });
    const game = this.openGame(player);
    if (!game) throw new OpError('You have no playtest open.');
    game.endedAt = this.#now().toISOString();
    game.verdict = said;
    this.#save(game);
    return game;
  }

  #turn(action, ruling) {
    return { at: this.#now().toISOString(), action, happened: ruling.happened, gaps: ruling.gaps, assumed: ruling.assumed, rolls: ruling.rolls, rollsUsed: ruling.rollsUsed };
  }

  // One referee call. The budget and the key are checked first; the cost counts even when
  // the answer can't be read.
  async #rule(game, action, { signal, onSpend }) {
    const { colab } = this.store.board;
    const model = colab.lineup.refereeModel;
    if (!this.openrouter?.hasKey()) throw new OpError('Playtests need an OpenRouter key for the referee.');
    if ((colab.spent ?? 0) >= colab.lineup.budget) throw new OpError('The budget is used up; raise it or press Reset to playtest.');
    const rolls = Array.from({ length: ROLLS }, () => 1 + Math.floor(this.#random() * 100));
    const messages = [
      { role: 'system', content: `${this.library.get().prompts.referee}\n\n${REFEREE_FORMAT}` },
      { role: 'user', content: refereeMessage(this.store.board, game, rolls, action) },
    ];
    let reply;
    try {
      reply = await this.openrouter.complete({ model, messages, tools: [RULE_TOOL], signal });
    } catch (error) {
      if (error instanceof OpenRouterError) throw new OpError(`The referee couldn't answer: ${error.message}`);
      throw error;
    }
    this.store.addColabSpend(reply.cost);
    onSpend?.(reply.cost);
    const ruling = parseRuling(reply.message);
    if (!ruling) throw new OpError("The referee's answer couldn't be read; try again.");
    return { ...ruling, rolls };
  }
}

// A game as the tools show it to an agent: names instead of ids, and the log in order.
export function playtestView(board, game) {
  return {
    id: game.id,
    player: game.player === 'user' ? 'Host' : authorName(board, game.player),
    started_at: game.startedAt,
    ended_at: game.endedAt,
    over: game.over,
    state: game.state,
    assumed: game.assumed,
    turns: game.turns.map((t) => ({ ...(t.action === null ? { opening: true } : { action: t.action }), happened: t.happened, ...(t.gaps.length ? { gaps: t.gaps } : {}) })),
    ...(game.verdict ? { verdict: game.verdict } : {}),
  };
}
