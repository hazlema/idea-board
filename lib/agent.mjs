// Runs a headless Claude Code turn when the user chats and no interactive
// session is listening. Claude only gets the board's MCP tools: every
// built-in tool (shell, files, web) is switched off.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const RUN_TIMEOUT_MS = 10 * 60_000;

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

export class Agent {
  constructor(store, presence, { mcpUrl, cwd, claudeBin = process.env.IDEA_BOARD_CLAUDE || 'claude', model = process.env.IDEA_BOARD_MODEL, log = console.error } = {}) {
    this.store = store;
    this.presence = presence;
    this.mcpUrl = mcpUrl;
    this.cwd = cwd;
    this.claudeBin = claudeBin;
    this.model = model;
    this.log = log;
    this.running = false;
    this.queued = false;
    presence.onDetach = () => this.nudge();
  }

  hasUnanswered() {
    return this.store.board.chat.some((m) => m.role === 'user' && !m.handled);
  }

  // Called after every user chat message.
  nudge() {
    if (this.presence.attached() || !this.hasUnanswered()) return;
    if (this.running) {
      this.queued = true;
      return;
    }
    this.#run().catch((error) => this.log(`idea-board agent: ${error.stack || error}`));
  }

  async #run() {
    this.running = true;
    this.store.emit({ type: 'agent', state: 'working' });
    try {
      const pending = this.store.board.chat.filter((m) => m.role === 'user' && !m.handled);
      const prompt = buildPrompt(pending);
      let outcome = await this.#invoke(prompt, this.store.board.claudeSessionId);
      if (!outcome.ok && this.store.board.claudeSessionId) {
        // The saved conversation may be gone; start a fresh one.
        this.log(`idea-board agent: resume failed (${outcome.error}); starting a new conversation`);
        outcome = await this.#invoke(prompt, null);
      }
      if (outcome.sessionId) this.store.setSessionId(outcome.sessionId);
      if (outcome.ok) {
        this.store.apply({ type: 'chat', text: outcome.text || '(Done.)' }, 'claude');
      } else {
        this.store.emit({ type: 'agent', state: 'error', message: outcome.error });
      }
    } finally {
      this.running = false;
      this.store.emit({ type: 'agent', state: 'idle' });
      if (this.queued) {
        this.queued = false;
        this.nudge();
      }
    }
  }

  #invoke(prompt, resumeId) {
    const sessionId = resumeId || randomUUID();
    const mcpConfig = JSON.stringify({ mcpServers: { board: { type: 'http', url: this.mcpUrl } } });
    const args = [
      '-p', prompt,
      '--output-format', 'json',
      '--mcp-config', mcpConfig,
      '--strict-mcp-config',
      '--tools', '',
      '--allowedTools', 'mcp__board',
      '--permission-mode', 'dontAsk',
      '--append-system-prompt', SYSTEM_PROMPT,
      ...(resumeId ? ['--resume', resumeId] : ['--session-id', sessionId]),
      ...(this.model ? ['--model', this.model] : []),
    ];
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let child;
      try {
        child = spawn(this.claudeBin, args, { cwd: this.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (error) {
        resolve({ ok: false, error: error.message });
        return;
      }
      const timer = setTimeout(() => child.kill('SIGTERM'), RUN_TIMEOUT_MS);
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', (error) => {
        clearTimeout(timer);
        resolve({ ok: false, error: error.code === 'ENOENT' ? `could not find "${this.claudeBin}" on PATH` : error.message });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        let result = null;
        try { result = JSON.parse(stdout); } catch { /* not JSON: handled as a failure below */ }
        if (code === 0 && result && !result.is_error) {
          resolve({ ok: true, text: String(result.result ?? '').trim(), sessionId: result.session_id || sessionId });
        } else {
          const reason = result?.result || stderr.trim().split('\n').slice(-3).join(' ') || `claude exited with code ${code}`;
          resolve({ ok: false, error: reason, sessionId: result?.session_id });
        }
      });
    });
  }
}
