// The foreman's requests: outside a run, whoever holds the Foreman role can ask other agents
// for work as a chain of steps. The host approves the whole chain once; then each step goes
// out as a host message to its agent, after the agent before it has answered.
import { authorName } from './authors.mjs';
import { ConflictError, OpError, now, shortId, text } from './board.mjs';
import { REASONS } from './room.mjs';

const MAX_STEPS = 10;
// An answer that didn't get the work done: the post a failed, stopped or timed-out go leaves.
const FAILED = /^\((my turn failed|stopped|out of time)/;

const listed = (names) => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} or ${names.at(-1)}`);

// Whether `author` ('claude' or a roster id) holds the Foreman role.
export function holdsForeman(board, author) {
  const { colab } = board;
  if (author === 'claude') return colab.lineup.claudeRoleId === 'foreman';
  return colab.roster.some((r) => r.id === author && r.roleId === 'foreman');
}

export class ForemanRequests {
  #playing = null;
  #controller = null;
  // The step under way: its message and who owes it.
  #current = null;

  // `room` gives connections() and dispatch(message); `colab` gives status and cutAnswer(id).
  constructor({ store, room, colab }) {
    Object.assign(this, { store, room, colab });
  }

  get #request() {
    return this.store.board.colab.request ?? null;
  }

  // A request is waiting for the host or playing out.
  get busy() {
    return Boolean(this.#request);
  }

  // Resolves when no chain is playing.
  async settled() {
    while (this.#playing) await this.#playing;
  }

  // The foreman asks; the chain waits for the host. Everything is checked first, so the host
  // is never asked to approve a chain that can't run. An audit may ask while the run and the
  // audit are still going: the chain waits for both to end (see #play).
  ask(author, steps, { audit = false } = {}) {
    const { board } = this.store;
    if (!holdsForeman(board, author)) throw new OpError('Only the Foreman can ask other agents for work.');
    const status = this.colab.status;
    if (!audit && status.state !== 'idle') throw new OpError('A run is going: say it in the chat instead, and the next agent will pick it up.');
    if (!audit && status.auditing) throw new OpError('An audit is going; ask when it has finished.');
    if (this.busy) throw new OpError('A request is already waiting for the host or under way.');
    if (!Array.isArray(steps) || steps.length < 1 || steps.length > MAX_STEPS) throw new OpError(`steps must list 1 to ${MAX_STEPS} requests`);
    const connections = this.room.connections();
    const checked = steps.map((step) => {
      const query = text(step?.agent, 'agent', { required: true, max: 200 });
      const request = text(step?.request, 'request', { required: true, max: 4000 });
      const to = this.#match(connections, query);
      if (to.id === author) throw new OpError("You can't ask yourself.");
      const name = authorName(board, to.id);
      if (!to.available) throw new OpError(`${name} can't answer right now (${REASONS[to.why] ?? to.why}).`);
      return { to: to.id, name, text: request };
    });
    const id = shortId('r');
    this.store.setColabRequest({ id, by: author, at: now(), state: 'waiting', step: 0, steps: checked });
    const lines = checked.map((s, i) => `${i + 1}. ${s.name}: ${s.text}`);
    this.store.apply({ type: 'chat', text: `Asking the host to approve:\n${lines.join('\n')}`, answers: [] }, author);
    return { waiting: true, id };
  }

  // An exact connection id, else one connection whose name contains `query` (any case).
  #match(connections, query) {
    const exact = connections.find((c) => c.id === query);
    if (exact) return exact;
    const wanted = query.toLowerCase();
    const found = connections.filter((c) => authorName(this.store.board, c.id).toLowerCase().includes(wanted));
    if (!found.length) throw new OpError(`No agent called "${query}".`);
    if (found.length > 1) throw new OpError(`"${query}" could mean ${listed(found.map((c) => authorName(this.store.board, c.id)))}; use the id.`);
    return found[0];
  }

  // The host's Yes or No. Only the waiting request's id counts; a second tab's answer is refused.
  answer(id, yes) {
    const request = this.#request;
    if (!request || request.id !== id || request.state !== 'waiting') throw new ConflictError('That request has already been answered.');
    if (!yes) {
      this.store.setColabRequest(null);
      this.store.apply({ type: 'chat', text: 'The host declined the request.', owed: [] }, 'user');
      return { ok: true };
    }
    this.#controller = new AbortController();
    const playing = this.#play(request, this.#controller.signal).finally(() => {
      if (this.#playing === playing) this.#playing = null;
    });
    this.#playing = playing;
    return { ok: true };
  }

  // Stop: drops a waiting request, or the rest of a playing chain (cutting a card's answer).
  cancel() {
    const request = this.#request;
    if (!request) return false;
    if (request.state === 'waiting') {
      this.store.setColabRequest(null);
      this.#stoppedAt(request, 'stopped');
      return true;
    }
    this.#controller?.abort();
    const current = this.#current;
    if (current) {
      // Off its agent's list, so an answer still queued finds nothing to do; one under way is cut.
      this.store.dropOwed(current.messageId, current.to);
      if (current.to === 'claude') this.room.agent?.cutAnswer(current.messageId);
      else this.colab.cutAnswer(current.to);
    }
    return true;
  }

  // After a restart nothing is in flight any more: a request left over is dropped.
  recoverAfterRestart() {
    if (!this.#request) return;
    this.store.setColabRequest(null);
    this.#note("The foreman's request was dropped when the server restarted.");
  }

  async #play(request, signal) {
    try {
      // Filed by an audit: nothing goes out until the run and the audit are over.
      const { state, auditing } = this.colab.status;
      if (state !== 'idle' || auditing) await this.colab.settled();
      if (signal.aborted) return;
      for (let i = 0; i < request.steps.length; i += 1) {
        const step = request.steps[i];
        const conn = this.room.connections().find((c) => c.id === step.to);
        if (!conn?.available) {
          this.#stoppedAt({ ...request, step: i }, conn ? REASONS[conn.why] ?? conn.why : 'no longer connected');
          return;
        }
        this.store.setColabRequest({ ...request, state: 'playing', step: i });
        const { message } = this.store.apply({ type: 'chat', text: step.text, to: [step.to], owed: [step.to], request: { by: request.by, step: i + 1, of: request.steps.length } }, 'user');
        this.#current = { messageId: message.id, to: step.to };
        this.room.dispatch(message);
        const outcome = await this.#answered(message, step.to, signal);
        if (outcome !== 'answered') {
          this.#stoppedAt({ ...request, step: i }, outcome === 'failed' ? 'the answer failed' : 'stopped');
          return;
        }
      }
    } finally {
      this.store.setColabRequest(null);
      this.#controller = null;
      this.#current = null;
    }
  }

  // Resolves 'answered', 'failed' or 'cancelled' once `to` no longer owes `message`, its
  // answer failed, or the chain was cancelled.
  #answered(message, to, signal) {
    const { store } = this;
    const owed = () => Boolean(store.board.chat.find((m) => m.id === message.id)?.owed?.includes(to));
    return new Promise((resolve) => {
      let unsubscribe = () => {};
      const done = (outcome) => {
        unsubscribe();
        signal.removeEventListener('abort', onAbort);
        resolve(outcome);
      };
      const onAbort = () => done('cancelled');
      const check = (event) => {
        // The binary's failed answer leaves the message owed; its error event names the messages.
        if (event?.type === 'agent' && event.state === 'error' && event.ids?.includes(message.id) && owed()) return done('failed');
        if (owed()) return;
        const at = store.board.chat.findIndex((m) => m.id === message.id);
        const reply = store.board.chat.slice(at + 1).findLast((m) => m.role === to);
        done(FAILED.test(reply?.text ?? '') ? 'failed' : 'answered');
      };
      if (signal.aborted) return done('cancelled');
      signal.addEventListener('abort', onAbort, { once: true });
      unsubscribe = store.subscribe(check);
      check();
    });
  }

  #stoppedAt(request, why) {
    const step = request.steps[request.step];
    this.#note(`The foreman's request stopped at step ${request.step + 1} (${step.name}): ${why}.`);
  }

  #note(textOut) {
    // answers: [] so a note never marks the host's messages handled.
    this.store.apply({ type: 'chat', text: textOut, answers: [] }, 'claude');
  }
}
