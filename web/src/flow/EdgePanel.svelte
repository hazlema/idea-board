<script lang="ts">
  import { onMount } from 'svelte';
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

  const DELAY = 400;

  // Same rule as the card panel: typing is kept until it has been sent and the field is left.
  let draft = $state<string | null>(null);
  let focused = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;

  const shown = $derived(draft ?? edge.label);
  const titleOf = (id: string): string => live.board?.flow.nodes.find((n) => n.id === id)?.title ?? '?';

  onMount(() => () => void flush());

  async function save(): Promise<void> {
    const sent = draft;
    if (sent === null) return;
    await live.send({ type: 'updateEdge', id: edge.id, label: sent });
    if (!focused && draft === sent) draft = null;
  }

  async function flush(): Promise<void> {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
    await save();
  }

  function type(value: string): void {
    draft = value;
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void save();
    }, DELAY);
  }

  async function onBlur(): Promise<void> {
    focused = false;
    await flush();
    if (timer === undefined && draft !== null && !focused) draft = null;
  }

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
      value={shown}
      oninput={(e) => type(e.currentTarget.value)}
      {onkeydown}
      onfocus={() => (focused = true)}
      onblur={onBlur}
    />
  </div>

  <div class="mt-auto flex justify-end">
    <button type="button" class="rounded-md border border-line px-2.5 py-1 text-rose-400 hover:border-rose-400" onclick={ondelete}>Delete connection</button>
  </div>
</div>
