<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { ago, whoName } from '$lib/format';
  import { live } from '$lib/live.svelte';
  import type { FlowNode, FlowProp, FlowStatus } from '$lib/types';

  type Field = 'title' | 'notes';

  interface Props {
    node: FlowNode;
    /** Set when the title should take focus (a new card, or a double-click on a card). */
    focusTitle: boolean;
    onfocused: () => void;
    onclose: () => void;
    ondelete: () => void;
    ongoto: (id: string) => void;
  }

  let { node, focusTitle, onfocused, onclose, ondelete, ongoto }: Props = $props();

  const DELAY: Record<Field, number> = { title: 400, notes: 500 };
  const STATUSES: { key: FlowStatus; label: string }[] = [
    { key: 'idea', label: 'Idea' },
    { key: 'accepted', label: 'Accepted' },
    { key: 'rejected', label: 'Rejected' },
  ];

  // What the user has typed and the server has not confirmed yet. A field with a
  // draft shows the draft, so an incoming board update never overwrites typing.
  let drafts = $state<Partial<Record<Field, string>>>({});
  let propsDraft = $state<FlowProp[] | null>(null);
  let focused = $state<Field | null>(null);
  let titleInput: HTMLInputElement | undefined = $state();
  let propsList: HTMLDivElement | undefined = $state();
  let lastSentProps: string | null = null;

  const timers: Partial<Record<Field, ReturnType<typeof setTimeout>>> = {};

  const shown = (field: Field): string => drafts[field] ?? node[field];
  const shownProps = $derived(propsDraft ?? node.props);
  const rejected = $derived(node.status === 'rejected');
  const record = $derived(live.board?.ruledOut.find((r) => r.source.nodeId === node.id));
  const edges = $derived(live.board?.flow.edges ?? []);
  const outgoing = $derived(edges.filter((e) => e.from === node.id));
  const incoming = $derived(edges.filter((e) => e.to === node.id));
  const titleOf = (id: string): string => live.board?.flow.nodes.find((n) => n.id === id)?.title ?? '?';

  onMount(() => () => {
    // Switching cards must not lose a half-debounced edit.
    for (const field of ['title', 'notes'] as const) void flush(field);
    void commitProps();
  });

  $effect(() => {
    if (!focusTitle || !titleInput) return;
    titleInput.focus();
    titleInput.select();
    onfocused();
  });

  async function save(field: Field): Promise<void> {
    const sent = drafts[field];
    if (sent === undefined) return;
    // A card keeps its title: an empty one is simply not sent.
    if (field === 'title' ? sent.trim() : true) await live.send({ type: 'updateNode', id: node.id, [field]: sent });
    if (focused !== field && drafts[field] === sent) delete drafts[field];
  }

  async function flush(field: Field): Promise<void> {
    if (!(field in timers)) return;
    clearTimeout(timers[field]);
    delete timers[field];
    await save(field);
  }

  function type(field: Field, value: string): void {
    drafts[field] = value;
    clearTimeout(timers[field]);
    timers[field] = setTimeout(() => {
      delete timers[field];
      void save(field);
    }, DELAY[field]);
  }

  async function onBlur(field: Field): Promise<void> {
    if (focused === field) focused = null;
    await flush(field);
    // Nothing was waiting to be saved: show the server's value again.
    if (!(field in timers) && drafts[field] !== undefined && focused !== field) delete drafts[field];
  }

  function titleKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter' || event.isComposing) return;
    event.preventDefault();
    (event.currentTarget as HTMLInputElement).blur();
  }

  function editProp(index: number, part: keyof FlowProp, value: string): void {
    propsDraft ??= node.props.map((p) => ({ ...p }));
    propsDraft[index][part] = value;
  }

  async function commitProps(): Promise<void> {
    if (!propsDraft) return;
    const props = propsDraft.filter((p) => p.key.trim() || p.value.trim()).map((p) => ({ key: p.key, value: p.value }));
    const body = JSON.stringify(props);
    if (body === (lastSentProps ?? JSON.stringify(node.props))) return;
    lastSentProps = body;
    await live.send({ type: 'updateNode', id: node.id, props });
  }

  async function leaveProps(event: FocusEvent): Promise<void> {
    if (propsList?.contains(event.relatedTarget as Node | null)) return;
    await commitProps();
    propsDraft = null;
    lastSentProps = null;
  }

  async function removeProp(index: number): Promise<void> {
    propsDraft ??= node.props.map((p) => ({ ...p }));
    propsDraft.splice(index, 1);
    await commitProps();
  }

  async function addProp(): Promise<void> {
    propsDraft ??= node.props.map((p) => ({ ...p }));
    propsDraft.push({ key: '', value: '' });
    await tick();
    propsList?.querySelector<HTMLInputElement>('[data-row]:last-child input')?.focus();
  }

  function setStatus(status: FlowStatus): void {
    if (status === node.status) return;
    if (status === 'rejected') {
      const reason = window.prompt('Why not?');
      if (reason === null) return;
      void live.send({ type: 'ruleOut', target: { kind: 'node', id: node.id }, reason: reason.trim() });
      return;
    }
    void live.send({ type: 'updateNode', id: node.id, status });
  }

  function bringBack(): void {
    if (record) void live.send({ type: 'bringBack', id: record.id });
  }

  const input = 'w-full rounded-md border border-line bg-ink px-2.5 py-1.5';
  const label = 'text-xs font-semibold tracking-wide text-muted uppercase';
