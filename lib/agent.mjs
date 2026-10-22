// Runs a headless Claude Code turn when the user chats and no interactive
// session is listening. Claude only gets the board's MCP tools: every
// built-in tool (shell, files, web) is switched off.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const RUN_TIMEOUT_MS = 10 * 60_000;

const SYSTEM_PROMPT = `You are Claude, the user's brainstorming partner on a shared idea board: a flowchart whiteboard you both edit. The user just wrote in the board's chat.

- Start with view_board. Its brief says what you are building together and what has been decided; keep your ideas consistent with it.
- When the user settles a goal, decision or constraint, record it in the brief (add_brief_section, or extend a box). Don't rewrite the user's brief boxes unless asked.
- Make the changes the conversation calls for: add nodes for new ideas, connect related ones, put detail in notes and props. Titles are short one-liners.
- Ideas you add stay status "idea". Set "accepted" or "rejected" only when the user decides.
- Do not delete or rewrite the user's nodes unless they ask.
- Finish with a short chat reply (one to three sentences). Your final message is posted to the board chat, so do not call reply yourself.`;

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
      const prompt = pending.map((m) => m.text).join('\n\n');
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
        try { result = JSON.parse(stdout); } catch {}
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
