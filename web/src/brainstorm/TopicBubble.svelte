<script lang="ts">
  import { tick } from 'svelte';
  import { drag as dragAction, type DragOptions } from '$lib/actions';
  import { Draft } from '$lib/draft.svelte';
  import { live } from '$lib/live.svelte';
  import { findObject, type Topic } from '$lib/types';

  interface Props {
    topic: Topic;
    drag?: DragOptions;
    /** Start editing with the text selected (a new topic). */
    autofocus?: boolean;
    onfocused?: () => void;
  }

  let { topic, drag, autofocus = false, onfocused }: Props = $props();

  let editing = $state(false);
  let field: HTMLInputElement | undefined = $state();

  const text = new Draft({
    server: () => topic.text,
    save: (v) => (findObject(live.board, topic.id) ? live.send({ type: 'updateObject', id: topic.id, text: v }) : Promise.resolve({})),
    delay: 400,
  });

  async function edit(): Promise<void> {
    editing = true;
    await tick();
    field?.focus();
    field?.select();
  }

  $effect(() => {
    if (!autofocus) return;
    void edit();
    onfocused?.();
  });

  async function leave(): Promise<void> {
    editing = false;
    await text.blur();
  }
</script>

<!-- The pill drags from anywhere; double-click to rename it. -->
<div
  use:dragAction={drag}
  role="button"
  tabindex="-1"
  title="Double-click to rename"
  class="cursor-grab rounded-full border border-white/15 bg-black px-[22px] py-3 text-base font-bold whitespace-nowrap text-white shadow-[0_4px_14px_rgba(0,0,0,0.45)] select-none active:cursor-grabbing"
  ondblclick={(e) => {
    e.stopPropagation();
    void edit();
  }}
  onkeydown={(e) => {
    if (e.key === 'Enter' && e.target === e.currentTarget) void edit();
  }}
>
  {#if editing}
    <input
      bind:this={field}
      type="text"
      maxlength="200"
      placeholder="Topic"
      aria-label="Topic"
      size={Math.max(4, text.shown.length)}
      class="field-sizing-content min-w-[4ch] bg-transparent p-0 font-bold text-white outline-none placeholder:text-white/40"
      value={text.shown}
      oninput={(e) => text.input(e.currentTarget.value)}
      onfocus={() => text.focus()}
      onblur={leave}
      onkeydown={(e) => {
        if ((e.key === 'Enter' || e.key === 'Escape') && !e.isComposing) e.currentTarget.blur();
      }}
    />
  {:else}
    <span class={text.shown.trim() ? '' : 'text-white/40'}>{text.shown.trim() || 'Topic'}</span>
  {/if}
</div>
