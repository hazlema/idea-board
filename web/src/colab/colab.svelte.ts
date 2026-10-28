import * as api from '$lib/api';
import { live } from '$lib/live.svelte';
import type { Defaults, Library, Model } from '$lib/types';

// What the Agents panel needs from the server besides the board: the role library,
// the model list and whether a key is set. Loaded when the panel opens.
class ColabState {
  library = $state<Library>({ rules: '', roles: [] });
  /** The shipped starting texts, for Reset to default. */
  defaults = $state<Defaults>({ shared: '', roles: [], prompts: { chat: '', turn: '', answer: '', audit: '', prune: '' } });
  /** The models agents can use, or null until loaded (or when loading failed). */
  models = $state<Model[] | null>(null);
  /** The models that make pictures; null until loaded (or when loading failed). */
  imageModels = $state<Model[] | null>(null);
  modelsError = $state<string | null>(null);
  hasKey = $state(false);
  loaded = $state(false);
  #loadingModels = false;
  #loadingImageModels = false;

  async load(): Promise<void> {
    try {
      const info = await api.colab();
      this.library = info.library;
      this.defaults = info.defaults;
      this.hasKey = info.hasKey;
      live.colab = info.status;
      this.loaded = true;
    } catch (error) {
      live.toast(error instanceof Error ? error.message : 'Could not load the agents');
    }
    await Promise.all([this.#loadModels(), this.#loadImageModels()]);
  }

  async #loadModels(): Promise<void> {
    if (this.models || this.#loadingModels) return;
    this.#loadingModels = true;
    try {
      this.models = await api.colabModels();
      this.modelsError = null;
    } catch (error) {
      this.modelsError = error instanceof Error ? error.message : 'Unknown error';
    } finally {
      this.#loadingModels = false;
    }
  }

  async #loadImageModels(): Promise<void> {
    if (this.imageModels || this.#loadingImageModels) return;
    this.#loadingImageModels = true;
    try {
      this.imageModels = await api.colabImageModels();
    } catch {
      // The picker still takes a typed id; the model list's error already tells the user.
      this.imageModels = null;
    } finally {
      this.#loadingImageModels = false;
    }
  }
}

export const colabState = new ColabState();
