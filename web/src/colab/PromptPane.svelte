<script lang="ts">
  import { Draft } from '$lib/draft.svelte';
  import type { Library, Prompts } from '$lib/types';
  import { colabState } from './colab.svelte';

  interface Props {
    name: keyof Prompts;
    /** Saves the whole library; false when it failed. */
    save: (library: Library) => Promise<boolean>;
  }

  let { name, save }: Props = $props();

  const HELP: Record<keyof Prompts, string> = {
    chat: 'What Claude is told when you chat with it.',
    turn: 'What every agent is told when it takes a turn in a run.',
    answer: 'What an agent is told when it answers you.',
    audit: 'Shared by every board. Focus a single run with /audit <text>.',
    prune: 'Shared by every board. Focus a single run with /prune <text>.',
  };

  const prompts = (): Prompts => colabState.library.prompts ?? colabState.defaults.prompts;
  const stored = $derived(prompts()[name]);
  const fallback = $derived(colabState.defaults.prompts[name]);

  const saveText = async (value: string): Promise<boolean> => save({ ...colabState.library, prompts: { ...prompts(), [name]: value } });

  // A prompt can't be blank: clearing the box saves nothing (Reset to default gives the default).
  const text = new Draft({
    server: () => stored,
    save: async (value) => ((await saveText(value)) ? {} : null),
    valid: (value) => value.trim() !== '',
    delay: 500,
  });

  const field = 'w-full resize-y rounded-md border border-line bg-ink px-2 py-1.5 text-text focus:border-accent';
</script>

<div class="flex min-w-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
  <label class="flex flex-col gap-1 text-muted"
    >Instructions, every board
    <textarea rows="14" class={field} {...text.attrs}></textarea>
  </label>
  <p class="text-xs text-muted">{HELP[name]}</p>
  <button
    type="button"
    class="self-start rounded-md border border-line px-2 py-1 text-muted hover:border-muted hover:text-text disabled:opacity-40"
    disabled={stored === fallback}
    onclick={() => saveText(fallback)}>Reset to default</button
  >
</div>
