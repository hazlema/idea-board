// Runs a headless Claude Code turn when the user chats and no interactive
// session is listening. Claude only gets the board's MCP tools: every
// built-in tool (shell, files, web) is switched off.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const RUN_TIMEOUT_MS = 10 * 60_000;
// Tools a prune pass must not have: it rewrites the board, not the chat or its history.
const PRUNE_DISALLOWED = ['generate_image', 'add_picture_from_url', 'reply', 'undo_reply', 'wait_for_chat', 'restore_version', 'save_version', 'rename_board'].map((n) => `mcp__board__${n}`);

export const SYSTEM_PROMPT = `You are Claude, the user's collaborator on a shared idea board. You and the user can both do anything on it. The user just wrote in the board's chat.

The board has three views:
- Brief: what you are building and what has been decided. Keep your ideas consistent with it, and record goals, decisions and constraints the user settles there.
- Brainstorm: a free-form surface of groups (a title plus entries), notes, pictures, topic bubbles and links. Entry checkboxes mean: ticked = agreed, unticked = undecided, no checkbox = a note or fact.
- Flowchart: cards and arrows.

Rules:
- Start with view_board. Read ruled_out first: never propose anything on that list again. If a tool result says something resembles a ruled-out idea, remove it or tell the user it was ruled out before and why.
- When the user rejects something in chat ("we don't want X"), record it with rule_out, with their reason.
- You may add, edit, move, link and delete anything, including the user's own content, when the conversation calls for it. Every change you make is shown to the user and can be undone, so act, then say what you changed.
- New things you add are marked "Claude added" until the user keeps or dismisses them.
- Use view_picture to look at pictures when they matter.
- If the user is pointing at something, the message starts with [Pointing at: …]; that is what "this" means.
- Finish with a short chat reply (one to three sentences) saying what you changed. Your final message is posted to the board chat, so do not call reply yourself.`;

// The prompt for a run: the user's unanswered messages, each preceded by a line
// for every thing it points at.
export function buildPrompt(messages) {
  return messages
    .map((m) => [...(m.context ?? []).map((p) => `[Pointing at: ${p.kind} “${p.label}” (${p.id})]`), m.text].join('\n'))
    .join('\n\n');
}

