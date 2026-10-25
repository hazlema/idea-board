// What you sent in the chat, as typed (commands included), so Up and Down can bring
// it back as in a terminal. Kept in localStorage, so it stays with this browser.

const KEY = 'idea-board-chat-history';
export const HISTORY_SIZE = 50;

function load(): string[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter((s): s is string => typeof s === 'string').slice(-HISTORY_SIZE) : [];
  } catch {
    return [];
  }
}

export class ChatHistory {
  /** Oldest first. */
  #sent = load();
  /** How far back Up has gone; `#sent.length` is the text being written. */
  #at = this.#sent.length;
  #draft = '';

  /** Remembers a sent message (not twice in a row) and ends any browsing. */
  add(text: string): void {
    if (text && this.#sent.at(-1) !== text) this.#sent = [...this.#sent, text].slice(-HISTORY_SIZE);
    this.reset();
    try {
      localStorage.setItem(KEY, JSON.stringify(this.#sent));
    } catch {
      // Private mode: the history lasts until the page closes.
    }
  }

  /** The message before the one shown, or null at the oldest. `current` is kept to come back to. */
  older(current: string): string | null {
    if (this.#at === 0) return null;
    if (this.#at === this.#sent.length) this.#draft = current;
    this.#at -= 1;
    return this.#sent[this.#at];
  }

  /** The message after the one shown, then the text that was being written; null when not browsing. */
  newer(): string | null {
    if (this.#at >= this.#sent.length) return null;
    this.#at += 1;
    return this.#at === this.#sent.length ? this.#draft : this.#sent[this.#at];
  }

  /** Typing ends the browsing: Up starts again from the newest. */
  reset(): void {
    this.#at = this.#sent.length;
    this.#draft = '';
  }
}

/** One history for the chat in its tab and popped out. */
export const chatHistory = new ChatHistory();
