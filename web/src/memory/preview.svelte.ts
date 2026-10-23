import * as api from '$lib/api';
import { live } from '$lib/live.svelte';
import type { Board, VersionMeta } from '$lib/types';

/** The saved version being looked at, if any. Read-only: nothing here changes the board. */
class Preview {
  current = $state<{ meta: VersionMeta; content: Board } | null>(null);

  async open(id: string): Promise<void> {
    try {
      this.current = await api.readVersion(id);
    } catch (error) {
      live.toast(error instanceof Error ? error.message : 'Could not open that version');
    }
  }

  close(): void {
    this.current = null;
  }
}

export const preview = new Preview();

/** Asks first, then puts a saved version back on the board. Resolves true if it did. */
export async function restoreVersion(meta: Pick<VersionMeta, 'id' | 'name'>): Promise<boolean> {
  if (!confirm(`Restore “${meta.name}”? What is on the board now is saved as a version first.`)) return false;
  try {
    await api.restoreVersion(meta.id);
  } catch (error) {
    live.toast(error instanceof Error ? error.message : 'Could not restore that version');
    return false;
  }
  preview.close();
  live.toast(`Restored “${meta.name}”. ↶ Undo reverses it.`);
  return true;
}
