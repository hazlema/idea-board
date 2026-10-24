// The agent run: the line-up's models take turns editing the board through
// the same tools Claude uses, posting a chat message at the end of each turn.
import { OpError, TURN_LIMIT } from '../board.mjs';
import { cardIds } from '../authors.mjs';
import { TOOLS, createToolRunner } from '../mcp.mjs';
import { OpenRouterError } from './openrouter.mjs';
import { answerMessage, stripSelfTag, systemPrompt, turnMessage, updateMessage } from './prompts.mjs';

const MAX_POST = 19_000; // the chat op allows 20 000 characters
const MAX_STEPS = 15; // tool calls per turn
const CLOSING_LIMIT = 60_000; // then, out of time, this long to write its message
// Tools that block, rewind other people's work, or answer for the host.
const HIDDEN_TOOLS = new Set(['wait_for_chat', 'reply', 'undo_reply', 'restore_version']);
const COLORS = ['amber', 'sky', 'green', 'violet', 'rose'];

const nameOf = (model) =>
  model
    .split('/')
    .pop()
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());

// "OpenAI: GPT-6 Luna Pro" -> "GPT-6 Luna Pro"
const cleanName = (name) => name.replace(/^[^:]{1,40}:\s+/, '').trim();

const money = (n) => `$${n.toFixed(2)}`;
export const joinLayers = (base, extra) => (extra?.trim() ? `${base}\n\n${extra}` : base);
// A conversation longer than this (in characters, roughly 4 per token) starts over with the full board.
const MAX_CONVERSATION = 400_000;

// Claude and Gemini on OpenRouter cache a prompt prefix only up to a marked block; OpenAI,
// DeepSeek and others cache long prefixes on their own.
const marksCache = (model) => /^~?(anthropic|google)\//.test(model);
const marked = (text) => [{ type: 'text', text, cache_control: { type: 'ephemeral' } }];
const plain = (content) => (Array.isArray(content) ? content.map((p) => p.text).join('') : content);

// Why a turn was cut short: 'time' (its limit), 'stop' (the host pressed Stop) or
// 'budget' (spent reached the budget, so no further call may start).
class TurnCut extends Error {
  constructor(why) {
    super({ time: 'out of time', stop: 'stopped', budget: 'budget reached' }[why]);
    this.why = why;
  }
}

