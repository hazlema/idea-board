<script lang="ts">
  import type { Snippet } from 'svelte';
  import { tick } from 'svelte';
  import { CHAT_FONT, chatPrefs } from '$lib/chatPrefs.svelte';
  import { chatHistory } from '$lib/chatHistory';
  import { authorColor, authorName, cardIds, isAi } from '$lib/authors';
  import * as api from '$lib/api';
  import { live } from '$lib/live.svelte';
  import type { Author, ChatMessage, Pointer, TurnStats } from '$lib/types';
  import { preview } from '../memory/preview.svelte';

  interface Props {
    /** Buttons at the right of the header (Pop out, or the window's own). */
    controls?: Snippet;
  }

  let { controls }: Props = $props();

  const MAX_LABEL = 200;
  const PLACEHOLDER = 'Message everyone, or /chat N to ask one… (Enter to send, Shift+Enter for a new line)';
  const COMMANDS_HINT = '/chat N (or /c N) · /start · /stop · /prune · ↑ for earlier messages';

  // Chat would change the live board, so it waits while an old version is being looked at.
  const previewing = $derived(preview.current !== null);

  let draft = $state('');
  let error = $state('');
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

  // Connection numbers: Claude is 1, the cards follow in line-up order from 2.
  const ids = $derived(cardIds(live.board?.colab?.lineup.agents ?? []) as Author[]);

  /** The tag for a message's target: "2. Name" while connected, just the name once the card is gone. */
  function targetTag(target: string): string {
    const id = target as Author;
    const name = authorName(live.board, id);
    const n = id === 'claude' ? 1 : ids.indexOf(id) + 2;
    return n >= 1 && (id === 'claude' || ids.includes(id)) ? `${n}. ${name}` : name;
  }

  type Working = { key: string; name: string; color: string; doing: string; done: string[] };

  // Who is working right now and on what, one live line each at the end of the chat:
  // every connection that is thinking, and the background Claude answering.
  const working = $derived.by((): Working[] => {
    const run = live.colab;
    const lines: Working[] = [];
    if (live.agent === 'working' || run?.current === 'claude') {
      const mine = run?.connections?.claude;
      lines.push({ key: 'claude', name: authorName(live.board, 'claude'), color: authorColor(live.board, 'claude'), doing: mine?.activity || 'working on the board', done: (mine?.done ?? []).slice(-3) });
    }
    for (const id of ids) {
      const mine = run?.connections?.[id];
      if (mine?.state !== 'thinking') continue;
      lines.push({ key: id, name: authorName(live.board, id), color: authorColor(live.board, id), doing: mine.activity || 'starting its turn', done: (mine.done ?? []).slice(-3) });
    }
    return lines;
  });

  const running = $derived(live.colab?.state === 'running' || live.colab?.state === 'stopping');

  const status = $derived.by(() => {
    const run = live.colab;
    if (run && (run.state === 'running' || run.state === 'stopping')) {
      const turn = run.current === 'claude' ? authorName(live.board, 'claude') : live.board?.colab?.roster.find((r) => r.id === run.current)?.modelName;
      return `Round ${run.round} of ${run.rounds}${turn ? ` · ${turn}'s turn` : ''}`;
    }
    return run?.claude === 'mcp' ? 'A Claude session is listening' : '';
  });

  const showHint = $derived(draft.trimStart().startsWith('/'));

  // Keep the newest message in view (also when the text size changes).
  $effect(() => {
    void items.length;
    void chatPrefs.fontSize;
    void working.length;
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
    chatHistory.add(text);
    draft = '';
    error = '';
    const sent = await live.chat(text, context);
    // A refused or failed send keeps what was typed, unless the user has started something new.
    if ('error' in sent) {
      error = sent.error;
      if (!draft) draft = text;
    }
  }

  // Up on the first line brings back what was sent before; Down on the last line comes forward.
  async function recall(event: KeyboardEvent, box: HTMLTextAreaElement): Promise<void> {
    const { selectionStart: start, selectionEnd: end, value } = box;
    const up = event.key === 'ArrowUp';
    if (start !== end || (up ? value.lastIndexOf('\n', start - 1) !== -1 : value.indexOf('\n', end) !== -1)) return;
    const next = up ? chatHistory.older(value) : chatHistory.newer();
    if (next === null) return;
    event.preventDefault();
    draft = next;
    await tick();
    box.setSelectionRange(next.length, next.length);
  }

  function onkeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void submit();
    } else if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey && !event.isComposing) {
      void recall(event, event.currentTarget as HTMLTextAreaElement);
    }
  }
</script>

<!-- Sizes inside are in em, so the text-size slider scales all of it. -->
<section class="flex min-h-0 flex-1 flex-col" style:font-size="{chatPrefs.fontSize}px" aria-label="Chat with Claude">
  <div class="flex items-center gap-3 border-b border-line px-4 py-1.5 text-[0.8em]">
    {#if turnColor}<span class="shrink-0" style:color={turnColor} aria-hidden="true">●</span>{/if}
    <span
      class="min-w-0 flex-1 truncate {turnColor ? 'font-semibold' : 'text-muted'}"
      style:color={turnColor}
      aria-live="polite">{status}</span
    >
    {#if running || live.colab?.pruning || live.colab?.prunePending}
      <button
        class="shrink-0 rounded-md border border-line px-2 py-0.5 hover:bg-raised disabled:opacity-50"
        disabled={live.colab?.state === 'stopping'}
        onclick={() => void api.stopColab()}>{live.colab?.state === 'stopping' ? 'Stopping…' : 'Stop'}</button
      >
    {/if}
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
          <div class="text-[0.8em] font-medium" style:color={authorColor(live.board, message.role)}>{authorName(live.board, message.role)}{#if message.to?.length}<span class="ml-1.5 text-muted">→ {message.to.map(targetTag).join(', ')}</span>{/if}{#if message.start}<span class="ml-1.5 text-muted">▶ run started</span>{/if}</div>
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
      <div class="text-muted">Talk to everyone connected. They can read and change the board.</div>
    {/each}
    {#each working as line (line.key)}
      <div class="flex max-w-[80ch] items-center gap-[0.5em] self-start rounded-md border border-dashed px-[0.8em] py-[0.4em]" style:border-color={line.color} role="status" aria-label="Working">
        <span class="animate-pulse" style:color={line.color} aria-hidden="true">●</span>
        <span class="text-[0.8em] font-medium" style:color={line.color}>{line.name}</span>
        <span class="text-muted">{line.doing}…</span>
        {#each line.done as step, i (i)}<span class="text-[0.8em] text-muted">· {step}</span>{/each}
      </div>
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
      oninput={() => {
        error = '';
        chatHistory.reset();
      }}
      {onkeydown}
      rows="2"
      placeholder={previewing ? 'Close the preview to chat' : PLACEHOLDER}
      disabled={previewing}
      class="w-full resize-none rounded-md border border-line bg-ink px-3 py-2 placeholder:text-muted"
    ></textarea>
    {#if showHint}<div class="text-[0.8em] text-muted">Commands: {COMMANDS_HINT}</div>{/if}
    {#if error}<div role="alert" class="text-[0.8em] text-red-400">{error}</div>{/if}
  </div>
</section>