// Is `bin` runnable? A name with a path separator is checked as-is; a bare name
// is looked for in every PATH directory (on Windows, with each PATHEXT ending).
export function findOnPath(bin, env = process.env) {
  const executable = (file) => {
    try {
      if (!fs.statSync(file).isFile()) return false;
      fs.accessSync(file, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  if (/[\\/]/.test(bin)) return executable(bin);
  const windows = process.platform === 'win32';
  const endings = windows ? ['', ...(env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean)] : [''];
  return (env.PATH || '').split(path.delimiter).filter(Boolean).some((dir) => endings.some((ext) => executable(path.join(dir, bin + ext))));
}

// Waits for `promise` to settle: null when it does, or why the wait was cut short
// ('stopped' when `signal` aborts, 'out of time' at `deadline`).
function waitOrCut(promise, signal, deadline) {
  if (signal?.aborted) return Promise.resolve('stopped');
  return new Promise((resolve) => {
    const done = (why) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(why);
    };
    const onAbort = () => done('stopped');
    // No deadline (Infinity): only the signal cuts the wait.
    const timer = Number.isFinite(deadline) ? setTimeout(() => done('out of time'), Math.max(0, deadline - Date.now())) : null;
    signal?.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(() => done(null), () => done(null));
  });
}

export class Agent {
  constructor(store, presence, { mcpUrl, cwd, claudeBin = process.env.IDEA_BOARD_CLAUDE || 'claude', model = '', canMakePictures = () => false, onRunStart = () => {}, log = console.error, quiet = () => false, found = findOnPath(claudeBin), role = () => '' } = {}) {
    this.store = store;
    this.presence = presence;
    this.mcpUrl = mcpUrl;
    this.cwd = cwd;
    this.claudeBin = claudeBin;
    // Claude's model: a string, or a function read at each run (the board's choice).
    this.model = model;
    this.canMakePictures = canMakePictures;
    this.onRunStart = onRunStart;
    this.log = log;
    this.quiet = quiet;
    this.found = found;
    this.role = role;
    this.running = false;
    this.queued = false;
    this.current = null;
    // The ids of the user messages the binary is answering right now.
    this.answering = new Set();
    presence.onDetach = () => this.nudge();
  }

  hasUnanswered() {
    return this.store.board.chat.some((m) => m.role === 'user' && m.owed?.includes('claude'));
  }

  // How Claude would answer right now: a session attached over MCP, else the binary, else nobody.
  via() {
    if (this.presence.attached()) return 'mcp';
    return this.found ? 'binary' : 'none';
  }

  // Called after every user chat message.
  nudge() {
    if (!this.found || this.quiet() || this.presence.attached() || !this.hasUnanswered()) return;
    if (this.running) {
      this.queued = true;
      return;
    }
    this.current = this.#run().catch((error) => this.log(`idea-board agent: ${error.stack || error}`));
  }

  async #run() {
    this.running = true;
    this.store.emit({ type: 'agent', state: 'working' });
    try {
      const pending = this.store.board.chat.filter((m) => m.role === 'user' && m.owed?.includes('claude'));
      this.answering = new Set(pending.map((m) => m.id));
      const prompt = buildPrompt(pending);
      let outcome = await this.#invoke(prompt, this.store.board.claudeSessionId);
      if (!outcome.ok && this.store.board.claudeSessionId) {
        // The saved conversation may be gone; start a fresh one.
        this.log(`idea-board agent: resume failed (${outcome.error}); starting a new conversation`);
        outcome = await this.#invoke(prompt, null);
      }
      if (outcome.sessionId) this.store.setSessionId(outcome.sessionId);
      if (outcome.ok && !this.store.board.chat.some((m) => pending.some((p) => p.id === m.id && m.owed?.includes('claude')))) {
        // A session answered while claude -p was thinking; posting this too would answer twice.
        this.log('idea-board agent: dropped a reply already answered by a session');
      } else if (outcome.ok) {
        // Only the messages in this run's prompt are answered; any that came in meanwhile get the next run.
        this.store.apply({ type: 'chat', text: outcome.text || '(Done.)', answers: pending.map((m) => m.id) }, 'claude');
      } else {
        this.store.emit({ type: 'agent', state: 'error', message: outcome.error });
      }
    } finally {
      this.answering = new Set();
      this.running = false;
      this.store.emit({ type: 'agent', state: 'idle' });
      if (this.queued) {
        this.queued = false;
        this.nudge();
      }
    }
  }

  // One headless turn in the board's conversation, for the Room. Posts nothing.
  // It waits for any run in flight so two claude -p never share the session.
  // Stop (`signal`) and the time limit count the wait too.
  async takeTurn(prompt, { timeoutMs = RUN_TIMEOUT_MS, signal } = {}) {
    return this.#exclusive(timeoutMs, signal, (deadline) => this.#turn(prompt, deadline, signal));
  }

  // A prune pass: a fresh session (never the chat's), its own system prompt, no
  // chat or version tools. Shares the lock with takeTurn, but only Stop cuts the wait for
  // it: onStart() runs once the lock is held, and the time limit counts from then.
  // `prompt` may be a function, so it is built from the board as it is at that moment.
  async prune(prompt, { systemPrompt, timeoutMs = RUN_TIMEOUT_MS, signal, onStart } = {}) {
    return this.#exclusive(Infinity, signal, () => this.#pruneTurn(prompt, systemPrompt, timeoutMs, signal, onStart));
  }

  // Waits for binary work in flight, then holds the lock while `start` runs.
  async #exclusive(timeoutMs, signal, start) {
    const deadline = Number.isFinite(timeoutMs) ? Date.now() + timeoutMs : Infinity;
    while (this.running) {
      const cut = await waitOrCut(this.current, signal, deadline);
      if (cut) return { ok: false, error: cut };
    }
    if (signal?.aborted) return { ok: false, error: 'stopped' };
    if (deadline - Date.now() <= 0) return { ok: false, error: 'out of time' };
    // Set before the first await, so a turn or run that comes meanwhile waits for this one.
    this.running = true;
    const turn = start(deadline);
    this.current = turn;
    return turn;
  }

  async #pruneTurn(prompt, systemPrompt, timeoutMs, signal, onStart) {
    this.store.emit({ type: 'agent', state: 'working' });
    try {
      onStart?.();
      const text = typeof prompt === 'function' ? prompt() : prompt;
      const outcome = await this.#invoke(text, null, { timeoutMs, signal, systemPrompt, disallow: PRUNE_DISALLOWED });
      return outcome.ok ? { ok: true, text: outcome.text } : { ok: false, error: outcome.error };
    } finally {
      this.#release();
    }
  }

  async #turn(prompt, deadline, signal) {
    this.store.emit({ type: 'agent', state: 'working' });
    try {
      const resumeId = this.store.board.claudeSessionId;
      let outcome = await this.#invoke(prompt, resumeId, { timeoutMs: deadline - Date.now(), signal });
      // The saved conversation may be gone; start a fresh one with what time is left.
      if (!outcome.ok && resumeId && !outcome.stopped && deadline - Date.now() > 0) {
        outcome = await this.#invoke(prompt, null, { timeoutMs: deadline - Date.now(), signal });
      }
      if (outcome.sessionId) this.store.setSessionId(outcome.sessionId);
      return outcome.ok ? { ok: true, text: outcome.text } : { ok: false, error: outcome.error };
    } finally {
      this.#release();
    }
  }

  #release() {
    this.running = false;
    this.store.emit({ type: 'agent', state: 'idle' });
    if (this.queued) {
      this.queued = false;
      this.nudge();
    }
  }

  #invoke(prompt, resumeId, { timeoutMs = RUN_TIMEOUT_MS, signal, systemPrompt: ownSystemPrompt, disallow } = {}) {
    this.onRunStart();
    const sessionId = resumeId || randomUUID();
    const mcpConfig = JSON.stringify({ mcpServers: { board: { type: 'http', url: this.mcpUrl } } });
    const role = this.role();
    const model = typeof this.model === 'function' ? this.model() : this.model;
    const systemPrompt = ownSystemPrompt ?? (role ? `${SYSTEM_PROMPT}\n\nYour role on this board:\n${role}` : SYSTEM_PROMPT);
    const args = [
      '-p',
      '--output-format', 'json',
      '--mcp-config', mcpConfig,
      '--strict-mcp-config',
      '--tools', '',
      '--allowedTools', 'mcp__board',
      ...(disallow ? ['--disallowedTools', disallow.join(',')] : this.canMakePictures() ? [] : ['--disallowedTools', 'mcp__board__generate_image']),
      '--permission-mode', 'dontAsk',
      '--append-system-prompt', systemPrompt,
      ...(resumeId ? ['--resume', resumeId] : ['--session-id', sessionId]),
      ...(model ? ['--model', model] : []),
    ];
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let child;
      try {
        child = spawn(this.claudeBin, args, { cwd: this.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (error) {
        resolve({ ok: false, error: error.message });
        return;
      }
      // A child that dies early closes the pipe; its close handler reports why.
      child.stdin.on('error', () => {});
      child.stdin.end(prompt);
      let stopped = false;
      const stop = () => { stopped = true; child.kill('SIGTERM'); };
      const timer = setTimeout(stop, timeoutMs);
      const abort = stop;
      if (signal?.aborted) abort();
      else signal?.addEventListener('abort', abort, { once: true });
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', (error) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        resolve({ ok: false, error: error.code === 'ENOENT' ? `could not find "${this.claudeBin}" on PATH` : error.message });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        let result = null;
        try { result = JSON.parse(stdout); } catch { /* not JSON: handled as a failure below */ }
        if (code === 0 && result && !result.is_error) {
          resolve({ ok: true, text: String(result.result ?? '').trim(), sessionId: result.session_id || sessionId });
        } else {
          const reason = result?.result || stderr.trim().split('\n').slice(-3).join(' ') || `claude exited with code ${code}`;
          resolve({ ok: false, error: reason, sessionId: result?.session_id, stopped });
        }
      });
    });
  }
}
