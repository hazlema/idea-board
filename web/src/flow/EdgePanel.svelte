<script lang="ts">
  import { Draft } from '$lib/draft.svelte';
  import { whoName } from '$lib/format';
  import { live } from '$lib/live.svelte';
  import type { FlowEdge } from '$lib/types';

  interface Props {
    edge: FlowEdge;
    onclose: () => void;
    ondelete: () => void;
    ongoto: (id: string) => void;
  }

  let { edge, onclose, ondelete, ongoto }: Props = $props();

  // Saving a connection that is gone (deleted meanwhile) has nothing left to do.
  const label = new Draft({
    server: () => edge.label,
    save: (v) => (live.board?.flow.edges.some((e) => e.id === edge.id) ? live.send({ type: 'updateEdge', id: edge.id, label: v }) : Promise.resolve({})),
    delay: 400,
  });

  const titleOf = (id: string): string => live.board?.flow.nodes.find((n) => n.id === id)?.title ?? '?';

  function onkeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter' || event.isComposing) return;
    event.preventDefault();
    (event.currentTarget as HTMLInputElement).blur();
  }
</script>

<div class="flex min-h-full flex-col gap-4">
  <div class="flex items-center justify-between text-xs text-muted">
    <span>Connection · added by {whoName(edge.author)}</span>
    <button type="button" class="px-1.5 text-lg leading-none text-muted hover:text-text" title="Close (Esc)" aria-label="Close" onclick={onclose}>×</button>
  </div>

  <div class="flex flex-col gap-1.5">
    <span class="text-xs font-semibold tracking-wide text-muted uppercase">From → to</span>
    <ul class="m-0 flex list-none flex-col gap-1 p-0">
      <li><button type="button" class="text-left text-accent hover:underline" onclick={() => ongoto(edge.from)}>{titleOf(edge.from)}</button></li>
      <li class="flex items-center gap-1.5">
        <span class="w-3.5 text-muted">→</span>
        <button type="button" class="text-left text-accent hover:underline" onclick={() => ongoto(edge.to)}>{titleOf(edge.to)}</button>
      </li>
    </ul>
  </div>

  <div class="flex flex-col gap-1.5">
    <label class="text-xs font-semibold tracking-wide text-muted uppercase" for="edge-label">Label</label>
    <input
      id="edge-label"
      type="text"
      maxlength="200"
      placeholder="e.g. unlocks, requires, costs"
      class="w-full rounded-md border border-line bg-ink px-2.5 py-1.5"
      {...label.attrs}
      {onkeydown}
    />
  </div>

  <div class="mt-auto flex justify-end">
    <button type="button" class="rounded-md border border-line px-2.5 py-1 text-rose-400 hover:border-rose-400" onclick={ondelete}>Delete connection</button>
  </div>
</div>
