<script lang="ts">
  import { onMount } from 'svelte';
  import type { ActionReturn } from 'svelte/action';
  import Canvas, { loadView } from '../components/Canvas.svelte';
  import ClaudeMark from '../brainstorm/ClaudeMark.svelte';
  import GroupBox from '../brainstorm/GroupBox.svelte';
  import Links, { type LinkLine } from '../brainstorm/Links.svelte';
  import NoteBox from '../brainstorm/NoteBox.svelte';
  import Palette, { type NewKind } from '../brainstorm/Palette.svelte';
  import PictureBox, { attachPreview } from '../brainstorm/PictureBox.svelte';
  import TopicBubble from '../brainstorm/TopicBubble.svelte';
  import type { DragOptions, ResizeOptions } from '$lib/actions';
  import * as api from '$lib/api';
  import { firstLine } from '$lib/format';
  import { freeSpot, linkPath, toWorld, type Point, type Rect, type View } from '$lib/geometry';
  import { live } from '$lib/live.svelte';
  import { pastedImage, pastedUrl } from '$lib/pictures';
  import { objectLabel, type Board, type BObject, type Group } from '$lib/types';

  type Size = { w: number; h: number };
  type Selection = { kind: 'object' | 'link'; id: string };

  const TAB = 'brainstorm';
  const MAIN_PAGE = 'p_main';
  const DEFAULT_VIEW: View = { x: 80, y: 80, k: 1 };
  const MIN: Record<'group' | 'note' | 'picture', Size> = { group: { w: 220, h: 80 }, note: { w: 160, h: 80 }, picture: { w: 120, h: 80 } };
  // Roughly how big a new object is, to place it in the view.
  const NEW_SIZE: Record<BObject['kind'], Size> = { group: { w: 320, h: 120 }, note: { w: 220, h: 140 }, topic: { w: 130, h: 48 }, picture: { w: 240, h: 220 } };
  // Stand-in size for links until a box has been measured.
  const UNMEASURED = 160;
  const UNTITLED: Record<BObject['kind'], string> = { group: 'Untitled group', note: 'Note', picture: 'picture', topic: 'Topic' };
  const PICTURE_TYPES = 'image/png,image/jpeg,image/gif,image/webp';

  interface Props {
    /** A board to show instead of the live one: the view is then read-only (a saved version's preview). */
    board?: Board;
  }

  let { board }: Props = $props();

  // A preview keeps its own remembered view, but starts where the live tab is.
  const readonly = $derived(board !== undefined);
  const tab = $derived(readonly ? `${TAB}-preview` : TAB);

  let view = $state<View>(loadView(TAB) ?? DEFAULT_VIEW);
  let canvas: Canvas | undefined = $state();
  let filePicker: HTMLInputElement | undefined = $state();

  let selected = $state<Selection | null>(null);
  // Boxes being dragged or resized, or dropped and not yet confirmed by the board.
  let moved = $state<Record<string, Point>>({});
  let sized = $state<Record<string, Size>>({});
  let active = $state<string | null>(null);
  let measured = $state<Record<string, Size>>({});
  let linking = $state<{ from: string | null } | null>(null);
  let focusNew = $state<string | null>(null);
  // Something just created: it is selected once the board update that holds it arrives.
  let arriving: string | null = null;
  // Spots given to new objects that the board does not show yet, so two at once don't overlap.
  let reserved: Rect[] = [];

  const shownBoard = $derived(board ?? live.board);
  const page = $derived(shownBoard?.brainstorm.pages.find((p) => p.id === MAIN_PAGE) ?? shownBoard?.brainstorm.pages[0]);
  const objects = $derived(page?.objects ?? []);
  const links = $derived(page?.links ?? []);
  const selectedObject = $derived(selected?.kind === 'object' ? objects.find((o) => o.id === selected?.id) : undefined);
  const selectedLink = $derived(selected?.kind === 'link' ? links.find((l) => l.id === selected?.id) : undefined);

  const positionOf = (o: BObject): Point => moved[o.id] ?? { x: o.x, y: o.y };
  const sizeOf = (o: BObject): Size => sized[o.id] ?? { w: o.w, h: o.h };

  function rectOf(o: BObject): Rect {
    const size = sizeOf(o);
    const seen = measured[o.id];
    return { ...positionOf(o), w: seen?.w ?? (size.w || UNMEASURED), h: seen?.h ?? (size.h || UNMEASURED / 2) };
  }

  const lines = $derived.by((): LinkLine[] => {
    const byId = new Map(objects.map((o) => [o.id, o]));
    const out: LinkLine[] = [];
    for (const link of links) {
      const a = byId.get(link.from);
      const b = byId.get(link.to);
      if (!a || !b) continue;
      const { d, mid } = linkPath(rectOf(a), rectOf(b));
      out.push({ id: link.id, d, mid, label: link.label, dashed: link.dashed });
    }
    return out;
  });

  /** Records a box's rendered size, which the links use. */
  function measure(node: HTMLElement, id: string): ActionReturn<string> {
    let current = id;
    const observer = new ResizeObserver(() => {
      const size = { w: node.offsetWidth, h: node.offsetHeight };
      const known = measured[current];
      if (!known || known.w !== size.w || known.h !== size.h) measured[current] = size;
    });
    observer.observe(node);
    return {
      update: (next) => (current = next),
      destroy: () => {
        observer.disconnect();
        delete measured[current];
      },
    };
  }

  // ---- pointing and selection ----

  function labelOf(o: BObject): string {
    return firstLine(objectLabel(o)) || UNTITLED[o.kind];
  }

  function point(o: BObject): void {
    live.pointing = { kind: 'object', id: o.id, label: labelOf(o) };
  }

  const isBrainstormPointer = () => live.pointing?.kind === 'object' || live.pointing?.kind === 'entry';

  function select(next: Selection | null): void {
    if (readonly) return;
    arriving = null;
    selected = next;
  }

  function selectNew(next: Selection): void {
    select(next);
    arriving = next.id;
  }

  function clearSelection(): void {
    select(null);
    linking = null;
    if (isBrainstormPointer()) live.pointing = null;
  }

  // Drop a selection whose object or link is gone. Something just created is
  // what the user is about to talk about: point chat at it once it is there.
  $effect(() => {
    if (!selected || selectedObject || selectedLink) {
      if (selected && arriving === selected.id) {
        arriving = null;
        if (selectedObject) point(selectedObject);
      }
      return;
    }
    if (arriving !== selected.id) select(null);
  });

  // Keep the "Talking about" chip in step with the board: renamed, moved to another group, or gone.
  $effect(() => {
    const p = live.pointing;
    if (readonly || !p || !live.board) return;
    if (p.kind === 'object') {
      const o = objects.find((x) => x.id === p.id);
      if (!o) live.pointing = null;
      else if (p.label !== labelOf(o)) live.pointing = { ...p, label: labelOf(o) };
    } else if (p.kind === 'entry') {
      const group = objects.find((x): x is Group => x.kind === 'group' && x.entries.some((e) => e.id === p.id));
      const entry = group?.entries.find((e) => e.id === p.id);
      if (!group || !entry || entry.ruledOut) live.pointing = null;
      else if (p.groupId !== group.id) live.pointing = { ...p, groupId: group.id };
    }
  });

  function pick(event: PointerEvent, o: BObject): void {
    if (readonly || event.button !== 0) return;
    if (linking) {
      event.preventDefault();
      linkWith(o);
      return;
    }
    select({ kind: 'object', id: o.id });
    // A press on an entry points at the entry (the row does that itself).
    if (!(event.target as Element).closest('[data-entry-id]')) point(o);
  }

  // ---- adding ----

  /**
   * Where a new object goes: centred in the view (or with its corner at
   * `corner`) if that spot is free, else the nearest free spot. The spot is
   * held until `release` is called with it.
   */
  function place(size: Size, corner?: Point): Rect {
    let want = corner;
    if (!want) {
      const { width, height } = canvas?.size() ?? { width: 0, height: 0 };
      const middle = toWorld(view, width / 2, height / 2);
      want = { x: middle.x - size.w / 2, y: middle.y - size.h / 2 };
    }
    const spot = freeSpot({ x: Math.round(want.x), y: Math.round(want.y), ...size }, [...objects.map(rectOf), ...reserved]);
    const rect = { ...spot, ...size };
    reserved = [...reserved, rect];
    return rect;
  }

  function release(rect: Rect): void {
    reserved = reserved.filter((r) => r !== rect);
  }

  async function addObject(kind: NewKind): Promise<void> {
    const body = kind === 'group' ? { title: 'New group' } : kind === 'topic' ? { text: 'New topic' } : { text: '' };
    const spot = place(NEW_SIZE[kind]);
    const result = (await live.send({ type: 'addObject', kind, x: spot.x, y: spot.y, ...body })) as { object?: BObject } | null;
    release(spot);
    if (!result?.object) return;
    selectNew({ kind: 'object', id: result.object.id });
    focusNew = result.object.id;
  }

  /** Adds a picture; `at` is where the user dropped it (else it goes in the middle of the view). */
  async function addPicture(source: Blob | string, at?: Point): Promise<void> {
    let asset: string;
    try {
      asset = typeof source === 'string' ? await api.ingestUrl(source) : await api.uploadPicture(source);
    } catch (error) {
      live.toast(error instanceof Error ? error.message : 'Could not add the picture');
      return;
    }
    const spot = place(NEW_SIZE.picture, at);
    const result = (await live.send({ type: 'addObject', kind: 'picture', asset, x: spot.x, y: spot.y })) as { object?: BObject } | null;
    release(spot);
    if (!result?.object) return;
    selectNew({ kind: 'object', id: result.object.id });
    // A pasted or dropped file is at hand; a picture from a URL gets its preview when it first shows.
    if (typeof source !== 'string') void attachPreview(result.object.id, source);
  }

  function pickedFiles(event: Event & { currentTarget: HTMLInputElement }): void {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = '';
    for (const file of files) void addPicture(file);
  }

  const typingIn = (target: EventTarget | null): boolean =>
    target instanceof Element && target.closest('input, textarea, select, [contenteditable]') !== null;

  function onpaste(event: ClipboardEvent): void {
    if (readonly || typingIn(event.target)) return;
    const file = pastedImage(event);
    const url = file ? null : pastedUrl(event);
    if (!file && !url) return;
    event.preventDefault();
    void addPicture(file ?? (url as string));
  }

  function ondragover(event: DragEvent): void {
    if (readonly || !event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }

  function ondrop(event: DragEvent): void {
    if (readonly || !event.dataTransfer?.types.includes('Files') || !canvas) return;
    event.preventDefault();
    const files = Array.from(event.dataTransfer.files).filter((f) => f.type.startsWith('image/'));
    if (!files.length) {
      live.toast('Only pictures can be dropped here (PNG, JPEG, GIF or WebP)');
      return;
    }
    const at = canvas.worldAt(event.clientX, event.clientY);
    for (const file of files) void addPicture(file, at);
  }

  // ---- linking ----

  function startLinking(): void {
    linking = linking ? null : { from: null };
  }

  async function linkWith(o: BObject): Promise<void> {
    if (!linking) return;
    if (!linking.from) {
      linking = { from: o.id };
      return;
    }
    if (linking.from === o.id) return;
    const from = linking.from;
    linking = null;
    const result = (await live.send({ type: 'addLink', from, to: o.id })) as { link?: { id: string } } | null;
    if (result?.link) selectNew({ kind: 'link', id: result.link.id });
  }

  // ---- moving, resizing, deleting ----

  function dragFor(o: BObject): DragOptions {
    return {
      getStart: () => positionOf(o),
      scale: () => view.k,
      onMove: (x, y) => {
        active = o.id;
        moved[o.id] = { x, y };
      },
      onEnd: (x, y) => {
        active = null;
        moved[o.id] = { x, y };
        void live.send({ type: 'moveObject', id: o.id, x, y }).then((result) => {
          if (result === null) delete moved[o.id];
        });
      },
    };
  }

  /** How tall a box is with no minimum height: what its content needs. */
  function naturalHeight(id: string): number {
    const el = document.querySelector<HTMLElement>(`[data-object-id="${CSS.escape(id)}"]`);
    if (!el) return 0;
    const minHeight = el.style.minHeight;
    el.style.minHeight = '';
    const h = el.offsetHeight;
    el.style.minHeight = minHeight;
    return h;
  }

  function resizeFor(o: BObject, min: Size): ResizeOptions {
    return {
      min,
      scale: () => view.k,
      natural: () => naturalHeight(o.id),
      onMove: (w, h) => {
        active = o.id;
        sized[o.id] = { w, h };
      },
      onEnd: (w, h) => {
        active = null;
        sized[o.id] = { w, h };
        void live.send({ type: 'moveObject', id: o.id, w, h }).then((result) => {
          if (result === null) delete sized[o.id];
        });
      },
    };
  }

  // A dropped or resized box is drawn where the user left it until the board says the same.
  $effect(() => {
    for (const [id, to] of Object.entries(moved)) {
      if (id === active) continue;
      const o = objects.find((x) => x.id === id);
      if (!o || (o.x === to.x && o.y === to.y)) delete moved[id];
    }
    for (const [id, to] of Object.entries(sized)) {
      if (id === active) continue;
      const o = objects.find((x) => x.id === id);
      if (!o || (o.w === to.w && o.h === to.h)) delete sized[id];
    }
  });

  function hasContent(o: BObject): boolean {
    if (o.kind === 'group') return o.title.trim() !== '' || o.entries.length > 0;
    if (o.kind === 'picture') return true;
    return o.text.trim() !== '';
  }

  function unpoint(o: BObject): void {
    const p = live.pointing;
    if (p && (p.id === o.id || (p.kind === 'entry' && p.groupId === o.id))) live.pointing = null;
  }

  async function removeObject(o: BObject): Promise<void> {
    if (hasContent(o)) {
      const items = o.kind === 'group' && o.entries.length ? ` and its ${o.entries.length} item${o.entries.length > 1 ? 's' : ''}` : '';
      if (!confirm(`Delete "${labelOf(o)}"${items}?`)) return;
    }
    unpoint(o);
    if (selected?.id === o.id) select(null);
    await live.send({ type: 'deleteObject', id: o.id });
  }

  function dismissObject(o: BObject, reason: string): void {
    unpoint(o);
    if (selected?.id === o.id) select(null);
    void live.send({ type: 'ruleOut', target: { kind: 'object', id: o.id }, reason });
  }

  function removeLink(id: string): void {
    if (selected?.id === id) select(null);
    void live.send({ type: 'deleteLink', id });
  }

  // ---- keys ----

  onMount(() => () => {
    // Leaving the tab drops the chip for something that is no longer on screen.
    if (!readonly && isBrainstormPointer()) live.pointing = null;
  });

  function onkeydown(event: KeyboardEvent): void {
    if (readonly || event.ctrlKey || event.metaKey || event.altKey) return;
    const typing = typingIn(event.target);
    if (event.key === 'Escape') {
      if (typing) (event.target as HTMLElement).blur();
      else clearSelection();
      return;
    }
    if (typing || (event.key !== 'Delete' && event.key !== 'Backspace')) return;
    if (selectedLink) {
      event.preventDefault();
      removeLink(selectedLink.id);
    } else if (selectedObject) {
      event.preventDefault();
      void removeObject(selectedObject);
    }
  }

  const outline = (o: BObject): string => (o.kind === 'topic' ? 'rounded-full' : 'rounded-xl');
</script>

<svelte:window {onkeydown} {onpaste} />

<div class="relative flex min-w-0 flex-1" role="region" aria-label="Brainstorm" {ondragover} {ondrop}>
  <Canvas bind:this={canvas} {tab} label="Brainstorm canvas" bind:view onBackgroundClick={clearSelection}>
    <Links {lines} selected={selectedLink} onselect={(id) => select({ kind: 'link', id })} ondelete={removeLink} />
    {#each objects as o (o.id)}
      {@const pos = positionOf(o)}
      {@const size = sizeOf(o)}
      {@const isSelected = selected?.kind === 'object' && selected.id === o.id}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        data-nopan
        data-object-id={o.id}
        inert={readonly}
        class="absolute isolate flex flex-col {outline(o)} {isSelected ? 'outline-2 outline-offset-2 outline-accent' : ''} {linking?.from === o.id ? 'outline-2 outline-offset-2 outline-dashed outline-accent' : ''} {active === o.id ? 'z-20' : isSelected ? 'z-10' : ''} {live.flash.has(o.id) ? 'flash-claude' : ''} {linking ? 'cursor-crosshair' : ''}"
        style:left="{pos.x}px"
        style:top="{pos.y}px"
        style:width={size.w ? `${size.w}px` : undefined}
        style:min-height={size.h ? `${size.h}px` : undefined}
        use:measure={o.id}
        onpointerdown={(e) => pick(e, o)}
      >
        {#if o.kind === 'group'}
          <GroupBox
            group={o}
            drag={dragFor(o)}
            resize={resizeFor(o, MIN.group)}
            autofocus={focusNew === o.id}
            onfocused={() => (focusNew = null)}
            ondelete={() => void removeObject(o)}
          />
        {:else if o.kind === 'note'}
          <NoteBox note={o} drag={dragFor(o)} resize={resizeFor(o, MIN.note)} autofocus={focusNew === o.id} onfocused={() => (focusNew = null)} />
        {:else if o.kind === 'picture'}
          <PictureBox picture={o} drag={dragFor(o)} resize={resizeFor(o, MIN.picture)} {readonly} />
        {:else}
          <TopicBubble topic={o} drag={dragFor(o)} autofocus={focusNew === o.id} onfocused={() => (focusNew = null)} />
        {/if}
        {#if o.claudeAdded}
          <ClaudeMark variant="object" onkeep={() => void live.send({ type: 'keep', id: o.id })} ondismiss={(reason) => dismissObject(o, reason)} />
        {/if}
      </div>
    {/each}
  </Canvas>

  {#if !readonly}
    <Palette linking={linking ? (linking.from ? 'to' : 'from') : null} onadd={(kind) => void addObject(kind)} onpicture={() => filePicker?.click()} onlink={startLinking} />
    <input bind:this={filePicker} type="file" accept={PICTURE_TYPES} multiple class="hidden" aria-label="Choose pictures" onchange={pickedFiles} />
  {/if}

  {#if objects.length === 0}
    <div class="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-1.5 text-center text-muted">
      <strong class="text-base text-text">Empty canvas</strong>
      <span>{readonly ? 'Nothing on the canvas in this version.' : 'Add a group, note or topic from the palette, paste or drop a picture, or ask Claude in the chat below.'}</span>
    </div>
  {/if}
</div>
