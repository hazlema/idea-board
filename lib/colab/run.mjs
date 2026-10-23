// The agent run: the line-up's models take turns editing the board through
// the same tools Claude uses, posting a chat message at the end of each turn.
import { OpError } from '../board.mjs';
import { agentId } from '../authors.mjs';
import { TOOLS, createToolRunner } from '../mcp.mjs';
import { OpenRouterError } from './openrouter.mjs';
import { stripSelfTag, systemPrompt, turnMessage } from './prompts.mjs';

const MAX_STEPS = 15; // tool calls per turn
// Tools that block, rewind other people's work, or answer for the host.
const HIDDEN_TOOLS = new Set(['wait_for_chat', 'reply', 'undo_reply', 'restore_version']);
const COLORS = ['amber', 'sky', 'green', 'violet', 'rose'];

const nameOf = (model) =>
  model
    .split('/')
    .pop()
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());

const money = (n) => `$${n.toFixed(2)}`;
const joinLayers = (base, extra) => (extra?.trim() ? `${base}\n\n${extra}` : base);
const toolText = (output) => (output?.mcpContent ? output.mcpContent.map((c) => c.text ?? '').join('\n') : JSON.stringify(output));

export class ColabRun {
  constructor({ store, presence, library, openrouter }) {
    this.store = store;
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
    this.knownMessages = new Set();
    // Resolves when the loop of the current run has ended (for tests and shutdown).
    this.finished = Promise.resolve();
  }

  get status() {
    const { state, round, rounds, current, spent, budget } = this;
    return { state, round, rounds, current, spent, budget };
  }

  #setState(state, fields = {}) {
    Object.assign(this, { state }, fields);
    this.store.emit({ type: 'colab', status: this.status });
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
      const modelName = nameOf(a.model);
      added.push({ id, model: a.model, roleId: a.roleId, name: `${modelName} · ${roles.get(a.roleId).name}`, modelName, color: COLORS[(roster.length + added.length) % COLORS.length] });
    }
    if (added.length) this.store.addColabRoster(added);

    this.agents = lineup.agents.map((a) => agentId(a.model, a.roleId));
    this.knownMessages = new Set(this.store.board.chat.map((m) => m.id));
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
    else if (this.state === 'running') this.#setState('stopping');
  }

  recoverAfterRestart() {
    const run = this.store.board.colab.run;
    if (!run) return;
    this.#note(`The agent run stopped when the server restarted, after round ${run.round}; ${money(run.spent)} spent.`);
    this.store.setColabRun(null);
  }

  #note(text) {
    this.store.apply({ type: 'chat', text }, 'claude');
  }

  #end() {
    this.store.setColabRun(null);
    this.#setState('idle', { current: null });
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
        this.store.emit({ type: 'colab', status: this.status });
      }
    }
    return this.#end();
  }

  #post(entry, text) {
    this.store.apply({ type: 'chat', text }, entry.id);
  }

  async #takeTurn(me) {
    const board = this.store.board;
    const library = this.library.get();
    const role = library.roles.find((r) => r.id === me.roleId);
    if (!role) throw new Error(`role "${me.roleId}" is not in the role library`);
    const { extras } = board.colab;
    const others = this.agents.filter((id) => id !== me.id).map((id) => board.colab.roster.find((r) => r.id === id));
    const messages = [
      { role: 'system', content: systemPrompt({ me, others, job: joinLayers(role.job, extras.roles?.[me.roleId]), rules: joinLayers(library.rules, extras.rules) }) },
      { role: 'user', content: turnMessage(board, me) },
    ];
    const tools = TOOLS.filter((t) => !HIDDEN_TOOLS.has(t.name)).map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
    const runner = createToolRunner(this.store, this.presence, { author: me.id });
    const settings = board.colab.lineup.agents.find((a) => agentId(a.model, a.roleId) === me.id)?.settings;

    const ask = async (withTools) => {
      const { message, cost } = await this.openrouter.complete({ model: me.model, messages, tools: withTools ? tools : undefined, settings });
      this.spent += cost ?? 0;
      messages.push(message);
      return message;
    };

    let reply;
    for (let step = 0; step < MAX_STEPS; step += 1) {
      reply = await ask(true);
      if (!reply.tool_calls?.length) break;
      for (const call of reply.tool_calls) {
        let content;
        try {
          content = toolText(await runner.call(call.function.name, JSON.parse(call.function.arguments || '{}')));
        } catch (error) {
          content = `Error: ${error.message}`;
        }
        messages.push({ role: 'tool', tool_call_id: call.id, content });
      }
      reply = null;
    }
    if (!reply) {
      // Out of tool calls: ask for the closing message without tools.
      messages.push({ role: 'user', content: 'You are out of moves for this turn. Write your short message to the others now.' });
      reply = await ask(false);
    }
    const text = stripSelfTag(reply.content?.trim() ?? '', me.name).trim();
    this.#post(me, text || '(said nothing)');
  }
}
