<script lang="ts">
  import { onMount } from 'svelte';

  interface Props {
    /** The model now set: an alias or a full id. */
    value: string;
    /** True when a Claude Code session on MCP answers, and picks its own model. */
    mcp: boolean;
    onsave: (model: string) => void;
    onclose: () => void;
  }
  let { value, mcp, onsave, onclose }: Props = $props();

  const ALIASES = [
    { id: 'sonnet', label: 'Sonnet' },
    { id: 'opus', label: 'Opus' },
    { id: 'haiku', label: 'Haiku' },
    { id: 'fable', label: 'Fable' },
  ];

  const isAlias = (id: string): boolean => ALIASES.some((a) => a.id === id);
  // Svelte reads the props once here on purpose: the popup edits a copy until Save.
  // svelte-ignore state_referenced_locally
  let choice = $state(isAlias(value) ? value : 'other');
  // svelte-ignore state_referenced_locally
  let custom = $state(isAlias(value) ? '' : value);
  let panel: HTMLDivElement;

  const result = $derived(choice === 'other' ? custom.trim() : choice);

  onMount(() => {
    (panel.querySelector('input[type="radio"]:checked') as HTMLElement | null)?.focus();
  });

  function save(): void {
    if (result) onsave(result);
  }

  function onkeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onclose();
    }
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  bind:this={panel}
  class="absolute right-0 left-0 z-40 mt-1 flex flex-col gap-1 rounded-md border border-line bg-raised p-3 text-sm shadow-lg"
  role="group"
  aria-label="Claude's model"
  {onkeydown}
>
  {#each ALIASES as alias (alias.id)}
    <label class="flex items-center gap-2 text-text"><input type="radio" name="claude-model" value={alias.id} bind:group={choice} />{alias.label}</label>
  {/each}
  <label class="flex items-center gap-2 text-text"><input type="radio" name="claude-model" value="other" bind:group={choice} />Other…</label>
  {#if choice === 'other'}
    <input
      type="text"
      class="rounded-md border border-line bg-ink px-2 py-1 text-text"
      aria-label="Model id"
      placeholder="claude-opus-5-5"
      bind:value={custom}
      onkeydown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          save();
        }
      }}
    />
  {/if}
  {#if mcp}<p class="text-xs text-muted">Set by your session while connected via MCP.</p>{/if}
  <div class="mt-1 flex justify-end gap-2">
    <button type="button" class="rounded-md border border-line px-2 py-1 text-muted hover:border-muted hover:text-text" onclick={onclose}>Cancel</button>
    <button type="button" class="rounded-md bg-accent px-2.5 py-1 font-medium text-ink disabled:opacity-40" disabled={!result} onclick={save}>Save</button>
  </div>
</div>
