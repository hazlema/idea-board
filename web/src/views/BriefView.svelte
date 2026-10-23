<script lang="ts">
  import { onMount, tick } from 'svelte';
  import SectionBox from '../brief/SectionBox.svelte';
  import { live } from '$lib/live.svelte';
  import type { Board, Section } from '$lib/types';

  interface Props {
    /** A board to show instead of the live one: the view is then read-only (a saved version's preview). */
    board?: Board;
  }

  let { board }: Props = $props();

  const readonly = $derived(board !== undefined);
  const sections = $derived((board ?? live.board)?.brief.sections ?? []);

  let focusNew = $state<string | null>(null);
  let now = $state(Date.now());
  let column: HTMLDivElement | undefined = $state();

  onMount(() => {
    const tickTimer = setInterval(() => (now = Date.now()), 30_000);
    return () => clearInterval(tickTimer);
  });

  async function add(): Promise<void> {
    const result = (await live.send({ type: 'addSection', title: '', text: '' })) as { section?: Section } | null;
    if (result?.section) focusNew = result.section.id;
  }

  // The new box arrives with the board update; focus its heading once it is there.
  $effect(() => {
    const id = focusNew;
    if (!id || !sections.some((s) => s.id === id)) return;
    focusNew = null;
    void tick().then(() => column?.querySelector<HTMLInputElement>(`[data-id="${id}"] input`)?.focus());
  });
</script>

<section class="min-h-0 flex-1 overflow-y-auto" aria-label="Brief">
  <div bind:this={column} inert={readonly} class="mx-auto flex w-full max-w-[760px] flex-col gap-3 px-4 py-6">
    <p class="text-muted">Free-form notes about the project. Claude reads this before every change and adds to it when you settle something.</p>

    {#each sections as section, i (section.id)}
      <SectionBox {section} first={i === 0} last={i === sections.length - 1} {now} />
    {/each}

    {#if !readonly}
      <button type="button" class="self-start rounded-md border border-dashed border-line px-3 py-1.5 text-muted hover:border-accent hover:text-text" onclick={add}>+ Add text box</button>
    {/if}
  </div>
</section>
