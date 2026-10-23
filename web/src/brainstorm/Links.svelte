<script lang="ts" module>
  import type { Point } from '$lib/geometry';

  export interface LinkLine {
    id: string;
    d: string;
    mid: Point;
    label: string;
    dashed: boolean;
  }
</script>

<script lang="ts">
  import { Draft } from '$lib/draft.svelte';
  import { live } from '$lib/live.svelte';
  import type { BLink } from '$lib/types';

  interface Props {
    lines: LinkLine[];
    /** The selected link, edited in a small box under its middle. */
    selected: BLink | undefined;
    onselect: (id: string) => void;
    ondelete: (id: string) => void;
  }

  let { lines, selected, onselect, ondelete }: Props = $props();

  // The link whose label is being typed; saves go to it even if the selection moves on.
  let editing: string | null = null;

  const label = new Draft({
    server: () => selected?.label ?? '',
    save: (v) => (editing && live.board?.brainstorm.pages.some((p) => p.links.some((l) => l.id === editing)) ? live.send({ type: 'updateLink', id: editing, label: v }) : Promise.resolve({})),
    delay: 400,
  });

  // A different link is selected: its own label shows.
  let shownFor: string | null = null;
  $effect(() => {
    const id = selected?.id ?? null;
    if (id === shownFor) return;
    shownFor = id;
    label.cancel();
  });

  const selectedLine = $derived(lines.find((l) => l.id === selected?.id));
</script>

<!-- Zero-sized and overflow-visible, so paths can use world coordinates directly. -->
<svg class="pointer-events-none absolute top-0 left-0 overflow-visible" width="1" height="1" role="group" aria-label="Links">
  {#each lines as line (line.id)}
    {@const on = line.id === selected?.id}
    <g
      data-nopan
      role="button"
      tabindex="0"
      aria-label={line.label ? `Link: ${line.label}` : 'Link'}
      class="group cursor-pointer outline-none"
      onpointerdown={(event) => {
        event.stopPropagation();
        onselect(line.id);
      }}
      onkeydown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onselect(line.id);
        }
      }}
    >
      <path d={line.d} fill="none" stroke="transparent" stroke-width="14" pointer-events="stroke" />
      <path
        d={line.d}
        fill="none"
        stroke={on ? 'var(--color-accent)' : '#7d8496'}
        stroke-width={on ? 2.5 : 2}
        stroke-dasharray={line.dashed ? '6 5' : undefined}
        class={on ? '' : 'group-hover:stroke-text'}
      />
      {#if line.label}
        <text
          x={line.mid.x}
          y={line.mid.y}
          text-anchor="middle"
          dominant-baseline="middle"
          font-size="12"
          fill="var(--color-muted)"
          stroke="var(--color-ink)"
          stroke-width="5"
          stroke-linejoin="round"
          paint-order="stroke"
          pointer-events="none">{line.label}</text
        >
      {/if}
    </g>
  {/each}
</svg>

{#if selected && selectedLine}
  <div
    data-nopan
    role="group"
    aria-label="Link details"
    class="absolute z-30 flex -translate-x-1/2 items-center gap-2 rounded-lg border border-line bg-panel px-2 py-1.5 text-sm shadow-lg"
    style:left="{selectedLine.mid.x}px"
    style:top="{selectedLine.mid.y + 14}px"
  >
    <input
      type="text"
      maxlength="200"
      placeholder="Label"
      aria-label="Link label"
      class="w-32 rounded-md border border-line bg-ink px-2 py-0.5"
      {...label.attrs}
      onfocus={() => {
        editing = selected?.id ?? null;
        label.focus();
      }}
      onkeydown={(e) => {
        if (e.key === 'Enter' && !e.isComposing) e.currentTarget.blur();
      }}
    />
    <label class="flex items-center gap-1 text-muted select-none">
      <input type="checkbox" checked={selected.dashed} onclick={(e) => {
        e.preventDefault();
        void live.send({ type: 'updateLink', id: selected.id, dashed: !selected.dashed });
      }} /> Dashed
    </label>
    <button type="button" class="rounded-md border border-line px-2 py-0.5 text-rose-400 hover:border-rose-400" onclick={() => ondelete(selected.id)}>Delete</button>
  </div>
{/if}
