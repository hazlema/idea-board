// How the chat is shown in this browser: in the Collaborate tab or popped out
// as a floating window, where that window sits, and how big its text is.
// Kept in localStorage, not on the board, so it stays with the person reading.

const KEY = 'idea-board-chat';

/** Chat text size in px: from the old chat's size up to about double. */
export const CHAT_FONT = { min: 14, max: 28, initial: 17 };

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The smallest the floating window can be made. */
export const MIN_WINDOW = { w: 300, h: 240 };

/** `rect` moved, and shrunk if it must, so all of it is on a screen of `screen` size. */
export function fitWindow(rect: Rect, screen: { w: number; h: number }): Rect {
  const w = Math.min(rect.w, screen.w);
  const h = Math.min(rect.h, screen.h);
  return {
    x: Math.max(0, Math.min(rect.x, screen.w - w)),
    y: Math.max(0, Math.min(rect.y, screen.h - h)),
    w,
    h,
  };
}

interface Stored {
  popped: boolean;
  fontSize: number;
  window: Rect | null;
}

const clampFont = (size: number): number => Math.round(Math.min(CHAT_FONT.max, Math.max(CHAT_FONT.min, size)));

const isRect = (value: unknown): value is Rect =>
  typeof value === 'object' && value !== null && ['x', 'y', 'w', 'h'].every((k) => Number.isFinite((value as Record<string, unknown>)[k]));

function load(): Stored {
  const fallback: Stored = { popped: false, fontSize: CHAT_FONT.initial, window: null };
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (typeof raw !== 'object' || raw === null) return fallback;
    const stored = raw as Partial<Record<keyof Stored, unknown>>;
    return {
      popped: stored.popped === true,
      fontSize: typeof stored.fontSize === 'number' ? clampFont(stored.fontSize) : fallback.fontSize,
      window: isRect(stored.window) ? stored.window : null,
    };
  } catch {
    return fallback;
  }
}

export class ChatPrefs {
  #state = $state<Stored>(load());

  /** The chat floats over the board instead of sitting in the Collaborate tab. */
  get popped(): boolean {
    return this.#state.popped;
  }

  set popped(next: boolean) {
    this.#state.popped = next;
    this.#save();
  }

  get fontSize(): number {
    return this.#state.fontSize;
  }

  set fontSize(next: number) {
    this.#state.fontSize = clampFont(next);
    this.#save();
  }

  /** Where the floating window was last put, or null for the default spot. */
  get window(): Rect | null {
    return this.#state.window;
  }

  set window(next: Rect | null) {
    this.#state.window = next;
    this.#save();
  }

  #save(): void {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.#state));
    } catch {
      // Private mode: the choices just won't be remembered.
    }
  }
}

export const chatPrefs = new ChatPrefs();
