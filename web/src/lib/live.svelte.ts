import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import * as api from './api';
import type { AgentState, Board, Op, Pointer } from './types';

export type View = 'brief' | 'brainstorm' | 'flowchart' | 'collaborate';
export interface Notice {
  at: string;
  text: string;
}
export interface Toast {
  id: number;
  text: string;
}

const VIEW_KEY = 'idea-board-tab';
const VIEWS: View[] = ['brief', 'brainstorm', 'flowchart', 'collaborate'];
const FLASH_MS = 1600;
const TOAST_MS = 6000;
/** How often fields whose save failed try again. */
export const RETRY_MS = 5000;

type ServerEvent =
  | { type: 'board'; board: Board; op?: string; author?: string; changed?: string[] }
  | { type: 'agent'; state: 'working' | 'idle' | 'error'; message?: string }
  | { type: 'presence'; attached: boolean }
  | { type: 'history' }
  | { type: 'versions' };

function savedView(): View {
  try {
    const stored = localStorage.getItem(VIEW_KEY);
    return VIEWS.find((v) => v === stored) ?? 'brief';
  } catch {
    return 'brief';
  }
}

// Everything the page shows that comes from, or waits on, the server.
class Live {
  board = $state<Board | null>(null);
  agent = $state<AgentState>('idle');
  presence = $state(false);
  /** Edits sent and not yet answered. */
  saving = $state(0);
  /** The last edit sent failed. */
  saveFailed = $state(false);
  /** What the next chat message is about, set by the views. */
  pointing = $state<Pointer | null>(null);
  /** Ids Claude just changed; the views highlight them briefly. */
  flash = new SvelteSet<string>();
  notices = $state<Notice[]>([]);
  toasts = $state<Toast[]>([]);
  /** Bumped when the server records history, so the History list reloads. */
  historyTick = $state(0);
  /** Bumped when a saved version is added, so the versions list reloads. */
  versionsTick = $state(0);

  #view = $state<View>(savedView());
  #flashTimers = new Map<string, ReturnType<typeof setTimeout>>();
  #events: EventSource | null = null;
  #toastId = 0;
  // Typed text whose save failed, by field, with how to try it again.
  #unsaved = new SvelteMap<object, () => Promise<unknown>>();
  #retryTimer: ReturnType<typeof setInterval> | null = null;
  #lastFailure: string | null = null;

  get view(): View {
    return this.#view;
  }

  set view(next: View) {
    this.#view = next;
    try {
      localStorage.setItem(VIEW_KEY, next);
    } catch {
      // Private mode: the tab just won't be remembered.
    }
  }

  /** True while some typed text is not on the server (its save failed and is being retried). */
  get unsaved(): boolean {
    return this.#unsaved.size > 0;
  }

  /** What the save status says. */
  get saveStatus(): 'Not saved' | 'Saving…' | 'All changes saved' {
    if (this.saveFailed || this.unsaved) return 'Not saved';
    return this.saving > 0 ? 'Saving…' : 'All changes saved';
  }

  /**
   * A field's save failed: it counts as unsaved, and `retry` is called every
   * RETRY_MS until the field reports it saved.
   */
  markUnsaved(field: object, retry: () => Promise<unknown>): void {
    this.#unsaved.set(field, retry);
    this.#retryTimer ??= setInterval(() => {
      for (const again of [...this.#unsaved.values()]) void again();
    }, RETRY_MS);
  }

  /** A field has nothing unsaved any more. */
  markSaved(field: object): void {
    if (!this.#unsaved.delete(field) || this.#unsaved.size) return;
    // The last unsaved field has settled (saved, or its item is gone): nothing is left unsaved.
    this.saveFailed = false;
    this.#lastFailure = null;
    if (this.#retryTimer !== null) clearInterval(this.#retryTimer);
    this.#retryTimer = null;
  }

  connect(): void {
    if (this.#events) return;
    const events = new EventSource('/api/events');
    this.#events = events;
    events.onmessage = (message) => this.#handle(JSON.parse(message.data) as ServerEvent);
    api.boardInfo().then(
      (info) => {
        this.agent = info.agent;
        this.presence = info.presence;
      },
      () => {},
    );
  }

  /** Sends an edit. Resolves with the server's answer, or null after showing why it failed. */
  async send(o: Op): Promise<unknown | null> {
    this.saving += 1;
    this.saveFailed = false;
    try {
      return await api.op(o);
    } catch (error) {
      this.saveFailed = true;
      const text = error instanceof Error ? error.message : 'Could not save';
      // Retries of unsaved fields fail the same way; say so once.
      if (!(this.unsaved && text === this.#lastFailure)) this.toast(text);
      this.#lastFailure = text;
      return null;
    } finally {
      this.saving -= 1;
    }
  }

  toast(text: string): void {
    const id = ++this.#toastId;
    this.toasts = [...this.toasts, { id, text }];
    setTimeout(() => this.dismissToast(id), TOAST_MS);
  }

  dismissToast(id: number): void {
    this.toasts = this.toasts.filter((t) => t.id !== id);
  }

  #handle(event: ServerEvent): void {
    switch (event.type) {
      case 'board':
        this.board = event.board;
        if (event.author === 'claude') this.#flash(event.changed ?? []);
        break;
      case 'agent':
        this.agent = event.state === 'error' ? 'idle' : event.state;
        if (event.state === 'error') {
          this.notices = [...this.notices, { at: new Date().toISOString(), text: `Claude could not answer: ${event.message ?? 'unknown error'}` }];
        }
        break;
      case 'presence':
        this.presence = event.attached;
        break;
      case 'history':
        this.historyTick += 1;
        break;
      case 'versions':
        this.versionsTick += 1;
        break;
    }
  }

  #flash(ids: string[]): void {
    if (!ids.length) return;
    for (const id of ids) this.flash.add(id);
    for (const id of ids) {
      clearTimeout(this.#flashTimers.get(id));
      this.#flashTimers.set(
        id,
        setTimeout(() => {
          this.#flashTimers.delete(id);
          this.flash.delete(id);
        }, FLASH_MS),
      );
    }
  }
}

export const live = new Live();