</script>

<div class="flex min-h-full flex-col gap-4">
  <div class="flex items-center justify-between text-xs text-muted">
    <span>Added by {whoName(node.author)} · {ago(node.createdAt)}</span>
    <button type="button" class="px-1.5 text-lg leading-none text-muted hover:text-text" title="Close (Esc)" aria-label="Close" onclick={onclose}>×</button>
  </div>

  <div class="flex overflow-hidden rounded-lg border border-line" role="group" aria-label="Status">
    {#each STATUSES as { key, label: name } (key)}
      <button
        type="button"
        aria-pressed={node.status === key}
        disabled={rejected && key !== 'rejected'}
        class="flex-1 border-l border-line py-1.5 first:border-l-0 {node.status === key ? (key === 'accepted' ? 'bg-green-500/25 font-semibold text-green-300' : key === 'rejected' ? 'bg-rose-500/25 font-semibold text-rose-300' : 'bg-raised font-semibold') : 'bg-panel hover:bg-raised'}"
        onclick={() => setStatus(key)}>{name}</button>
    {/each}
  </div>

  {#if rejected && record}
    <div class="flex items-center justify-between gap-3 rounded-md border border-line bg-ink px-3 py-2 text-sm">
      <span class="min-w-0 text-muted">{record.reason ? `Ruled out: ${record.reason}` : 'Ruled out'}</span>
      <button type="button" class="shrink-0 rounded-md border border-line bg-raised px-2.5 py-1 hover:border-muted" onclick={bringBack}>Bring back</button>
    </div>
  {/if}

  <div class="flex flex-col gap-1.5">
    <label class={label} for="node-title">Title</label>
    <input
      id="node-title"
      bind:this={titleInput}
      type="text"
      maxlength="200"
      class="{input} text-base font-semibold"
      value={shown('title')}
      oninput={(e) => type('title', e.currentTarget.value)}
      onkeydown={titleKeydown}
      onfocus={() => (focused = 'title')}
      onblur={() => onBlur('title')}
    />
  </div>

  <div class="flex flex-col gap-1.5">
    <span class={label}>Properties</span>
    <div bind:this={propsList} class="flex flex-col gap-1.5" role="group" aria-label="Properties" onfocusout={leaveProps}>
      {#each shownProps as prop, i (i)}
        <div data-row class="grid grid-cols-[40%_1fr_26px] gap-1.5">
          <input type="text" class="{input} font-semibold" placeholder="name" aria-label="Property name" value={prop.key} oninput={(e) => editProp(i, 'key', e.currentTarget.value)} onchange={commitProps} />
          <input type="text" class={input} placeholder="value" aria-label="Property value" value={prop.value} oninput={(e) => editProp(i, 'value', e.currentTarget.value)} onchange={commitProps} />
          <button type="button" class="text-base text-muted hover:text-rose-400" title="Remove" aria-label="Remove property" onclick={() => removeProp(i)}>×</button>
        </div>
      {/each}
    </div>
    <button type="button" class="self-start rounded-md border border-line px-2.5 py-1 text-sm hover:border-muted" onclick={addProp}>+ Add property</button>
  </div>

  <div class="flex flex-col gap-1.5">
    <label class={label} for="node-notes">Notes</label>
    <textarea
      id="node-notes"
      class="{input} min-h-30 resize-y leading-relaxed"
      placeholder="Details, open questions, examples…"
      value={shown('notes')}
      oninput={(e) => type('notes', e.currentTarget.value)}
      onfocus={() => (focused = 'notes')}
      onblur={() => onBlur('notes')}
    ></textarea>
  </div>

  <div class="flex flex-col gap-1.5">
    <span class={label}>Connections</span>
    {#if outgoing.length || incoming.length}
      <ul class="m-0 flex list-none flex-col gap-1 p-0">
        {#each outgoing as edge (edge.id)}
          <li class="flex items-center gap-1.5">
            <span class="w-3.5 text-muted">→</span>
            <button type="button" class="text-left text-accent hover:underline" onclick={() => ongoto(edge.to)}>{titleOf(edge.to)}</button>
            {#if edge.label}<span class="text-xs text-muted">{edge.label}</span>{/if}
          </li>
        {/each}
        {#each incoming as edge (edge.id)}
          <li class="flex items-center gap-1.5">
            <span class="w-3.5 text-muted">←</span>
            <button type="button" class="text-left text-accent hover:underline" onclick={() => ongoto(edge.from)}>{titleOf(edge.from)}</button>
            {#if edge.label}<span class="text-xs text-muted">{edge.label}</span>{/if}
          </li>
        {/each}
      </ul>
    {:else}
      <span class="text-sm text-muted">None yet. Drag the dot on the card's right edge to another idea.</span>
    {/if}
  </div>

  <div class="mt-auto flex items-center justify-between">
    <span class="text-sm text-muted">Last edit: {whoName(node.updatedBy)} · {ago(node.updatedAt)}</span>
    <button type="button" class="rounded-md border border-line px-2.5 py-1 text-rose-400 hover:border-rose-400" onclick={ondelete}>Delete</button>
  </div>
</div>
