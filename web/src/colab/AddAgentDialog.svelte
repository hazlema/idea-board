<script lang="ts">
  // "+ Add agent": a roomy model search (the sidebar is too narrow to read the list),
  // a role, and Add puts the card in the sidebar.
  import { untrack } from 'svelte';
  import type { LineupAgent, Model, Role } from '$lib/types';

  interface Props {
    models: Model[] | null;
    /** Why the model list could not be loaded; then a typed model id is used as it is. */
    modelsError: string | null;
    roles: Role[];
    onadd: (agent: LineupAgent) => void;
    onclose: () => void;
  }

  let { models, modelsError, roles, onadd, onclose }: Props = $props();

  const MAX_SHOWN = 200;

  let query = $state('');
  let chosen = $state<string | null>(null);
  let highlight = $state(0);
  // Starts on Creative Director (or the first role); the dialog doesn't follow later library edits.
  let roleId = $state(untrack(() => (roles.some((r) => r.id === 'creative') ? 'creative' : (roles[0]?.id ?? 'creative'))));
  let list: HTMLUListElement | undefined = $state();

  // "OpenAI: GPT-6.1 Sol" reads as "GPT-6.1 Sol" (the provider is shown on its own).
  const displayName = (m: Model): string => m.name.replace(/^[^:]{1,40}:\s+/, '');
  const provider = (m: Model): string => m.id.replace(/^~/, '').split('/')[0];
  const contextSize = (n: number): string => (n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}K`);

  const matches = $derived.by(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const all = models ?? [];
    return all.filter((m) => words.every((w) => `${m.id} ${m.name}`.toLowerCase().includes(w))).slice(0, MAX_SHOWN);
  });

  // Without a model list, the typed id is the model.
  const model = $derived(models ? chosen : query.trim() || null);
  const role = $derived(roles.find((r) => r.id === roleId));

  function add(): void {
    if (!model) return;
    onadd({ model, roleId, settings: {} });
  }

  function pick(index: number): void {
    highlight = index;
    chosen = matches[index]?.id ?? null;
  }

  function onkeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      onclose();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!matches.length) return;
      pick(Math.max(0, Math.min(matches.length - 1, highlight + (event.key === 'ArrowDown' ? 1 : -1))));
      list?.querySelector(`[data-index="${highlight}"]`)?.scrollIntoView?.({ block: 'nearest' });
    } else if (event.key === 'Enter' && !event.isComposing) {
      event.preventDefault();
      if (models && !chosen && matches.length) pick(highlight);
      add();
    }
  }

  function focusOnMount(node: HTMLElement): void {
    node.focus();
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
<div class="fixed inset-0 z-50 flex items-center justify-center bg-ink/70" onclick={(e) => e.target === e.currentTarget && onclose()}>
  <div
    class="flex max-h-[85vh] w-[min(820px,94vw)] flex-col gap-3 rounded-xl border border-line bg-panel p-4 shadow-2xl"
    role="dialog"
    aria-modal="true"
    aria-label="Add a connection"
    tabindex="-1"
    {onkeydown}
  >
    <div class="flex items-center justify-between">
      <h2 class="text-base font-semibold">Add a connection</h2>
      <button type="button" class="px-1 text-muted hover:text-text" aria-label="Close" onclick={onclose}>✕</button>
    </div>

    <input
      type="search"
      class="rounded-md border border-line bg-ink px-3 py-2 text-base text-text placeholder:text-muted"
      placeholder={models ? 'Search models by name, maker or id (e.g. "claude sonnet", "gemini flash")' : 'Type a model id, e.g. anthropic/claude-sonnet-5.5'}
      aria-label="Search models"
      bind:value={query}
      oninput={() => {
        highlight = 0;
        chosen = null;
      }}
      use:focusOnMount
    />

    {#if modelsError}
      <p class="text-muted" role="status">Couldn't load the model list ({modelsError}). Type a model id and press Add.</p>
    {:else if !models}
      <p class="text-muted" role="status">Loading models…</p>
    {:else}
      <div class="grid grid-cols-[1fr_7rem_9rem_4rem] gap-3 px-3 text-xs text-muted" aria-hidden="true">
        <span>Model</span><span>Maker</span><span>Price per M tokens</span><span class="text-right">Context</span>
      </div>
      <ul bind:this={list} class="-mt-2 min-h-40 flex-1 overflow-y-auto rounded-md border border-line" role="listbox" aria-label="Models">
        {#each matches as m, i (m.id)}
          <li
            data-index={i}
            class="grid cursor-pointer grid-cols-[1fr_7rem_9rem_4rem] items-center gap-3 border-b border-line/60 px-3 py-1.5 last:border-b-0 {chosen === m.id
              ? 'bg-accent/25'
              : i === highlight
                ? 'bg-raised'
                : 'hover:bg-raised'}"
            role="option"
            aria-selected={chosen === m.id}
            onclick={() => pick(i)}
            ondblclick={() => {
              pick(i);
              add();
            }}
          >
            <span class="min-w-0">
              <span class="block truncate text-text">{displayName(m)}</span>
              <span class="block truncate text-xs text-muted">{m.id}</span>
            </span>
            <span class="truncate text-muted">{provider(m)}</span>
            <span class="text-muted">${m.promptPrice} in · ${m.completionPrice} out</span>
            <span class="text-right text-muted">{contextSize(m.context)}</span>
          </li>
        {:else}
          <li class="px-3 py-3 text-muted">No models match “{query}”.</li>
        {/each}
      </ul>
      {#if matches.length === MAX_SHOWN}<p class="-mt-2 text-xs text-muted">Showing the first {MAX_SHOWN}; type more to narrow it down.</p>{/if}
    {/if}

    <div class="flex items-start gap-3">
      <label class="flex items-center gap-2 text-muted"
        >Role
        <select class="rounded-md border border-line bg-ink px-2 py-1 text-text" aria-label="Role" bind:value={roleId}>
          {#each roles as r (r.id)}
            <option value={r.id}>{r.name}</option>
          {/each}
        </select>
      </label>
      {#if role}<p class="line-clamp-2 min-w-0 flex-1 text-xs text-muted">{role.job}</p>{/if}
    </div>

    <div class="flex items-center justify-end gap-2">
      <span class="mr-auto truncate text-muted">{model ? `Adding ${model}` : 'Pick a model'}</span>
      <button type="button" class="rounded-md border border-line px-3 py-1.5 text-text hover:border-muted" onclick={onclose}>Cancel</button>
      <button type="button" class="rounded-md bg-accent px-4 py-1.5 font-semibold text-ink disabled:opacity-40" disabled={!model} onclick={add}>Add</button>
    </div>
  </div>
</div>
