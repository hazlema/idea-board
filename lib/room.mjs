// The chat room: Claude is connection 1 (the binary or an MCP session) and the
// OpenRouter cards are 2…N. A user's chat text becomes a posted message owed by
// the right connections, and the work it asks for is handed out.
import { OpError } from './board.mjs';
import { authorName, cardIds } from './authors.mjs';
import { parseCommand } from './commands.mjs';
import { joinLayers } from './colab/run.mjs';

const NO_IDS = new Set();
const NOBODY = 'No one is connected to answer. Connect Claude (see the sidebar) or add an OpenRouter connection.';
const REASONS = { 'not-connected': 'not connected', 'no-key': 'no OpenRouter key', 'over-budget': 'over budget', 'no-model': 'no model', 'no-role': 'role missing' };

export class Room {
  constructor({ store, agent, presence, colab, library }) {
    Object.assign(this, { store, agent, presence, colab, library });
    const role = () => this.roleText();
    presence.role = role;
    agent.role = role;
    // A session is not handed what the binary is already answering.
    presence.busy = () => agent.answering ?? NO_IDS;
    // The sidebar's `claude` field follows MCP attach and detach and the binary's work.
    store.subscribe((event) => {
      if (event.type === 'presence' || event.type === 'agent') store.emit({ type: 'colab', status: colab.status });
    });
  }

  get running() {
    return this.colab.status.state !== 'idle';
  }

  // Claude's role in words: its job and board extra, then the library's rules and the board's.
  roleText() {
    const { roles, rules } = this.library.get();
    const { lineup, extras } = this.store.board.colab;
    const role = roles.find((r) => r.id === lineup.claudeRoleId);
    const job = role ? joinLayers(role.job, extras.roles?.[role.id]) : '';
    const allRules = joinLayers(rules, extras.rules);
    return job ? joinLayers(job, allRules) : allRules;
  }

  connections() {
    const claude = this.agent.via() !== 'none'
      ? { n: 1, id: 'claude', kind: 'direct', available: true }
      : { n: 1, id: 'claude', kind: 'direct', available: false, why: 'not-connected' };
    const cards = cardIds(this.store.board.colab.lineup.agents).map((id, i) => {
      const can = this.colab.canAnswer(id);
      return { n: i + 2, id, kind: 'openrouter', available: can.ok, ...(can.ok ? {} : { why: can.why }) };
    });
    return [claude, ...cards];
  }

  userChat({ text, context }) {
    const command = parseCommand(text ?? '');
    if (command.kind === 'error') throw new OpError(command.error);
    const { running } = this;
    if (command.kind === 'stop') {
      if (!running) throw new OpError('No run is going.');
      this.colab.stop();
      return { stopped: true };
    }
    // Cards set up since the last line-up change (a role added to the library, say) join the roster.
    this.colab.ensureRoster();
    const connections = this.connections();
    const available = connections.filter((c) => c.available).map((c) => c.id);
    const op = { type: 'chat', text: command.text, context };
    if (command.kind === 'say') {
      op.owed = running ? [] : available;
    } else if (command.kind === 'chat') {
      const target = connections.find((c) => c.n === command.n);
      if (!target) throw new OpError(`No connection ${command.n}. Connections are numbered 1 to ${connections.length} in the sidebar.`);
      if (!target.available) throw new OpError(`${this.#name(target.id)} can't answer right now (${REASONS[target.why] ?? target.why}).`);
      op.to = [target.id];
      op.owed = running ? [] : [target.id];
    } else {
      if (running) throw new OpError('A run is already going. Use /stop first.');
      if (!available.length) throw new OpError('No one is connected to start a run.');
      // Checked before posting, so a refused start leaves no kickoff behind.
      const refused = this.colab.startError();
      if (refused) throw new OpError(refused);
      op.owed = [];
      op.start = true;
    }

    const result = this.store.apply(op, 'user');
    const { message } = result;
    if (command.kind === 'start') {
      this.colab.start(message.id);
      return result;
    }
    if (message.owed.includes('claude') && this.agent.via() === 'binary') this.agent.nudge();
    for (const id of message.owed) if (id !== 'claude') this.colab.answer(id);
    if (command.kind === 'say' && !running && !available.length) {
      // answers: [] so the note never marks the message handled.
      this.store.apply({ type: 'chat', text: NOBODY, answers: [] }, 'claude');
    }
    return result;
  }

  #name(id) {
    if (id !== 'claude') {
      const entry = this.store.board.colab.roster.find((r) => r.id === id);
      if (!entry) return `Connection ${cardIds(this.store.board.colab.lineup.agents).indexOf(id) + 2}`;
    }
    return authorName(this.store.board, id);
  }

  lineupChanged() {
    this.colab.ensureRoster();
    const role = this.library.get().roles.find((r) => r.id === this.store.board.colab.lineup.claudeRoleId);
    const name = role ? `Claude · ${role.name}` : 'Claude';
    if (this.store.board.colab.claudeName !== name) this.store.apply({ type: 'setClaudeName', name }, 'user');
    this.colab.budgetChanged();
  }

  resetSpent() {
    this.store.apply({ type: 'resetColabSpent' }, 'user');
    this.colab.budgetChanged();
  }

  // After a restart: no answer is in flight any more, so only Claude's debts (which the
  // binary or a session picks up) are kept.
  recover() {
    this.colab.recoverAfterRestart();
    this.store.pruneOwed('claude');
    const { roles } = this.library.get();
    const { lineup } = this.store.board.colab;
    if (roles.length && !roles.some((r) => r.id === lineup.claudeRoleId)) {
      const claudeRoleId = roles.some((r) => r.id === 'foreman') ? 'foreman' : roles[0].id;
      this.store.apply({ type: 'setColabLineup', ...lineup, claudeRoleId }, 'user');
    }
    this.lineupChanged();
  }
}
