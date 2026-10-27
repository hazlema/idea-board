<script lang="ts">
  // The foreman's request, waiting for the host: the whole chain, then Yes or No. Nothing is sent
  // before Yes. There's no close button or Escape: the host has to answer.
  import * as api from '$lib/api';
  import { authorName } from '$lib/authors';
  import { live } from '$lib/live.svelte';

  const request = $derived(live.board?.colab?.request?.state === 'waiting' ? live.board.colab.request : null);
  let sending = $state(false);
  let error = $state('');

  async function answer(yes: boolean): Promise<void> {
    if (!request) return;
    sending = true;
    error = '';
    try {
      await api.answerRequest(request.id, yes);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      sending = false;
    }
  }

  function focusOnMount(node: HTMLElement): void {
    node.focus();
  }
</script>

{#if request}
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-ink/70">
    <div
      class="flex max-h-[85vh] w-[min(520px,94vw)] flex-col gap-3 overflow-y-auto rounded-xl border border-line bg-panel p-4 text-sm shadow-2xl"
      role="dialog"
      aria-modal="true"
      aria-labelledby="request-title"
      tabindex="-1"
      use:focusOnMount
    >
      <h2 id="request-title" class="text-base font-semibold">{authorName(live.board, request.by)} asks:</h2>
      <ol class="flex list-decimal flex-col gap-2 rounded-md border border-line bg-raised py-3 pr-3 pl-8">
        {#each request.steps as step, i (i)}
          <li class="break-words whitespace-pre-wrap"><span class="font-medium">{step.name}</span>: {step.text}</li>
        {/each}
      </ol>
      <p class="text-xs text-muted">Each step goes out after the agent before it has answered.</p>
      {#if error}<p role="alert" class="text-xs text-red-400">{error}</p>{/if}
      <div class="flex justify-end gap-2">
        <button type="button" class="rounded-md border border-line px-3 py-1 hover:bg-raised disabled:opacity-50" disabled={sending} onclick={() => void answer(false)}>No</button>
        <button type="button" class="rounded-md bg-accent px-3 py-1 font-medium text-ink hover:opacity-90 disabled:opacity-50" disabled={sending} onclick={() => void answer(true)}>Yes, send it</button>
      </div>
    </div>
  </div>
{/if}
