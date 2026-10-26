<script lang="ts">
  import { Draft } from '$lib/draft.svelte';
  import type { Library } from '$lib/types';
  import { colabState } from './colab.svelte';

  interface Props {
    name: 'audit' | 'prune';
    /** Saves the whole library; false when it failed. */
    save: (library: Library) => Promise<boolean>;
  }

  let { name, save }: Props = $props();

  const stored = $derived(colabState.library.passes?.[name]);
  const command = $derived(name === 'audit' ? '/audit' : '/prune');

  const text = new Draft({
    server: () => stored || colabState.passDefaults[name],
    save: async (value) => ((await save({ ...colabState.library, passes: { ...colabState.library.passes, [name]: value } })) ? {} : null),
    delay: 500,
  });

  async function reset(): Promise<void> {
    const { [name]: _dropped, ...rest } = colabState.library.passes ?? {};
    await save({ ...colabState.library, passes: rest });
  }

  const field = 'w-full resize-y rounded-md border border-line bg-ink px-2 py-1.5 text-text focus:border-accent';
</script>

<div class="flex min-w-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
  <label class="flex flex-col gap-1 text-muted"
    >Instructions, every board
    <textarea rows="14" class={field} {...text.attrs}></textarea>
  </label>
  <p class="text-xs text-muted">Shared by every board. Focus a single run with {command} &lt;text&gt;.</p>
  <button
    type="button"
    class="self-start rounded-md border border-line px-2 py-1 text-muted hover:border-muted hover:text-text disabled:opacity-40"
    disabled={!stored}
    onclick={reset}>Reset to default</button
  >
</div>
