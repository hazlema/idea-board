// The agent run: the line-up's models take turns editing the board through
// the same tools Claude uses, posting a chat message at the end of each turn.
import { OpError, TURN_LIMIT } from '../board.mjs';
import { agentId } from '../authors.mjs';
import { TOOLS, createToolRunner } from '../mcp.mjs';
import { OpenRouterError } from './openrouter.mjs';
import { stripSelfTag, systemPrompt, turnMessage, updateMessage } from './prompts.mjs';

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
const joinLayers = (base, extra) => (extra?.trim() ? `${base}\n\n${extra}` : base);
// A conversation longer than this (in characters, roughly 4 per token) starts over with the full board.
const MAX_CONVERSATION = 400_000;

// Claude and Gemini on OpenRouter cache a prompt prefix only up to a marked block; OpenAI,
// DeepSeek and others cache long prefixes on their own.
const marksCache = (model) => /^~?(anthropic|google)\//.test(model);
const marked = (text) => [{ type: 'text', text, cache_control: { type: 'ephemeral' } }];
const plain = (content) => (Array.isArray(content) ? content.map((p) => p.text).join('') : content);

// Why a turn was cut short: 'time' (its limit) or 'stop' (the host pressed Stop).
class TurnCut extends Error {
  constructor(why) {
    super(why === 'time' ? 'out of time' : 'stopped');
    this.why = why;
  }
}

// A signal that aborts with a TurnCut after `ms`; clear() cancels the timer.
function cutAfter(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new TurnCut('time')), ms);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

