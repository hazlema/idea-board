<script lang="ts">
  import type { Snippet } from 'svelte';
  import { CHAT_FONT, chatPrefs } from '$lib/chatPrefs.svelte';
  import { authorColor, authorName, isAi } from '$lib/authors';
  import { live } from '$lib/live.svelte';
  import type { ChatMessage, Pointer } from '$lib/types';
  import { preview } from '../memory/preview.svelte';

  interface Props {
    /** Buttons at the right of the header (Pop out, or the window's own). */
    controls?: Snippet;
  }

  let { controls }: Props = $props();

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
    const run = live.colab;
    if (run?.state === 'waiting') return 'Waiting for your first message';
    if (run && (run.state === 'running' || run.state === 'stopping')) {
      const turn = live.board?.colab?.roster.find((r) => r.id === run.current)?.modelName;
      return `Round ${run.round} of ${run.rounds}${turn ? ` · ${turn}'s turn` : ''}`;
    }
    if (live.agent === 'working') return 'Claude is working on the board';
    if (live.presence) return 'A Claude session is listening';
    if (live.agent === 'off') return 'Background Claude is off; chat waits for a session';
    return '';
  });

  // Keep the newest message in view (also when the text size changes).
  $effect(() => {
    void items.length;
    void chatPrefs.fontSize;
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

<!-- Sizes inside are in em, so the text-size slider scales all of it. -->
<section class="flex min-h-0 flex-1 flex-col" style:font-size="{chatPrefs.fontSize}px" aria-label="Chat with Claude">
  <div class="flex items-center gap-3 border-b border-line px-4 py-1.5 text-[0.8em]">
    <span class="min-w-0 flex-1 truncate {live.agent === 'working' ? 'text-claude' : 'text-muted'}" aria-live="polite">{status}</span>
    <label class="flex shrink-0 items-center gap-2 text-muted" title="Chat text size">
      <span aria-hidden="true" class="text-[0.85em]">A</span>
      <input
        type="range"
        class="w-24 accent-accent"
        aria-label="Chat text size"
        min={CHAT_FONT.min}
        max={CHAT_FONT.max}
        step="1"
        value={chatPrefs.fontSize}
        oninput={(e) => (chatPrefs.fontSize = Number(e.currentTarget.value))}
      />
      <span aria-hidden="true" class="text-[1.3em]">A</span>
    </label>
    {@render controls?.()}
  </div>

  <div bind:this={log} class="flex min-h-0 flex-1 flex-col gap-[0.6em] overflow-y-auto px-4 py-3 leading-normal">
    {#each items as item (item.key)}
      {#if item.message}
        {@const message = item.message}
        <div class="max-w-[80ch] rounded-md px-[0.8em] py-[0.4em] {isAi(message.role) ? 'self-start bg-raised' : 'self-end bg-accent/20'}">
          <div class="text-[0.8em] font-medium" style:color={authorColor(live.board, message.role)}>{authorName(live.board, message.role)}</div>
          <div class="break-words whitespace-pre-wrap">{message.text}</div>
          {#if message.context?.length}
            <div class="mt-1 text-[0.8em] text-muted">About: {message.context.map((c) => c.label).join(', ')}</div>
          {/if}
        </div>
      {:else}
        <div class="self-center text-[0.8em] text-muted">{item.notice}</div>
      {/if}
    {:else}
      <div class="text-muted">Tell Claude what you are thinking about. It can read and change the board.</div>
    {/each}
  </div>

  <div class="flex flex-col gap-1.5 px-4 pt-1 pb-3">
    {#if live.pointing}
      {@const pointing = live.pointing}
      <div class="flex w-fit max-w-full items-center gap-1.5 rounded-full border border-line bg-raised px-2.5 py-0.5 text-[0.8em]">
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
