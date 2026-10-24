<script lang="ts">
  import type { Model } from '$lib/types';

  interface Props {
    value: string;
    models: Model[] | null;
    disabled?: boolean;
    ariaLabel?: string;
    onchange: (id: string) => void;
  }
  let { value, models, disabled = false, ariaLabel = 'Model', onchange }: Props = $props();

  let open = $state(false);
  let query = $state<string | null>(null);
  // A mouse press elsewhere takes focus first. Closing the list then would move the
  // controls below it mid-click, so a press that leaves the box closes it on release.
  let pressing = false;
  let focused = $state(false);

  // "OpenAI: GPT-6.1 Sol" reads as "GPT-6.1 Sol", as the agent's name does in chat.
  const displayName = (m: Model): string => m.name.replace(/^[^:]{1,40}:\s+/, '');

  const current = $derived(models?.find((m) => m.id === value));
  // The model's name at rest; its id (or what is being typed) while editing.
  const shown = $derived(query ?? (focused || !current ? value : displayName(current)));
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

  // What typing settles on: an exact id, else (on Enter) the top match. Without a list, the text itself.
  function typed(enter: boolean): string | null {
    const text = (query ?? '').trim();
    if (!text) return null;
    if (!models || models.some((m) => m.id === text)) return text;
    return enter ? (matches[0]?.id ?? null) : null;
  }

  function close(): void {
    open = false;
    query = null;
  }

  function onblur(): void {
    focused = false;
    // An exact id typed in counts; anything else goes back to the saved model.
    const id = typed(false);
    if (id && id !== value) onchange(id);
    if (!pressing) return close();
    window.addEventListener('pointerup', () => setTimeout(close), { once: true });
  }

  function onkeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      open = false;
      query = null;
    } else if (event.key === 'Enter' && !event.isComposing) {
      event.preventDefault();
      const id = typed(true);
      if (id) choose(id);
    }
  }
</script>

<svelte:window onpointerdowncapture={() => (pressing = true)} onpointerup={() => setTimeout(() => (pressing = false))} />

<div class="relative">
  <input
    type="text"
    class="w-full rounded-md border border-line bg-ink px-2 py-1 text-text disabled:opacity-60"
    placeholder="Model (type to search)"
    aria-label={ariaLabel}
    {disabled}
    value={shown}
    onfocus={() => {
      focused = true;
      open = true;
    }}
    oninput={(e) => {
      query = e.currentTarget.value;
      open = true;
      // Without a model list the typed id is the choice.
      if (!models) onchange(query.trim());
    }}
    {onkeydown}
    {onblur}
  />
  <!-- Always there (empty until a model is chosen), so choosing one moves nothing below mid-click. -->
  <div class="mt-0.5 min-h-[1.5em] truncate text-[11px] text-muted" title={current?.name} data-testid="model-price">{current ? price(current) : ''}</div>
  {#if open && models && matches.length}
    <!-- In the flow, not floating: it pushes the cards below down instead of covering "+ Add agent". -->
    <ul class="mt-1 max-h-56 w-full overflow-auto rounded-md border border-line bg-raised" role="listbox" aria-label="Models">
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
