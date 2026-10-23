// What the user is typing in one field, kept apart from the board so a board
// update that arrives mid-sentence never overwrites it.
//
// The field shows the draft while there is one, else the server's value. A
// draft is saved after a pause, and at once when focus leaves (or the
// component goes away). It is dropped once focus has left and the save is
// done, as soon as the server shows the saved value or moves on from it.
//
// Create it during component setup: it ties itself to the component's life.
import { onDestroy, untrack } from 'svelte';

export interface DraftOptions {
  /** The value on the board. */
  server: () => string;
  /** Saves a value. Resolves with null when the save failed (as `live.send` does). */
  save: (value: string) => Promise<unknown>;
  /** Pause after the last keystroke before saving, in ms. */
  delay?: number;
  /** Values that are not saved (an empty title, say); leaving the field shows the board's value again. */
  valid?: (value: string) => boolean;
}

// The server trims what it stores, so "abc " is saved as "abc".
const same = (a: string, b: string): boolean => a.trim() === b.trim();

export class Draft {
  #value = $state<string | null>(null);
  #options: DraftOptions;
  #focused = false;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #inFlight = 0;
  // Typed and not yet saved (or the save failed).
  #dirty = false;

  constructor(options: DraftOptions) {
    this.#options = options;
    // Once focus has left and the edit is saved, the next board value wins.
    // (While the save is still on its way, only a board that already shows it does.)
    $effect(() => {
      const server = this.#options.server();
      untrack(() => {
        if (this.#value === null || this.#focused || this.#dirty || this.#timer !== null) return;
        if (this.#inFlight === 0 || same(this.#value, server)) this.#value = null;
      });
    });
    onDestroy(() => void this.flush());
  }

  /** What the field shows. */
  get shown(): string {
    return this.#value ?? this.#options.server();
  }

  /** Handlers for an input or textarea: `<input {...draft.attrs} />`. */
  get attrs(): { value: string; oninput: (e: Event) => void; onfocus: () => void; onblur: () => Promise<void> } {
    return {
      value: this.shown,
      oninput: (e: Event) => this.input((e.currentTarget as HTMLInputElement | HTMLTextAreaElement).value),
      onfocus: () => this.focus(),
      onblur: () => this.blur(),
    };
  }

  input(value: string): void {
    this.#value = value;
    this.#dirty = true;
    this.#clearTimer();
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.#save();
    }, this.#options.delay ?? 500);
  }

  focus(): void {
    this.#focused = true;
  }

  async blur(): Promise<void> {
    this.#focused = false;
    await this.flush();
    if (this.#value === null || this.#focused) return;
    // Not saveable, or saved and already on the board: show the board again.
    if (!this.#valid(this.#value) || (this.#settled() && same(this.#value, this.#options.server()))) this.#value = null;
  }

  /** Saves a waiting edit now. */
  async flush(): Promise<void> {
    this.#clearTimer();
    await this.#save();
  }

  /** Forgets the draft without saving (the item is being deleted). */
  cancel(): void {
    this.#clearTimer();
    this.#dirty = false;
    this.#value = null;
  }

  #valid(value: string): boolean {
    return this.#options.valid?.(value) ?? true;
  }

  #settled(): boolean {
    return !this.#focused && this.#timer === null && this.#inFlight === 0 && !this.#dirty;
  }

  #clearTimer(): void {
    if (this.#timer === null) return;
    clearTimeout(this.#timer);
    this.#timer = null;
  }

  async #save(): Promise<void> {
    const value = this.#value;
    if (value === null || !this.#dirty) return;
    this.#dirty = false;
    if (!this.#valid(value)) return;
    this.#inFlight += 1;
    let result: unknown;
    try {
      result = await this.#options.save(value);
    } finally {
      this.#inFlight -= 1;
    }
    // A failed save keeps the typing on screen and tries again when focus next leaves.
    if (result === null && this.#value === value) this.#dirty = true;
  }
}
