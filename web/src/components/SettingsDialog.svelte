<script lang="ts">
  // ⋯ → Settings: board settings that don't need to sit in the sidebar. For now, the image model.
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
      {#if !canEdit}<p class="text-xs text-muted">Agents are running; change it when they stop.</p>{/if}
    </section>
  </div>
</div>
