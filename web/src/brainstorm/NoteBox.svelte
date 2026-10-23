<script lang="ts" module>
  import type { Color } from '$lib/types';

  /** Sticky-note paper for each colour; the default (slate) is the classic yellow. */
  const PAPER: Record<Color, { bg: string; edge: string }> = {
    slate: { bg: '#fff7c2', edge: '#f0e08a' },
    amber: { bg: '#fde2c0', edge: '#f5c58a' },
    rose: { bg: '#fdd5dc', edge: '#f4aab8' },
    green: { bg: '#d4f5dc', edge: '#a8e2b6' },
    sky: { bg: '#d3ecfb', edge: '#a3d3f2' },
    violet: { bg: '#e6ddfd', edge: '#c8b8f6' },
  };
</script>

<script lang="ts">
  import { autogrow, drag as dragAction, resize as resizeAction, type DragOptions, type ResizeOptions } from '$lib/actions';
  import { Draft } from '$lib/draft.svelte';
  import { live } from '$lib/live.svelte';
  import { findObject, type Note } from '$lib/types';

  interface Props {
    note: Note;
    drag?: DragOptions;
    resize?: ResizeOptions;
    autofocus?: boolean;
    onfocused?: () => void;
  }

  let { note, drag, resize, autofocus = false, onfocused }: Props = $props();

  let field: HTMLTextAreaElement | undefined = $state();

  const text = new Draft({
    server: () => note.text,
    save: (v) => (findObject(live.board, note.id) ? live.send({ type: 'updateObject', id: note.id, text: v }) : Promise.resolve({})),
    delay: 500,
  });

  const paper = $derived(PAPER[note.color] ?? PAPER.slate);

  $effect(() => {
    if (!autofocus || !field) return;
    field.focus();
    onfocused?.();
  });
</script>

<!-- Dragged by the strip along the top or the paper around the text. -->
<div
  use:dragAction={drag}
  class="note relative flex flex-1 cursor-grab flex-col rounded-xl border px-3.5 pt-4 pb-3 text-[#2b2a24] shadow-lg active:cursor-grabbing"
  style:background={paper.bg}
  style:border-color={paper.edge}
>
  <div class="absolute inset-x-0 top-0 h-3.5 rounded-t-xl" title="Drag to move" aria-hidden="true"></div>
  <textarea
    bind:this={field}
    rows="2"
    placeholder="Write a note…"
    aria-label="Note"
    class="block w-full flex-1 cursor-text resize-none overflow-hidden bg-transparent p-0 leading-[1.45] whitespace-pre-wrap outline-none placeholder:text-[#2b2a24]/45"
    use:autogrow={text.shown}
    {...text.attrs}
  ></textarea>

  {#if resize}
    <div use:resizeAction={resize} data-no-drag class="absolute right-0 bottom-0 size-4 cursor-nwse-resize text-[#2b2a24]/50" title="Drag to resize" aria-hidden="true">
      <svg viewBox="0 0 16 16" class="size-full"><path d="M12 6 6 12M12 10l-2 2" stroke="currentColor" stroke-width="1.3" fill="none" /></svg>
    </div>
  {/if}
</div>

<style>
  .note {
    font-family: 'Segoe Print', 'Comic Neue', 'Bradley Hand', cursive, system-ui;
  }
</style>
