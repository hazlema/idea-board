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
  import LinkEditor from './LinkEditor.svelte';
  import type { BLink } from '$lib/types';

  interface Props {
    lines: LinkLine[];
    /** The selected link, edited in a small box under its middle. */
    selected: BLink | undefined;
    onselect: (id: string) => void;
    ondelete: (id: string) => void;
  }

  let { lines, selected, onselect, ondelete }: Props = $props();

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
  {#key selected.id}
    <LinkEditor link={selected} at={selectedLine.mid} {ondelete} />
  {/key}
{/if}
