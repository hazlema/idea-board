<script lang="ts">
  import { onMount } from 'svelte';
  import Canvas, { loadView } from '../components/Canvas.svelte';
  import EdgePanel from '../flow/EdgePanel.svelte';
  import Edges, { type EdgeLine } from '../flow/Edges.svelte';
  import NodeCard from '../flow/NodeCard.svelte';
  import NodePanel from '../flow/NodePanel.svelte';
  import { centerView, curve, fitView, flowAnchors, toWorld, type Point, type Rect, type View } from '$lib/geometry';
  import { live } from '$lib/live.svelte';
  import type { FlowNode } from '$lib/types';

  type Selection = { kind: 'node' | 'edge'; id: string };

  const TAB = 'flowchart';
  const HIDE_KEY = 'idea-board-hide-rejected';
  const DEFAULT_VIEW: View = { x: 80, y: 80, k: 1 };
  const DEFAULT_SIZE = { w: 220, h: 56 };
  const CARD_HALF = { x: 110, y: 28 };
  const DRAG_THRESHOLD = 3;
  const MAX_LABEL = 60;

  const restored = loadView(TAB);
  let view = $state<View>(restored ?? DEFAULT_VIEW);
  let canvas: Canvas | undefined = $state();

  let selected = $state<Selection | null>(null);
  let focusTitle = $state(false);
  let hideRejected = $state(readHideRejected());
  // Cards being dragged, or dropped and not yet confirmed by the board.
  let moved = $state<Record<string, Point>>({});
  let draggingId = $state<string | null>(null);
  let sizes = $state<Record<string, { w: number; h: number }>>({});
  let connecting = $state<{ fromId: string; to: Point; targetId: string | null } | null>(null);
  // Fit once the board has reached this version (and every card is measured). -1 means "as soon as possible".
  let fitAfter = $state<number | null>(restored ? null : -1);
  // A card or arrow just created: it is selected once the board update that holds it arrives.
  let arriving: string | null = null;

  const nodes = $derived(live.board?.flow.nodes ?? []);
  const edges = $derived(live.board?.flow.edges ?? []);
  const shownNodes = $derived(nodes.filter((n) => !(hideRejected && n.status === 'rejected')));
  const shownIds = $derived(new Set(shownNodes.map((n) => n.id)));
  const count = (status: FlowNode['status']): number => nodes.filter((n) => n.status === status).length;
  const selectedNode = $derived(selected?.kind === 'node' ? nodes.find((n) => n.id === selected?.id) : undefined);
  const selectedEdge = $derived(selected?.kind === 'edge' ? edges.find((e) => e.id === selected?.id) : undefined);

  function readHideRejected(): boolean {
    try {
      return localStorage.getItem(HIDE_KEY) === '1';
    } catch {
      return false;
    }
  }

  function setHideRejected(value: boolean): void {
    hideRejected = value;
    try {
      localStorage.setItem(HIDE_KEY, value ? '1' : '0');
    } catch {
      // Private mode: the choice just won't be remembered.
    }
  }

  const positionOf = (node: FlowNode): Point => moved[node.id] ?? node;

  function rectOf(node: FlowNode): Rect {
    return { ...positionOf(node), ...(sizes[node.id] ?? DEFAULT_SIZE) };
  }

  const edgeLines = $derived.by((): EdgeLine[] => {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const lines: EdgeLine[] = [];
    for (const edge of edges) {
      const a = byId.get(edge.from);
      const b = byId.get(edge.to);
      if (!a || !b || !shownIds.has(a.id) || !shownIds.has(b.id)) continue;
      const { s, t, sd, td } = flowAnchors(rectOf(a), rectOf(b));
      const { d, mid } = curve(s, t, sd, td);
      lines.push({ id: edge.id, d, mid, label: edge.label, selected: selected?.kind === 'edge' && selected.id === edge.id });
    }
    return lines;
  });

  const draftPath = $derived.by((): string | null => {
    if (!connecting) return null;
    const from = nodes.find((n) => n.id === connecting?.fromId);
    if (!from) return null;
    const r = rectOf(from);
    const s = { x: r.x + r.w, y: r.y + r.h / 2 };
    const p = connecting.to;
    return curve(s, p, { x: 1, y: 0 }, { x: Math.sign(s.x - p.x) || -1, y: 0 }).d;
  });

  // ---- view ----

  function fit(): void {
    if (!canvas) return;
    const { width, height } = canvas.size();
    const rects = shownNodes.map(rectOf);
    view = rects.length ? fitView(rects, width, height) : DEFAULT_VIEW;
  }

  function centerOn(node: FlowNode): void {
    if (!canvas) return;
    const { width, height } = canvas.size();
    view = centerView(view, rectOf(node), width, height);
  }

  // Waits for the board update (and card sizes) that a Tidy or a first visit needs.
  $effect(() => {
    if (fitAfter === null || !live.board || live.board.version <= fitAfter) return;
    if (!shownNodes.every((n) => sizes[n.id])) return;
    fitAfter = null;
    fit();
  });

  async function tidy(): Promise<void> {
    if (!live.board) return;
    fitAfter = live.board.version;
    if ((await live.send({ type: 'tidy' })) === null) fitAfter = null;
  }

  // ---- selection ----

  function select(next: Selection | null): void {
    arriving = null;
    selected = next;
    focusTitle = false;
    if (next?.kind === 'node') {
      const node = nodes.find((n) => n.id === next.id);
      live.pointing = { kind: 'node', id: next.id, label: (node?.title ?? 'New idea').slice(0, MAX_LABEL) };
    } else if (live.pointing?.kind === 'node') {
      live.pointing = null;
    }
  }

  // A new card or arrow is selected once it is on the board.
  function selectNew(next: Selection): void {
    select(next);
    arriving = next.id;
  }

  // Drop a selection whose card or arrow is gone.
  $effect(() => {
    if (!selected || selectedNode || selectedEdge) {
      if (selected && arriving === selected.id) arriving = null;
      return;
    }
    if (arriving !== selected.id) select(null);
  });

  // Keep the "Talking about" chip in step with the card's title.
  $effect(() => {
    const node = selectedNode;
    if (!node || live.pointing?.kind !== 'node' || live.pointing.id !== node.id) return;
    const label = node.title.slice(0, MAX_LABEL);
    if (live.pointing.label !== label) live.pointing = { kind: 'node', id: node.id, label };
  });

  // A hidden card cannot stay selected.
  $effect(() => {
    if (selectedNode && !shownIds.has(selectedNode.id)) select(null);
  });

  function gotoNode(id: string): void {
    const node = nodes.find((n) => n.id === id);
    if (!node) return;
    if (!shownIds.has(id)) setHideRejected(false);
    select({ kind: 'node', id });
    centerOn(node);
  }

  async function deleteSelected(): Promise<void> {
    if (!selected) return;
    if (selected.kind === 'node') {
      if (!selectedNode || !confirm(`Delete "${selectedNode.title}" and its connections?`)) return;
      if ((await live.send({ type: 'deleteNode', id: selected.id })) === null) return;
    } else if ((await live.send({ type: 'deleteEdge', id: selected.id })) === null) {
      return;
    }
    select(null);
  }

  // ---- adding ----

  async function addNodeAt(x: number, y: number): Promise<void> {
    const result = (await live.send({ type: 'addNode', title: 'New idea', x, y })) as { node?: FlowNode } | null;
    if (!result?.node) return;
    selectNew({ kind: 'node', id: result.node.id });
    focusTitle = true;
  }

  function addInMiddle(): void {
    if (!canvas) return;
    const { width, height } = canvas.size();
    const middle = toWorld(view, width / 2, height / 2);
    void addNodeAt(middle.x - CARD_HALF.x + (Math.random() * 40 - 20), middle.y - CARD_HALF.y + (Math.random() * 40 - 20));
  }

  // ---- cards ----

  function startMove(event: PointerEvent, node: FlowNode): void {
    if (event.button !== 0 || !canvas) return;
    const surface = canvas;
    select({ kind: 'node', id: node.id });
    const el = event.currentTarget as HTMLElement;
    const start = surface.worldAt(event.clientX, event.clientY);
    const origin = { x: positionOf(node).x, y: positionOf(node).y };
    let dragged = false;
    el.setPointerCapture?.(event.pointerId);

    const move = (e: PointerEvent) => {
      const p = surface.worldAt(e.clientX, e.clientY);
      const x = Math.round(origin.x + p.x - start.x);
      const y = Math.round(origin.y + p.y - start.y);
      if (!dragged && Math.abs(x - origin.x) + Math.abs(y - origin.y) < DRAG_THRESHOLD) return;
      dragged = true;
      draggingId = node.id;
      moved[node.id] = { x, y };
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      draggingId = null;
      const to = moved[node.id];
      if (!dragged || !to) return;
      void live.send({ type: 'updateNode', id: node.id, x: to.x, y: to.y }).then((result) => {
        if (result === null) delete moved[node.id];
      });
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  // A dropped card is drawn where the user left it until the board says the same.
  $effect(() => {
    for (const [id, to] of Object.entries(moved)) {
      if (id === draggingId) continue;
      const node = nodes.find((n) => n.id === id);
      if (!node || (node.x === to.x && node.y === to.y)) delete moved[id];
    }
  });

  function startConnect(event: PointerEvent, from: FlowNode): void {
    if (event.button !== 0 || !canvas) return;
    event.preventDefault();
    const surface = canvas;
    const el = (event.currentTarget as HTMLElement).closest<HTMLElement>('[data-node-id]');
    if (!el) return;
    el.setPointerCapture?.(event.pointerId);
    connecting = { fromId: from.id, to: surface.worldAt(event.clientX, event.clientY), targetId: null };

    const move = (e: PointerEvent) => {
      const hovered = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('[data-node-id]');
      const targetId = hovered && hovered.dataset.nodeId !== from.id ? (hovered.dataset.nodeId ?? null) : null;
      connecting = { fromId: from.id, to: surface.worldAt(e.clientX, e.clientY), targetId };
    };
    const up = async () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      const targetId = connecting?.targetId;
      connecting = null;
      if (!targetId) return;
      const result = (await live.send({ type: 'addEdge', from: from.id, to: targetId })) as { edge?: { id: string } } | null;
      if (result?.edge) selectNew({ kind: 'edge', id: result.edge.id });
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  async function toggleAccepted(node: FlowNode, accepted: boolean): Promise<void> {
    await live.send({ type: 'updateNode', id: node.id, status: accepted ? 'accepted' : 'idea' });
  }

  // ---- keys ----

  onMount(() => {
    // Leaving the tab drops the chip for a card that is no longer on screen.
    return () => {
      if (live.pointing?.kind === 'node') live.pointing = null;
    };
  });

  function onkeydown(event: KeyboardEvent): void {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target instanceof HTMLElement ? event.target : null;
    const typing = target?.closest('input, textarea, select, [contenteditable]');
    if (event.key === 'Escape') {
      if (typing) target?.blur();
      else select(null);
      return;
    }
    if (typing) return;
    if ((event.key === 'Delete' || event.key === 'Backspace') && selected) {
      event.preventDefault();
      void deleteSelected();
    } else if (event.key === 'f' || event.key === 'F') {
      fit();
    }
  }

  const button = 'rounded-md border border-line bg-raised px-2.5 py-1 hover:border-muted';
</script>

<svelte:window {onkeydown} />

<div class="flex min-h-0 min-w-0 flex-1">
  <div class="relative flex min-w-0 flex-1">
    <Canvas
      bind:this={canvas}
      tab={TAB}
      label="Flowchart"
      bind:view
      onBackgroundClick={() => select(null)}
      onBackgroundDblClick={(p) => void addNodeAt(p.x - CARD_HALF.x, p.y - CARD_HALF.y)}
    >
      <Edges edges={edgeLines} draft={draftPath} onselect={(id) => select({ kind: 'edge', id })} />
      {#each shownNodes as node (node.id)}
        <NodeCard
          {node}
          x={positionOf(node).x}
          y={positionOf(node).y}
          selected={selected?.kind === 'node' && selected.id === node.id}
          flashing={live.flash.has(node.id)}
          connectTarget={connecting?.targetId === node.id}
          dragging={draggingId === node.id}
          onmovestart={(e) => startMove(e, node)}
          onconnectstart={(e) => startConnect(e, node)}
          ontoggle={(accepted) => toggleAccepted(node, accepted)}
          onopen={() => {
            select({ kind: 'node', id: node.id });
            focusTitle = true;
          }}
          onsize={(w, h) => {
            const known = sizes[node.id];
            if (!known || known.w !== w || known.h !== h) sizes[node.id] = { w, h };
          }}
        />
      {/each}
    </Canvas>

    <div class="absolute top-3 left-3 z-10 flex items-center gap-2.5 rounded-lg border border-line bg-panel/90 px-2.5 py-1.5 backdrop-blur">
      <button type="button" class="rounded-md bg-accent px-2.5 py-1 font-medium text-ink hover:brightness-110" title="Add an idea (or double-click the board)" onclick={addInMiddle}>+ Idea</button>
      <button type="button" class={button} title="Arrange cards left to right by how they connect" onclick={tidy}>Tidy</button>
      <button type="button" class={button} title="Fit everything on screen (F)" onclick={fit}>Fit</button>
      <label class="flex items-center gap-1.5 text-muted select-none">
        <input type="checkbox" checked={hideRejected} onchange={(e) => setHideRejected(e.currentTarget.checked)} /> Hide rejected
      </label>
      <span class="text-xs text-muted"><b class="font-semibold text-text">{count('idea')}</b> ideas · <b class="font-semibold text-text">{count('accepted')}</b> accepted · <b class="font-semibold text-text">{count('rejected')}</b> rejected</span>
    </div>

    {#if nodes.length === 0}
      <div class="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-1.5 text-center text-muted">
        <strong class="text-base text-text">Empty board</strong>
        <span>Double-click anywhere to add an idea, or ask Claude in the chat below.</span>
      </div>
    {/if}
  </div>

  {#if selectedNode || selectedEdge}
    <aside class="w-[360px] shrink-0 overflow-y-auto border-l border-line bg-panel px-4 py-4" aria-label={selectedNode ? 'Card details' : 'Connection details'}>
      {#if selectedNode}
        {#key selectedNode.id}
          <NodePanel
            node={selectedNode}
            {focusTitle}
            onfocused={() => (focusTitle = false)}
            onclose={() => select(null)}
            ondelete={deleteSelected}
            ongoto={gotoNode}
          />
        {/key}
      {:else if selectedEdge}
        {#key selectedEdge.id}
          <EdgePanel edge={selectedEdge} onclose={() => select(null)} ondelete={deleteSelected} ongoto={gotoNode} />
        {/key}
      {/if}
    </aside>
  {/if}
</div>