// Claude when there is no Agent to take its turns.
const NO_CLAUDE = { via: () => 'none', takeTurn: async () => ({ ok: false, error: 'Claude is not connected' }) };
// The binary gets the prompt alone, so it is told how its turn ends; an MCP session hears it from wait_for_chat.
const BINARY_TURN_END = "Work on the board with your tools, then end with a short message to the others (3 to 5 sentences). Your final reply is posted to the chat under your name.";
const names = (list) => (list.length <= 1 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`);

// A signal that aborts with a TurnCut after `ms`; clear() cancels the timer.
function cutAfter(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new TurnCut('time')), ms);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

const minutes = (ms) => `${Math.round(ms / 60_000)} min`;
const lastSeq = (store) => store.historyLog.entries().at(-1)?.seq ?? 0;

const toolText = (output) => (output?.mcpContent ? output.mcpContent.map((c) => c.text ?? '').join('\n') : JSON.stringify(output));

// A tool call in words, for the page: "adding group “Heists”", "reading the board".
const ACTIVITIES = {
  view_board: 'reading the board',
  view_picture: 'looking at a picture',
  batch: 'making changes',
  rule_out: 'ruling something out',
  bring_back: 'bringing something back',
  tidy_layout: 'tidying the flowchart',
  save_version: 'saving a version',
  export_design_doc: 'exporting the design',
};
const VERBS = { add: 'adding', update: 'editing', move: 'moving', delete: 'removing', link: 'linking', unlink: 'unlinking', connect: 'connecting', disconnect: 'disconnecting', get: 'looking up', list: 'looking up' };

export function activityFor(name, rawArgs) {
  if (ACTIVITIES[name]) return ACTIVITIES[name];
  let args = {};
  try {
    args = JSON.parse(rawArgs || '{}') ?? {};
  } catch {
    // Unreadable arguments: describe the tool alone.
  }
  const [verb, ...rest] = name.split('_');
  const thing = rest.join(' ');
  const label = [args.title, args.label, args.text].find((v) => typeof v === 'string' && v.trim());
  const named = label ? ` “${label.trim().slice(0, 40)}${label.trim().length > 40 ? '…' : ''}”` : '';
  return `${VERBS[verb] ?? verb}${thing ? ` ${thing}` : ''}${named}`;
}

const PAST = [
  ['reading', 'read'], ['adding', 'added'], ['editing', 'edited'], ['moving', 'moved'], ['removing', 'removed'],
  ['linking', 'linked'], ['unlinking', 'unlinked'], ['connecting', 'connected'], ['disconnecting', 'disconnected'],
  ['looking', 'looked'], ['ruling', 'ruled'], ['bringing', 'brought'], ['tidying', 'tidied'], ['saving', 'saved'], ['exporting', 'exported'],
];

// The same, once done: "added group “Heists”"; a batch says how many changes it made.
export function doneFor(name, rawArgs) {
  if (name === 'batch') {
    let count = 0;
    try {
      count = JSON.parse(rawArgs || '{}')?.calls?.length ?? 0;
    } catch {
      // Unreadable arguments: no count.
    }
    return count === 1 ? 'made 1 change' : `made ${count || 'some'} changes`;
  }
  const doing = activityFor(name, rawArgs);
  const pair = PAST.find(([now]) => doing.startsWith(`${now} `) || doing === now);
  return pair ? pair[1] + doing.slice(pair[0].length) : doing;
}

export class ColabRun {
  #fixedTurnLimit;

  // Who is working right now, by connection id: { mode: 'turn'|'answer', controller, activity, done }.
  #busy = new Map();

  // The tail of each connection's queue, so its answers and run turns never overlap.
  #locks = new Map();

  // The answer job of each card, while one is queued or going: { again }.
  #answers = new Map();

  // Set once the "budget reached" note has been posted for answers; budgetChanged() clears it.
  #budgetNoted = false;

  // turnLimit (ms) overrides the line-up's minutes, for tests.
  constructor({ store, presence, claude = NO_CLAUDE, library, openrouter, pictures = null, maxConversation = MAX_CONVERSATION, turnLimit = null, closingLimit = CLOSING_LIMIT }) {
    this.store = store;
    this.maxConversation = maxConversation;
    this.#fixedTurnLimit = turnLimit;
    this.closingLimit = closingLimit;
    // Each connection's conversation, kept between its answers and turns for as long as the
    // server runs: { messages, seq, chat } where seq and chat mark the history entry and chat
    // length it last saw. Claude's entry ('claude') holds only the marks.
    this.conversations = new Map();
    // Ids of the models that accept images (from prepare()).
    this.visionModels = new Set();
    this.presence = presence;
    this.claude = claude;
    this.library = library;
    this.openrouter = openrouter;
    // The PictureMaker behind generate_image, offered only to cards whose role can make pictures.
    this.pictures = pictures;
    this.state = 'idle';
    this.round = 0;
    this.rounds = 0;
    this.current = null;
    // What this run has spent, for its notes and restart recovery; the board keeps the total.
    this.spent = 0;
    // The run's turn order: 'claude' (when connected) and the card ids.
    this.agents = [];
    this.kickoffId = null;
    this.modelNames = new Map();
    // Resolves when the loop of the current run has ended (for tests and shutdown).
    this.finished = Promise.resolve();
  }

  get turnLimit() {
    return this.#fixedTurnLimit ?? (this.store.board.colab.lineup.turnLimit ?? TURN_LIMIT) * 60_000;
  }

  get status() {
    const { colab } = this.store.board;
    const connections = {};
    for (const id of ['claude', ...cardIds(colab.lineup.agents), ...this.#busy.keys()]) {
      if (connections[id]) continue;
      const work = this.#busy.get(id);
      const state = work ? 'thinking' : id !== 'claude' && this.overBudget() ? 'over-budget' : 'waiting';
      // What it is doing right now ("reading the board"), and what it has done so far this
      // turn ("read the board", "made 3 changes"): most of a turn is the model thinking.
      connections[id] = { state, activity: work?.activity ?? null, done: [...(work?.done ?? [])] };
    }
    const { state, round, rounds, current } = this;
    return { state, round, rounds, current, spent: colab.spent ?? 0, budget: colab.lineup.budget, claude: this.claude.via(), connections };
  }

  #emit() {
    this.store.emit({ type: 'colab', status: this.status });
  }

  #setState(state, fields = {}) {
    Object.assign(this, { state }, fields);
    this.#emit();
  }

  // Looks up the models' display names; offline just means the id-based names.
  async prepare() {
    try {
      const models = await this.openrouter.models();
      this.modelNames = new Map(models.map((m) => [m.id, cleanName(m.name ?? '')]));
      this.visionModels = new Set(models.filter((m) => m.vision).map((m) => m.id));
    } catch {
      this.modelNames = new Map();
      this.visionModels = new Set();
    }
  }

  // A roster entry for every line-up card that has a model and a known role, so its
  // changes and posts are accepted under its own name.
  ensureRoster() {
    const { lineup, roster } = this.store.board.colab;
    const roles = new Map(this.library.get().roles.map((r) => [r.id, r]));
    const ids = cardIds(lineup.agents);
    const added = [];
    lineup.agents.forEach((a, i) => {
      const id = ids[i];
      if (!a.model || !roles.has(a.roleId)) return;
      if (roster.some((r) => r.id === id) || added.some((r) => r.id === id)) return;
      const modelName = this.modelNames.get(a.model) || nameOf(a.model);
      const repeat = id.match(/#(\d+)$/)?.[1];
      added.push({ id, model: a.model, roleId: a.roleId, name: `${modelName} · ${roles.get(a.roleId).name}${repeat ? ` #${repeat}` : ''}`, modelName, color: COLORS[(roster.length + added.length) % COLORS.length] });
    });
    if (added.length) this.store.addColabRoster(added);
  }

  overBudget() {
    const { colab } = this.store.board;
    return (colab.spent ?? 0) >= colab.lineup.budget;
  }

  // Whether an OpenRouter card can answer right now, and why not.
  canAnswer(id) {
    const { agents } = this.store.board.colab.lineup;
    const card = agents[cardIds(agents).indexOf(id)];
    if (!card?.model) return { ok: false, why: 'no-model' };
    if (!this.library.get().roles.some((r) => r.id === card.roleId)) return { ok: false, why: 'no-role' };
    if (!this.openrouter.hasKey()) return { ok: false, why: 'no-key' };
    if (this.overBudget()) return { ok: false, why: 'over-budget' };
    return { ok: true };
  }

  // The budget was raised or spent reset: a later crossing gets its own note.
  budgetChanged() {
    this.#budgetNoted = false;
    this.#emit();
  }

  // Answers, in one call, every host message this card still owes. Called again while it is
  // answering, it answers what came in meanwhile in one follow-up call.
  answer(id) {
    const can = this.canAnswer(id);
    // Over budget it still goes, so the owed messages get "(stopped: budget reached)".
    if (!can.ok && can.why !== 'over-budget') return;
    const job = this.#answers.get(id);
    if (job) {
      job.again = true;
      return;
    }
    const next = { again: false };
    this.#answers.set(id, next);
    this.ensureRoster();
    this.#exclusive(id, async () => {
      try {
        for (;;) {
          next.again = false;
          await this.#answerOnce(id);
          if (!next.again) break;
        }
      } finally {
        this.#answers.delete(id);
      }
    }).catch(() => {
      // #answerOnce reports its own failures; a failed post has nowhere left to go.
    });
  }

  // Resolves once no answer is queued or going and no run is in progress.
  async settled() {
    while (this.#locks.size || this.state !== 'idle') await Promise.all([...this.#locks.values(), this.finished]);
  }

  // Runs fn after every earlier job of this connection.
  #exclusive(id, fn) {
    const job = (this.#locks.get(id) ?? Promise.resolve()).then(fn);
    const tail = job.catch(() => {});
    this.#locks.set(id, tail);
    tail.then(() => {
      if (this.#locks.get(id) === tail) this.#locks.delete(id);
    });
    return job;
  }

  async #answerOnce(id) {
    const owed = this.store.board.chat.filter((m) => m.role === 'user' && m.owed?.includes(id));
    const me = this.store.board.colab.roster.find((r) => r.id === id);
    if (!owed.length || !me) return;
    const messageIds = owed.map((m) => m.id);
    try {
      await this.#takeTurn(me, { mode: 'answer', messageIds });
    } catch (error) {
      this.#post(me, `(my turn failed: ${error.message})`, null, messageIds);
    }
  }

  // Begins the run at once: Claude first (when connected), then the cards, for each round.
  // Why a run cannot start right now, or null when it can.
  startError() {
    if (this.state !== 'idle') return 'an agent run is already in progress';
    const { lineup } = this.store.board.colab;
    const unset = lineup.agents.findIndex((a) => !a.model);
    if (unset >= 0) return `Agent ${unset + 1} has no model`;
    const roles = new Set(this.library.get().roles.map((r) => r.id));
    const missing = lineup.agents.find((a) => !roles.has(a.roleId));
    if (missing) return `role "${missing.roleId}" is not in the role library`;
    if (this.claude.via() === 'none' && !lineup.agents.length) return 'no one is connected to start a run';
    return null;
  }

  start(kickoffId) {
    const error = this.startError();
    if (error) throw new OpError(error);
    const { lineup } = this.store.board.colab;
    const order = [...(this.claude.via() !== 'none' ? ['claude'] : []), ...cardIds(lineup.agents)];

    this.ensureRoster();
    this.agents = order;
    this.kickoffId = kickoffId ?? null;
    this.spent = 0;
    // Saved at once, so a restart during the very first turn still gets its note.
    this.store.setColabRun({ round: 1, spent: 0 });
    this.#setState('running', { round: 1, rounds: lineup.rounds, current: null });
    this.finished = this.#loop().catch((error) => {
      this.#note(`Agent run stopped: ${error.message}`);
      this.#end();
    });
  }

  // Ends the run after the current turn, cutting that turn's call short. Answers go on.
  stop() {
    if (this.state !== 'running') return;
    this.#setState('stopping');
    const work = this.#busy.get(this.current);
    if (work?.mode === 'turn') work.controller.abort(new TurnCut('stop'));
  }

  recoverAfterRestart() {
    const run = this.store.board.colab.run;
    if (!run) return;
    this.#note(`The agent run stopped when the server restarted, during round ${run.round}; ${money(run.spent)} spent.`);
    this.store.setColabRun(null);
  }

  #note(text) {
    // answers: [] so a note never marks the host's messages handled.
    this.store.apply({ type: 'chat', text, answers: [] }, 'claude');
  }

  #noteBudget() {
    if (this.#budgetNoted) return;
    this.#budgetNoted = true;
    const { colab } = this.store.board;
    this.#note(`OpenRouter agents stopped: budget of $${colab.lineup.budget} reached (${money(colab.spent ?? 0)} spent). Raise the budget or press Reset to go on.`);
  }

  #end() {
    this.store.setColabRun(null);
    this.#setState('idle', { current: null });
  }

  async #loop() {
    const cards = this.agents.some((id) => id !== 'claude');
    for (let round = 1; round <= this.rounds; round += 1) {
      for (const id of this.agents) {
        if (this.state === 'stopping') return this.#end();
        // Claude doesn't carry on alone once the cards are out of budget.
        if (cards && this.overBudget()) {
          this.#note(`Agent run stopped: budget of $${this.store.board.colab.lineup.budget} reached (${money(this.store.board.colab.spent ?? 0)} spent).`);
          return this.#end();
        }
        this.#setState(this.state, { round, current: id });
        const outcome = id === 'claude' ? await this.#claudeTurn() : await this.#exclusive(id, () => this.#cardTurn(id));
        if (outcome === 'end') return this.#end();
        this.store.setColabRun({ round, spent: this.spent });
        this.#emit();
      }
    }
    return this.#end();
  }

  // A card's run turn; 'end' when OpenRouter refuses the key or is out of credits.
  async #cardTurn(id) {
    // It may have waited for its answer to finish while Stop was pressed.
    if (this.state === 'stopping') return null;
    const me = this.store.board.colab.roster.find((r) => r.id === id);
    try {
      await this.#takeTurn(me, { mode: 'turn' });
    } catch (error) {
      if (error instanceof OpenRouterError && (error.status === 401 || error.status === 402)) {
        const why = error.status === 402 ? 'out of credits' : 'the API key was refused';
        this.#note(`Agent run stopped: OpenRouter says ${why} (${error.message}).`);
        return 'end';
      }
      this.#post(me, `(my turn failed: ${error.message})`, null, []);
    }
    return null;
  }

  // The others in the room, by name, for a prompt.
  #others(meId) {
    const { colab } = this.store.board;
    const ids = this.state === 'idle' ? [...(this.claude.via() !== 'none' ? ['claude'] : []), ...cardIds(colab.lineup.agents)] : this.agents;
    return ids
      .filter((id) => id !== meId)
      .map((id) => (id === 'claude' ? { id, name: colab.claudeName ?? 'Claude' } : colab.roster.find((r) => r.id === id)))
      .filter(Boolean);
  }

  // Claude's run turn, through the binary or the MCP session. It posts as 'claude'.
  async #claudeTurn() {
    const via = this.claude.via();
    if (via === 'none') return null; // disconnected since the run started
    const { store } = this;
    const board = store.board;
    const me = { id: 'claude', name: board.colab.claudeName ?? 'Claude' };
    const others = this.#others('claude').map((o) => o.name);
    const mark = this.conversations.get('claude');
    const body = mark
      ? updateMessage(board, me, {
          changes: store.historyLog.entries().filter((e) => e.seq > mark.seq && e.author !== 'claude'),
          messages: board.chat.slice(mark.chat).filter((m) => m.role !== 'claude'),
        })
      : turnMessage(board, me, null);
    const intro = others.length ? `You are ${me.name}, taking turns on the board with ${names(others)} in the agents' run.` : `You are ${me.name}, taking a turn on the board in the agents' run.`;
    const prompt = `${intro}\n\n${body}`;
    this.conversations.set('claude', { seq: lastSeq(store), chat: board.chat.length });

    const work = { mode: 'turn', controller: new AbortController(), activity: 'thinking', done: [] };
    this.#busy.set('claude', work);
    this.#emit();
    const { signal } = work.controller;
    const timeoutMs = this.turnLimit;
    const deadline = Date.now() + timeoutMs;
    const outOfTime = `(out of time after ${minutes(timeoutMs)})`;
    const stopped = '(stopped partway through my turn)';
    const binaryTurn = async (ms) => {
      const result = await this.claude.takeTurn(`${prompt}\n\n${BINARY_TURN_END}`, { timeoutMs: ms, signal });
      if (result.ok) this.#post(me, result.text?.trim() || '(said nothing)', null, []);
      else this.#post(me, signal.aborted ? stopped : `(my turn failed: ${result.error})`, null, []);
    };
    try {
      if (via === 'mcp') {
        // A reply has already been posted by the session itself.
        let replied;
        try {
          replied = await this.presence.offerTurn(prompt, { timeoutMs, signal });
        } catch (error) {
          this.#post(me, `(my turn failed: ${error.message})`, null, []);
          return null;
        }
        // The session went before taking its turn: the binary takes it with the time left, if there is one.
        if (replied === 'detached') {
          if (this.claude.found) await binaryTurn(deadline - Date.now());
          else this.#post(me, '(not connected)', null, []);
        } else if (!replied) this.#post(me, signal.aborted ? stopped : outOfTime, null, []);
      } else {
        await binaryTurn(timeoutMs);
      }
    } finally {
      this.#busy.delete('claude');
      this.#emit();
    }
    return null;
  }

  #post(entry, text, stats, answers) {
    const fit = text.length > MAX_POST ? `${text.slice(0, MAX_POST)}… (cut)` : text;
    this.store.apply({ type: 'chat', text: fit, answers, ...(stats ? { stats } : {}) }, entry.id);
  }

  // One go for a card: a run turn ('turn') or an answer to the host's messages ('answer').
  async #takeTurn(me, { mode, messageIds = [] }) {
    const { store } = this;
    const board = store.board;
    const library = this.library.get();
    const role = library.roles.find((r) => r.id === me.roleId);
    if (!role) throw new Error(`role "${me.roleId}" is not in the role library`);
    const { extras, lineup } = board.colab;
    const system = systemPrompt({ me, others: this.#others(me.id), job: joinLayers(role.job, extras.roles?.[me.roleId]), rules: joinLayers(library.rules, extras.rules), mode });
    const caching = marksCache(me.model);
    let convo = this.conversations.get(me.id);
    if (convo && JSON.stringify(convo.messages).length > this.maxConversation) convo = null;
    if (!convo) {
      // First go, or starting over: the chat so far and the whole board, so it need not ask.
      const snapshot = toolText(await createToolRunner(store, null, { author: me.id }).call('view_board', {}));
      const first = turnMessage(board, me, snapshot, { mode });
      convo = { messages: [{ role: 'system', content: '' }, { role: 'user', content: caching ? marked(first) : first }] };
    } else {
      // Later goes: only what others (and the host) did since its last one.
      const changes = store.historyLog.entries().filter((e) => e.seq > convo.seq && e.author !== me.id);
      const said = board.chat.slice(convo.chat).filter((m) => m.role !== me.id);
      // Keep cache markers to a few: the newest update carries one, older updates lose theirs.
      if (caching && convo.marked) convo.messages[convo.marked].content = plain(convo.messages[convo.marked].content);
      const answering = board.chat.filter((m) => messageIds.includes(m.id));
      const update = mode === 'answer' ? answerMessage(board, me, { changes, messages: said, answering }) : updateMessage(board, me, { changes, messages: said });
      convo.messages.push({ role: 'user', content: caching ? marked(update) : update });
      convo.marked = caching ? convo.messages.length - 1 : null;
    }
    // It has seen everything up to now; what others do while it works comes next time.
    convo.seq = lastSeq(store);
    convo.chat = board.chat.length;
    // Role and rule edits apply from the next go.
    convo.messages[0].content = caching ? marked(system) : system;
    this.conversations.set(me.id, convo);
    const { messages } = convo;
    const canPicture = Boolean(this.pictures?.canMake(me.id));
    const tools = TOOLS.filter((t) => !HIDDEN_TOOLS.has(t.name) && (t.name !== 'generate_image' || canPicture)).map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
    const settings = lineup.agents[cardIds(lineup.agents).indexOf(me.id)]?.settings;

    // What this go took, shown under its chat note (to see whether the cache is working).
    const started = Date.now();
    const stats = { seconds: 0, cost: 0, calls: 0, promptTokens: 0, cachedTokens: 0 };

    // Stop (run turns only), and the time limit, cut the call in progress short.
    const work = { mode, controller: new AbortController(), activity: null, done: [] };
    this.#busy.set(me.id, work);
    const doing = (activity) => {
      work.activity = activity;
      this.#emit();
    };
    const turnLimit = this.turnLimit;
    const deadline = cutAfter(turnLimit);
    let closing = null;
    let signal = AbortSignal.any([work.controller.signal, deadline.signal]);

    // Money this go spent (a call or a picture): on the go's stats, the run's tally and the status.
    const spend = (cost) => {
      stats.cost += cost;
      if (mode === 'turn') {
        this.spent += cost;
        store.setColabRun({ round: this.round, spent: this.spent });
        // The run's own note covers this crossing; answers don't note it again.
        if (this.overBudget()) this.#budgetNoted = true;
      } else if (this.overBudget()) this.#noteBudget();
      this.#emit();
    };
    // A picture call sees the go's signal at the time (the closing grace replaces it).
    const runner = createToolRunner(store, this.presence, { author: me.id, pictures: this.pictures, signal: () => signal, onSpend: spend });

    const ask = async (withTools) => {
      // Spent reached the budget: no new call starts.
      if (this.overBudget()) throw new TurnCut('budget');
      doing('thinking');
      // Counted when made, so a call cut short still shows.
      stats.calls += 1;
      const { message, cost, promptTokens, cachedTokens } = await this.openrouter.complete({ model: me.model, messages, tools: withTools ? tools : undefined, settings, signal });
      store.addColabSpend(cost ?? 0);
      stats.promptTokens += promptTokens ?? 0;
      stats.cachedTokens += cachedTokens ?? 0;
      spend(cost ?? 0);
      messages.push(message);
      return message;
    };

    // A cut call tells why; any other error fails the go.
    const whyCut = (error) => {
      if (!(error instanceof TurnCut)) throw error;
      return error.why;
    };
    const wrapUp = mode === 'answer' ? 'Write your short answer to the host now.' : 'Write your short message to the others now.';
    let reply = null;
    let cut = null;
    // Picture messages added this go; swapped for a short note when it ends so no image data is kept.
    const shownPictures = [];
    try {
      try {
        for (let step = 0; step < MAX_STEPS && !signal.aborted; step += 1) {
          reply = await ask(true);
          if (!reply.tool_calls?.length) break;
          for (const call of reply.tool_calls) {
            let content;
            let pictureParts = [];
            try {
              doing(activityFor(call.function.name, call.function.arguments));
              const args = JSON.parse(call.function.arguments || '{}');
              const output = await runner.call(call.function.name, args);
              content = toolText(output);
              const images = (output?.mcpContent ?? []).filter((c) => c.type === 'image');
              if (images.length && !this.visionModels.has(me.model)) content += "\nThis model can't see images.";
              else pictureParts = images.map((c) => ({ id: args.id, part: { type: 'image_url', image_url: { url: `data:${c.mimeType};base64,${c.data}` } } }));
              const step = doneFor(call.function.name, call.function.arguments);
              // Reading the board twice in a row is one step to the reader.
              if (work.done.at(-1) !== step) work.done.push(step);
            } catch (error) {
              content = `Error: ${error.message}`;
            }
            messages.push({ role: 'tool', tool_call_id: call.id, content });
            for (const { id, part } of pictureParts) {
              const message = { role: 'user', content: [{ type: 'text', text: 'The picture you asked to see:' }, part] };
              messages.push(message);
              shownPictures.push({ message, id });
            }
          }
          reply = null;
        }
      } catch (error) {
        cut = whyCut(error);
      }
      cut ??= signal.aborted ? signal.reason.why : null;
      if (!reply && cut !== 'stop' && cut !== 'budget') {
        // Out of tool calls or out of time: ask for the closing message without tools.
        if (cut === 'time') {
          // Past the limit it gets a short grace of its own; Stop still cuts it.
          closing = cutAfter(this.closingLimit);
          signal = AbortSignal.any([work.controller.signal, closing.signal]);
        }
        messages.push({ role: 'user', content: cut === 'time' ? `Your ${minutes(turnLimit)} turn is up. ${wrapUp}` : `You are out of moves for this turn. ${wrapUp}` });
        try {
          reply = await ask(false);
        } catch (error) {
          cut = whyCut(error);
        }
      }
    } finally {
      for (const { message, id } of shownPictures) Object.assign(message, { content: `[picture ${id} shown]` });
      deadline.clear();
      closing?.clear();
      this.#busy.delete(me.id);
      // Also when the go failed, so its card stops showing it thinking.
      this.#emit();
    }
    const said = reply ? stripSelfTag(reply.content?.trim() ?? '', me.name).trim() || '(said nothing)' : null;
    const cutText = { stop: '(stopped partway through my turn)', budget: '(stopped: budget reached)' }[cut] ?? `(out of time after ${minutes(turnLimit)}; my changes so far are on the board)`;
    stats.seconds = Math.round((Date.now() - started) / 100) / 10;
    this.#post(me, said ?? cutText, stats, mode === 'answer' ? messageIds : []);
    if (cut === 'budget' && mode === 'answer') this.#noteBudget();
    this.#emit();
  }
}
