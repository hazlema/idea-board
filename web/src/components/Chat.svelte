<script lang="ts">
  import type { Snippet } from 'svelte';
  import { CHAT_FONT, chatPrefs } from '$lib/chatPrefs.svelte';
  import { authorColor, authorName, isAi } from '$lib/authors';
  import { live } from '$lib/live.svelte';
  import type { ChatMessage, Pointer, TurnStats } from '$lib/types';
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

  // While agents take turns, the header shows whose turn it is in that agent's colour.
  const turnColor = $derived.by(() => {
    const run = live.colab;
    if (!run || (run.state !== 'running' && run.state !== 'stopping') || !run.current) return null;
    return authorColor(live.board, run.current);
  });

  // "1 min 42 s · $0.031 · 3 calls · 68% read from cache": how long a turn took and whether the cache helped.
  function turnLine(s: TurnStats): string {
    const secs = Math.round(s.seconds);
    const time = secs < 60 ? `${secs} s` : `${Math.floor(secs / 60)} min ${secs % 60} s`;
    const cost = s.cost > 0 && s.cost < 0.1 ? s.cost.toFixed(3) : s.cost.toFixed(2);
    const parts = [time, `$${cost}`, `${s.calls} call${s.calls === 1 ? '' : 's'}`];
    if (s.promptTokens > 0) parts.push(`${Math.round((s.cachedTokens / s.promptTokens) * 100)}% read from cache`);
    return parts.join(' · ');
  }

  // Who is working right now and on what, for the live line at the end of the chat:
  // an agent taking its turn, or the background Claude answering.
  const working = $derived.by((): { name: string; color: string; doing: string; done: string[] } | null => {
    const run = live.colab;
    if (run && (run.state === 'running' || run.state === 'stopping') && run.current) {
      const mine = run.connections?.[run.current];
      return { name: authorName(live.board, run.current), color: authorColor(live.board, run.current), doing: mine?.activity ?? 'starting its turn', done: (mine?.done ?? []).slice(-3) };
    }
    if (live.agent === 'working') return { name: 'Claude', color: authorColor(live.board, 'claude'), doing: 'working on the board', done: [] };
    return null;
  });

  const status = $derived.by(() => {
    const run = live.colab;
    if (run && (run.state === 'running' || run.state === 'stopping')) {
      const turn = live.board?.colab?.roster.find((r) => r.id === run.current)?.modelName;
      // Turns count across rounds: each round is one turn per agent in the line-up (locked during a run).
      const agents = live.board?.colab?.lineup.agents ?? [];
      const seat = agents.findIndex((a) => `agent:${a.model}=${a.roleId}` === run.current);
      const count = seat >= 0 ? `Turn ${(run.round - 1) * agents.length + seat + 1} of ${run.rounds * agents.length} · ` : '';
      return `${count}Round ${run.round} of ${run.rounds}${turn ? ` · ${turn}'s turn` : ''}`;
    }
    if (live.agent === 'working') return 'Claude is working on the board';
    if (live.presence) return 'A Claude session is listening';
    return '';
  });

  // Keep the newest message in view (also when the text size changes).
  $effect(() => {
    void items.length;
    void chatPrefs.fontSize;
    void working;
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
    {#if turnColor}<span class="shrink-0" style:color={turnColor} aria-hidden="true">●</span>{/if}
    <span
      class="min-w-0 flex-1 truncate {turnColor ? 'font-semibold' : live.agent === 'working' ? 'text-claude' : 'text-muted'}"
      style:color={turnColor}
      aria-live="polite">{status}</span
    >
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
          {#if message.stats}
            <div class="mt-1 text-[0.75em] text-muted">{turnLine(message.stats)}</div>
          {/if}
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
    {#if working}
      <div class="flex max-w-[80ch] items-center gap-[0.5em] self-start rounded-md border border-dashed px-[0.8em] py-[0.4em]" style:border-color={working.color} role="status" aria-label="Working">
        <span class="animate-pulse" style:color={working.color} aria-hidden="true">●</span>
        <span class="text-[0.8em] font-medium" style:color={working.color}>{working.name}</span>
        <span class="text-muted">{working.doing}…</span>
        {#each working.done as step, i (i)}<span class="text-[0.8em] text-muted">· {step}</span>{/each}
      </div>
    {/if}
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
