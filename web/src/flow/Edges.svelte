<script lang="ts" module>
  import type { Point } from '$lib/geometry';

  export interface EdgeLine {
    id: string;
    d: string;
    mid: Point;
    label: string;
    selected: boolean;
  }
</script>

<script lang="ts">

  interface Props {
    edges: EdgeLine[];
    /** The path of an arrow being dragged out of a card. */
    draft: string | null;
    onselect: (id: string) => void;
  }

  let { edges, draft, onselect }: Props = $props();
</script>

<!-- Zero-sized and overflow-visible, so paths can use world coordinates directly. -->
<svg class="pointer-events-none absolute top-0 left-0 overflow-visible" width="1" height="1" aria-hidden="true">
  <defs>
    <marker id="flow-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" fill="var(--color-muted)" />
    </marker>
    <marker id="flow-arrow-selected" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" fill="var(--color-accent)" />
    </marker>
  </defs>
  {#each edges as edge (edge.id)}
    <g
      data-nopan
      role="button"
      tabindex="0"
      aria-label={edge.label ? `Connection: ${edge.label}` : 'Connection'}
      class="group cursor-pointer outline-none"
      onpointerdown={(event) => {
        event.stopPropagation();
        onselect(edge.id);
      }}
      onkeydown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onselect(edge.id);
        }
      }}
    >
      <path d={edge.d} fill="none" stroke="transparent" stroke-width="14" pointer-events="stroke" />
      <path
        d={edge.d}
        fill="none"
        stroke={edge.selected ? 'var(--color-accent)' : 'var(--color-muted)'}
        stroke-width={edge.selected ? 2.2 : 1.6}
        marker-end={edge.selected ? 'url(#flow-arrow-selected)' : 'url(#flow-arrow)'}
        class={edge.selected ? '' : 'group-hover:stroke-text'}
      />
      {#if edge.label}
        <text
          x={edge.mid.x}
          y={edge.mid.y}
          text-anchor="middle"
          dominant-baseline="middle"
          font-size="12"
          fill="var(--color-muted)"
          stroke="var(--color-ink)"
          stroke-width="5"
          stroke-linejoin="round"
          paint-order="stroke"
          pointer-events="none">{edge.label}</text>
      {/if}
    </g>
  {/each}
  {#if draft}
    <path d={draft} fill="none" stroke="var(--color-accent)" stroke-width="1.6" stroke-dasharray="5 4" marker-end="url(#flow-arrow-selected)" />
  {/if}
</svg>
