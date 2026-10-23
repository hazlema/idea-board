<script lang="ts">
  import { whoName } from '$lib/format';
  import type { FlowNode } from '$lib/types';

  interface Props {
    node: FlowNode;
    /** Where to draw it: a card being dragged is ahead of the board. */
    x: number;
    y: number;
    selected: boolean;
    flashing: boolean;
    /** The card an arrow being dragged would connect to. */
    connectTarget: boolean;
    dragging: boolean;
    onmovestart: (event: PointerEvent) => void;
    onconnectstart: (event: PointerEvent) => void;
    ontoggle: (accepted: boolean) => void | Promise<void>;
    onopen: () => void;
    onsize: (w: number, h: number) => void;
  }

  let { node, x, y, selected, flashing, connectTarget, dragging, onmovestart, onconnectstart, ontoggle, onopen, onsize }: Props = $props();

  let width = $state(0);
  let height = $state(0);

  $effect(() => {
    if (width > 0 && height > 0) onsize(width, height);
  });

  const accepted = $derived(node.status === 'accepted');
  const rejected = $derived(node.status === 'rejected');

  async function toggle(event: Event & { currentTarget: HTMLInputElement }): Promise<void> {
    const box = event.currentTarget;
    await ontoggle(box.checked);
    // If the change did not go through, show what the board says.
    box.checked = accepted;
  }

  const stripe = $derived(accepted ? 'border-l-green-500' : rejected ? 'border-l-rose-500' : 'border-l-slate-400');
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  data-nopan
  data-node-id={node.id}
  aria-label={node.title}
  class="group absolute min-h-14 w-[220px] cursor-pointer rounded-[10px] border border-l-[5px] border-line bg-panel py-2 pr-3 pl-2.5 shadow-md select-none {stripe} {selected ? 'outline-2 outline-offset-1 outline-accent' : ''} {connectTarget ? 'outline-2 outline-dashed outline-accent' : ''} {dragging ? 'z-10 cursor-grabbing shadow-xl' : ''} {rejected ? 'opacity-55' : ''} {flashing ? 'flash-claude' : ''}"
  style:left="{x}px"
  style:top="{y}px"
  bind:offsetWidth={width}
  bind:offsetHeight={height}
  onpointerdown={onmovestart}
  ondblclick={(event) => {
    event.stopPropagation();
    onopen();
  }}
>
  <div class="flex items-start gap-2">
    <input
      type="checkbox"
      class="mt-0.5 shrink-0 cursor-pointer accent-green-500"
      title={rejected ? 'Rejected' : 'Accepted'}
      aria-label="Accepted"
      checked={accepted}
      disabled={rejected}
      onpointerdown={(event) => event.stopPropagation()}
      ondblclick={(event) => event.stopPropagation()}
      onchange={toggle}
    />
    <div class="flex-1 truncate leading-snug font-semibold {rejected ? 'line-through' : ''}" title={node.title}>{node.title}</div>
  </div>
  <div class="mt-1 flex gap-2 pl-[22px] text-xs text-muted">
    <span class="font-semibold {node.author === 'claude' ? 'text-claude' : ''}">{whoName(node.author)}</span>
    {#if node.props.length}<span>{node.props.length} prop{node.props.length > 1 ? 's' : ''}</span>{/if}
    {#if node.notes.trim()}<span>notes</span>{/if}
  </div>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    title="Drag to another idea to connect"
    class="absolute top-1/2 -right-[7px] -mt-1.5 size-3 cursor-crosshair rounded-full border-2 border-muted bg-panel opacity-0 group-hover:opacity-100 hover:border-accent hover:bg-accent {selected || connectTarget ? 'opacity-100' : ''}"
    onpointerdown={(event) => {
      event.stopPropagation();
      onconnectstart(event);
    }}
  ></div>
</div>