const minutes = (ms) => `${Math.round(ms / 60_000)} min`;

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
  #stopTurn = null;

  #fixedTurnLimit;

  // turnLimit (ms) overrides the line-up's minutes, for tests.
  constructor({ store, presence, library, openrouter, maxConversation = MAX_CONVERSATION, turnLimit = null, closingLimit = CLOSING_LIMIT }) {
    this.store = store;
    this.maxConversation = maxConversation;
    this.#fixedTurnLimit = turnLimit;
    this.turnLimit = turnLimit ?? TURN_LIMIT * 60_000;
    this.closingLimit = closingLimit;
    // Each agent's conversation, kept between its turns: { messages, seq, chat } where seq and
    // chat mark the history entry and chat length it last saw.
    this.conversations = new Map();
    this.presence = presence;
    this.library = library;
    this.openrouter = openrouter;
    this.state = 'idle';
    this.round = 0;
    this.rounds = 0;
    this.current = null;
    this.spent = 0;
    this.budget = 0;
    this.agents = [];
    this.modelNames = new Map();
    this.knownMessages = new Set();
    // What the working agent is doing right now ("reading the board"), shown on the page.
    this.activity = null;
    // What it has done so far this turn ("read the board", "made 3 changes"): most of a turn
    // is the model thinking, so this is what shows progress.
    this.done = [];
    // Resolves when the loop of the current run has ended (for tests and shutdown).
    this.finished = Promise.resolve();
  }

  get status() {
    const { state, round, rounds, current, spent, budget, activity, done } = this;
    return { state, round, rounds, current, spent, budget, activity, done: [...done] };
  }

  #setState(state, fields = {}) {
    Object.assign(this, { state }, fields);
    this.store.emit({ type: 'colab', status: this.status });
  }

  // Looks up the models' display names before start(); offline just means the id-based names.
  async prepare() {
    try {
      this.modelNames = new Map((await this.openrouter.models()).map((m) => [m.id, cleanName(m.name ?? '')]));
    } catch {
      this.modelNames = new Map();
    }
  }

  start() {
    if (this.state !== 'idle') throw new OpError('an agent run is already in progress');
    const { lineup } = this.store.board.colab;
    if (!lineup.agents.length) throw new OpError('add at least one agent to the line-up');
    const unset = lineup.agents.findIndex((a) => !a.model);
    if (unset >= 0) throw new OpError(`Agent ${unset + 1} has no model`);
    const roles = new Map(this.library.get().roles.map((r) => [r.id, r]));
    for (const a of lineup.agents) if (!roles.has(a.roleId)) throw new OpError(`role "${a.roleId}" is not in the role library`);

    const roster = this.store.board.colab.roster;
    const added = [];
    for (const a of lineup.agents) {
      const id = agentId(a.model, a.roleId);
      if (roster.some((r) => r.id === id) || added.some((r) => r.id === id)) continue;
      const modelName = this.modelNames.get(a.model) || nameOf(a.model);
      added.push({ id, model: a.model, roleId: a.roleId, name: `${modelName} · ${roles.get(a.roleId).name}`, modelName, color: COLORS[(roster.length + added.length) % COLORS.length] });
    }
    if (added.length) this.store.addColabRoster(added);

    this.agents = lineup.agents.map((a) => agentId(a.model, a.roleId));
    this.turnLimit = this.#fixedTurnLimit ?? (lineup.turnLimit ?? TURN_LIMIT) * 60_000;
    this.knownMessages = new Set(this.store.board.chat.map((m) => m.id));
    this.conversations = new Map();
    this.#setState('waiting', { round: 0, rounds: lineup.rounds, current: null, spent: 0, budget: lineup.budget });
  }

  // Only a message posted after start() begins the run.
  onUserMessage() {
    if (this.state !== 'waiting') return;
    if (!this.store.board.chat.some((m) => m.role === 'user' && !this.knownMessages.has(m.id))) return;
    // Saved at once, so a restart during the very first turn still gets its note.
    this.store.setColabRun({ round: 1, spent: 0 });
    this.#setState('running', { round: 1 });
    this.finished = this.#loop().catch((error) => {
      this.#note(`Agent run stopped: ${error.message}`);
      this.#end();
    });
  }

  stop() {
    if (this.state === 'waiting') this.#end();
    else if (this.state === 'running') {
      this.#setState('stopping');
      // Don't wait out a slow model: cut the turn's call short.
      this.#stopTurn?.();
    }
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

  #end() {
    this.store.setColabRun(null);
    this.#setState('idle', { current: null, activity: null, done: [] });
  }

  #doing(activity) {
    this.activity = activity;
    this.store.emit({ type: 'colab', status: this.status });
  }

  async #loop() {
    for (let round = 1; round <= this.rounds; round += 1) {
      for (const id of this.agents) {
        if (this.state === 'stopping') return this.#end();
        if (this.spent >= this.budget) {
          this.#note(`Agent run stopped: budget of $${this.budget} reached (${money(this.spent)} spent).`);
          return this.#end();
        }
        this.#setState(this.state, { round, current: id });
        try {
          await this.#takeTurn(this.store.board.colab.roster.find((r) => r.id === id));
        } catch (error) {
          if (error instanceof OpenRouterError && (error.status === 401 || error.status === 402)) {
            const why = error.status === 402 ? 'out of credits' : 'the API key was refused';
            this.#note(`Agent run stopped: OpenRouter says ${why} (${error.message}).`);
            return this.#end();
          }
          this.#post(this.store.board.colab.roster.find((r) => r.id === id), `(my turn failed: ${error.message})`);
        }
        this.store.setColabRun({ round, spent: this.spent });
        this.activity = null;
        this.done = [];
        this.store.emit({ type: 'colab', status: this.status });
      }
    }
    return this.#end();
  }

  #post(entry, text, stats) {
    const fit = text.length > MAX_POST ? `${text.slice(0, MAX_POST)}… (cut)` : text;
    this.store.apply({ type: 'chat', text: fit, ...(stats ? { stats } : {}) }, entry.id);
  }

  async #takeTurn(me) {
    const board = this.store.board;
    const library = this.library.get();
    const role = library.roles.find((r) => r.id === me.roleId);
    if (!role) throw new Error(`role "${me.roleId}" is not in the role library`);
    const { extras } = board.colab;
    const others = this.agents.filter((id) => id !== me.id).map((id) => board.colab.roster.find((r) => r.id === id));
    const system = systemPrompt({ me, others, job: joinLayers(role.job, extras.roles?.[me.roleId]), rules: joinLayers(library.rules, extras.rules) });
    const caching = marksCache(me.model);
    let convo = this.conversations.get(me.id);
    if (convo && JSON.stringify(convo.messages).length > this.maxConversation) convo = null;
    if (!convo) {
      // First turn, or starting over: the chat so far and the whole board, so it need not ask.
      const snapshot = toolText(await createToolRunner(this.store, null, { author: me.id }).call('view_board', {}));
      const first = turnMessage(board, me, snapshot);
      // It has seen everything up to now; a turn that fails partway still has a starting point.
      convo = {
        messages: [{ role: 'system', content: '' }, { role: 'user', content: caching ? marked(first) : first }],
        seq: this.store.historyLog.entries().at(-1)?.seq ?? 0,
        chat: board.chat.length,
      };
    } else {
      // Later turns: only what others (and the host) did since its last turn.
      const changes = this.store.historyLog.entries().filter((e) => e.seq > convo.seq && e.author !== me.id);
      const said = board.chat.slice(convo.chat).filter((m) => m.role !== me.id);
      // Keep cache markers to a few: the newest update carries one, older updates lose theirs.
      if (caching && convo.marked) convo.messages[convo.marked].content = plain(convo.messages[convo.marked].content);
      const update = updateMessage(board, me, { changes, messages: said });
      convo.messages.push({ role: 'user', content: caching ? marked(update) : update });
      convo.marked = caching ? convo.messages.length - 1 : null;
    }
    // Role and rule edits apply from the next turn.
    convo.messages[0].content = caching ? marked(system) : system;
    this.conversations.set(me.id, convo);
    const { messages } = convo;
    const tools = TOOLS.filter((t) => !HIDDEN_TOOLS.has(t.name)).map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
    const runner = createToolRunner(this.store, this.presence, { author: me.id });
    const settings = board.colab.lineup.agents.find((a) => agentId(a.model, a.roleId) === me.id)?.settings;

    // What this turn took, shown under its chat note (to see whether the cache is working).
    const started = Date.now();
    const stats = { seconds: 0, cost: 0, calls: 0, promptTokens: 0, cachedTokens: 0 };

    // Stop, and the turn's time limit, cut the call in progress short.
    const stopped = new AbortController();
    this.#stopTurn = () => stopped.abort(new TurnCut('stop'));
    const deadline = cutAfter(this.turnLimit);
    let closing = null;
    let signal = AbortSignal.any([stopped.signal, deadline.signal]);

    const ask = async (withTools) => {
      this.#doing('thinking');
      // Counted when made, so a call cut short still shows.
      stats.calls += 1;
      const { message, cost, promptTokens, cachedTokens } = await this.openrouter.complete({ model: me.model, messages, tools: withTools ? tools : undefined, settings, signal });
      this.spent += cost ?? 0;
      stats.cost += cost ?? 0;
      stats.promptTokens += promptTokens ?? 0;
      stats.cachedTokens += cachedTokens ?? 0;
      this.store.setColabRun({ round: this.round, spent: this.spent });
      this.store.emit({ type: 'colab', status: this.status });
      messages.push(message);
      return message;
    };

    // A cut call tells why; any other error fails the turn.
    const whyCut = (error) => {
      if (!(error instanceof TurnCut)) throw error;
      return error.why;
    };
    let reply = null;
    let cut = null;
    try {
      try {
        for (let step = 0; step < MAX_STEPS && !signal.aborted; step += 1) {
          reply = await ask(true);
          if (!reply.tool_calls?.length) break;
          for (const call of reply.tool_calls) {
            let content;
            try {
              this.#doing(activityFor(call.function.name, call.function.arguments));
              content = toolText(await runner.call(call.function.name, JSON.parse(call.function.arguments || '{}')));
              const step = doneFor(call.function.name, call.function.arguments);
              // Reading the board twice in a row is one step to the reader.
              if (this.done.at(-1) !== step) this.done.push(step);
            } catch (error) {
              content = `Error: ${error.message}`;
            }
            messages.push({ role: 'tool', tool_call_id: call.id, content });
          }
          reply = null;
        }
      } catch (error) {
        cut = whyCut(error);
      }
      cut ??= signal.aborted ? signal.reason.why : null;
      if (!reply && cut !== 'stop') {
        // Out of tool calls or out of time: ask for the closing message without tools.
        if (cut === 'time') {
          // Past the limit it gets a short grace of its own; Stop still cuts it.
          closing = cutAfter(this.closingLimit);
          signal = AbortSignal.any([stopped.signal, closing.signal]);
        }
        messages.push({
          role: 'user',
          content: cut === 'time' ? `Your ${minutes(this.turnLimit)} turn is up. Write your short message to the others now.` : 'You are out of moves for this turn. Write your short message to the others now.',
        });
        try {
          reply = await ask(false);
        } catch (error) {
          cut = whyCut(error);
        }
      }
    } finally {
      deadline.clear();
      closing?.clear();
      this.#stopTurn = null;
    }
    const said = reply ? stripSelfTag(reply.content?.trim() ?? '', me.name).trim() || '(said nothing)' : null;
    const text = said ?? (cut === 'stop' ? '(stopped partway through my turn)' : `(out of time after ${minutes(this.turnLimit)}; my changes so far are on the board)`);
    stats.seconds = Math.round((Date.now() - started) / 100) / 10;
    this.#post(me, text, stats);
    // Next turn starts from here.
    convo.seq = this.store.historyLog.entries().at(-1)?.seq ?? 0;
    convo.chat = this.store.board.chat.length;
  }
}
