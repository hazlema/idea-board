import * as api from '$lib/api';
import { live } from '$lib/live.svelte';
import type { Model, Role } from '$lib/types';

// What the Agents panel needs from the server besides the board: the role library,
// the model list and whether a key is set. Loaded when the panel opens.
class ColabState {
  library = $state<{ rules: string; roles: Role[] }>({ rules: '', roles: [] });
  /** The models agents can use, or null until loaded (or when loading failed). */
  models = $state<Model[] | null>(null);
  modelsError = $state<string | null>(null);
  hasKey = $state(false);
  loaded = $state(false);
  #loadingModels = false;

  async load(): Promise<void> {
    try {
      const info = await api.colab();
      this.library = info.library;
      this.hasKey = info.hasKey;
      live.colab = info.status;
      this.loaded = true;
    } catch (error) {
      live.toast(error instanceof Error ? error.message : 'Could not load the agents');
    }
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
}

export const colabState = new ColabState();
