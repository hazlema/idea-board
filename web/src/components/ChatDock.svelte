<script lang="ts">
  import { live } from '$lib/live.svelte';
  import type { ChatMessage, Pointer } from '$lib/types';
  import { preview } from '../memory/preview.svelte';

  const MAX_LABEL = 200;
  const PLACEHOLDER = "Tell Claude what you're thinking… (Enter to send, Shift+Enter for a new line)";

  // Chat would change the live board, so it waits while an old version is being looked at.
  const previewing = $derived(preview.current !== null);

  let draft = $state('');
  let log: HTMLDivElement | undefined = $state();

  type Item = { at: string; key: string; message?: ChatMessage; notice?: string };

  const items = $derived<Item[]>(
    [
      ...(live.board?.chat ?? []).map((message): Item => ({ at: message.at, key: message.id, message })),
      ...live.notices.map((n, i): Item => ({ at: n.at, key: `notice-${i}`, notice: n.text })),
    ].sort((a, b) => a.at.localeCompare(b.at)),
  );

  const status = $derived.by(() => {
    if (live.agent === 'working') return 'Claude is working on the board';
    if (live.presence) return 'A Claude session is listening';
    if (live.agent === 'off') return 'Background Claude is off; chat waits for a session';
    return '';
  });

  // Keep the newest message in view.
  $effect(() => {
    void items.length;
    if (log) log.scrollTop = log.scrollHeight;
  });

  function contextFor(pointer: Pointer | null): Pointer[] | undefined {
    if (!pointer) return undefined;
    return [{ ...$state.snapshot(pointer), label: pointer.label.slice(0, MAX_LABEL) }];
  }

  async function submit(): Promise<void> {
    const text = draft.trim();
    if (!text || previewing) return;
    const context = contextFor(live.pointing);
    draft = '';
    const sent = await live.send({ type: 'chat', text, context });
    // A failed send keeps what was typed, unless the user has started something new.
    if (sent === null && !draft) draft = text;
  }

  function onkeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void submit();
    }
  }
</script>

<section class="flex flex-col border-t border-line bg-panel" aria-label="Chat with Claude">
  <div bind:this={log} class="flex max-h-48 min-h-0 flex-col gap-2 overflow-y-auto px-4 py-2">
    {#each items as item (item.key)}
      {#if item.message}
        {@const message = item.message}
        <div class="max-w-[80ch] rounded-md px-3 py-1.5 {message.role === 'claude' ? 'self-start bg-raised' : 'self-end bg-accent/20'}">
          <div class="text-xs font-medium {message.role === 'claude' ? 'text-claude' : 'text-accent'}">{message.role === 'claude' ? 'Claude' : 'You'}</div>
          <div class="whitespace-pre-wrap break-words">{message.text}</div>
          {#if message.context?.length}
            <div class="mt-1 text-xs text-muted">About: {message.context.map((c) => c.label).join(', ')}</div>
          {/if}
        </div>
      {:else}
        <div class="self-center text-xs text-muted">{item.notice}</div>
      {/if}
    {:else}
      <div class="text-muted">Tell Claude what you are thinking about. It can read and change the board.</div>
    {/each}
  </div>

  <div class="h-5 px-4 text-xs {live.agent === 'working' ? 'text-claude' : 'text-muted'}" aria-live="polite">{status}</div>

  <div class="flex flex-col gap-1.5 px-4 pb-3">
    {#if live.pointing}
      {@const pointing = live.pointing}
      <div class="flex w-fit max-w-full items-center gap-1.5 rounded-full border border-line bg-raised px-2.5 py-0.5 text-xs">
        <span class="text-muted">Talking about:</span>
        <span class="truncate font-medium">{pointing.label}</span>
        <button class="text-muted hover:text-text" aria-label="Stop talking about {pointing.label}" onclick={() => (live.pointing = null)}>×</button>
      </div>
    {/if}
    <textarea
      bind:value={draft}
      {onkeydown}
      rows="2"
      placeholder={previewing ? 'Close the preview to chat' : PLACEHOLDER}
      disabled={previewing}
      class="w-full resize-none rounded-md border border-line bg-ink px-3 py-2 placeholder:text-muted"
    ></textarea>
  </div>
</section>
