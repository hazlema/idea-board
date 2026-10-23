<script lang="ts">
  import type { Model } from '$lib/types';

  interface Props {
    value: string;
    models: Model[] | null;
    disabled?: boolean;
    onchange: (id: string) => void;
  }
  let { value, models, disabled = false, onchange }: Props = $props();

  let open = $state(false);
  let query = $state<string | null>(null);

  const current = $derived(models?.find((m) => m.id === value));
  const shown = $derived(query ?? value);
  const matches = $derived.by(() => {
    const q = (query ?? '').trim().toLowerCase();
    const all = models ?? [];
    return (q ? all.filter((m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)) : all).slice(0, 50);
  });

  const price = (m: Model) => `$${m.promptPrice} in · $${m.completionPrice} out per M`;

  function choose(id: string): void {
    open = false;
    query = null;
    if (id !== value) onchange(id);
  }
</script>

<div class="relative">
  <input
    type="text"
    class="w-full rounded-md border border-line bg-ink px-2 py-1 text-text disabled:opacity-60"
    placeholder="Model (type to search)"
    aria-label="Model"
    {disabled}
    value={shown}
    onfocus={() => (open = true)}
    oninput={(e) => {
      query = e.currentTarget.value;
      open = true;
      // Without a model list the typed id is the choice.
      if (!models) onchange(query.trim());
    }}
    onblur={() => {
      // Let a click on an option land first.
      setTimeout(() => {
        open = false;
        query = null;
      }, 120);
    }}
  />
  {#if current}
    <div class="mt-0.5 truncate text-[11px] text-muted" title={current.name}>{price(current)}</div>
  {/if}
  {#if open && models && matches.length}
    <ul class="absolute z-20 mt-1 max-h-56 w-full overflow-auto rounded-md border border-line bg-raised shadow-lg" role="listbox" aria-label="Models">
      {#each matches as m (m.id)}
        <li role="option" aria-selected={m.id === value}>
          <button type="button" class="block w-full px-2 py-1 text-left hover:bg-ink" onmousedown={(e) => e.preventDefault()} onclick={() => choose(m.id)}>
            <span class="block truncate text-text">{m.name}</span>
            <span class="block truncate text-[11px] text-muted">{m.id} · {price(m)}</span>
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</div>
