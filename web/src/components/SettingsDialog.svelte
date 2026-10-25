<script lang="ts">
  // ⋯ → Settings: board settings that don't need to sit in the sidebar. The image model and pruning.
  import { untrack } from 'svelte';
  import { live } from '$lib/live.svelte';
  import { colabState } from '../colab/colab.svelte';
  import ModelPicker from '../colab/ModelPicker.svelte';

  interface Props {
    onclose: () => void;
  }

  let { onclose }: Props = $props();

  // As DEFAULT_IMAGE_MODEL in lib/board.mjs: what a board starts with.
  const DEFAULT_IMAGE_MODEL = 'openai/gpt-5.4-image-2';

  const lineup = $derived(live.board?.colab?.lineup);
  const imageModel = $derived(lineup?.imageModel || DEFAULT_IMAGE_MODEL);
  // The line-up can't change mid-run.
  const canEdit = $derived(!live.colab || live.colab.state === 'idle');

  $effect(() => {
    untrack(() => {
      if (!colabState.loaded) void colabState.load();
    });
  });

  function setImageModel(id: string): void {
    if (!lineup) return;
    void live.send({ type: 'setColabLineup', ...$state.snapshot(lineup), imageModel: id });
  }

  // Pruning: sent like the image model, with the rest of the line-up.
  function setPrune(patch: { pruneLimit?: number | null; pruneAggressiveness?: 'gentle' | 'normal' | 'aggressive' }): void {
    if (!lineup) return;
    void live.send({ type: 'setColabLineup', ...$state.snapshot(lineup), ...patch });
  }

  // Empty means no limit; anything else is a whole number from 1 to 50.
  function setLimit(input: HTMLInputElement): void {
    const n = Number(input.value);
    if (input.value.trim() === '' || !Number.isFinite(n)) {
      input.value = '';
      setPrune({ pruneLimit: null });
      return;
    }
    const limit = Math.min(50, Math.max(1, Math.round(n)));
    input.value = String(limit);
    setPrune({ pruneLimit: limit });
  }

  function onkeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      onclose();
    }
  }

  function focusOnMount(node: HTMLElement): void {
    node.focus();
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
<div class="fixed inset-0 z-50 flex items-center justify-center bg-ink/70" onclick={(e) => e.target === e.currentTarget && onclose()}>
  <div
    class="flex max-h-[85vh] w-[min(520px,94vw)] flex-col gap-3 overflow-y-auto rounded-xl border border-line bg-panel p-4 text-sm shadow-2xl"
    role="dialog"
    aria-modal="true"
    aria-label="Settings"
    tabindex="-1"
    {onkeydown}
    use:focusOnMount
  >
    <div class="flex items-center justify-between">
      <h2 class="text-base font-semibold">Settings</h2>
      <button type="button" class="px-1 text-muted hover:text-text" aria-label="Close" onclick={onclose}>✕</button>
    </div>

    <section class="flex flex-col gap-1 rounded-md border border-line bg-raised p-3">
      <h3 class="text-xs font-semibold tracking-wide text-muted uppercase">Pictures</h3>
      <span class="text-muted">Image model</span>
      <ModelPicker value={imageModel} models={colabState.imageModels} disabled={!canEdit} ariaLabel="Image model" onchange={setImageModel} />
      <p class="text-xs text-muted">
        Used by roles that can make pictures; each picture is paid from the OpenRouter budget.
        {#if imageModel !== DEFAULT_IMAGE_MODEL}
          <button type="button" class="underline hover:text-text disabled:no-underline disabled:opacity-60" disabled={!canEdit} onclick={() => setImageModel(DEFAULT_IMAGE_MODEL)}
            >Use the default ({DEFAULT_IMAGE_MODEL})</button
          >
        {:else}
          This is the default.
        {/if}
      </p>
    </section>

    <section class="flex flex-col gap-1 rounded-md border border-line bg-raised p-3">
      <h3 class="text-xs font-semibold tracking-wide text-muted uppercase">Pruning</h3>
      <label class="flex items-center justify-between gap-2">
        <span class="text-muted">Mechanics limit</span>
        <input
          type="number"
          min="1"
          max="50"
          placeholder="No limit"
          class="w-24 rounded border border-line bg-panel px-2 py-1 text-text disabled:opacity-60"
          value={lineup?.pruneLimit ?? ''}
          disabled={!canEdit}
          onchange={(e) => setLimit(e.currentTarget)}
        />
      </label>
      <p class="text-xs text-muted">How many established mechanics a prune keeps; the rest are cut and ruled out. New ones get one pass first.</p>
      <label class="flex items-center justify-between gap-2">
        <span class="text-muted">Aggressiveness</span>
        <select
          class="rounded border border-line bg-panel px-2 py-1 text-text disabled:opacity-60"
          value={lineup?.pruneAggressiveness ?? 'normal'}
          disabled={!canEdit}
          onchange={(e) => setPrune({ pruneAggressiveness: e.currentTarget.value as 'gentle' | 'normal' | 'aggressive' })}
        >
          <option value="gentle">Gentle</option>
          <option value="normal">Normal</option>
          <option value="aggressive">Aggressive</option>
        </select>
      </label>
      <p class="text-xs text-muted">Gentle: tidy only. Normal: also cut the weakest mechanics. Aggressive: keep only what the Brief and the kept mechanics need.</p>
    </section>
    {#if !canEdit}<p class="text-xs text-muted">Agents are running; change these when they stop.</p>{/if}
  </div>
</div>
