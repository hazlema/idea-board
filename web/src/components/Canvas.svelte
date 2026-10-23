<script lang="ts" module>
  import type { View } from '$lib/geometry';

  const keyOf = (tab: string) => `idea-board-view-${tab}`;

  /** The view last used on this tab, or null if there is none. */
  export function loadView(tab: string): View | null {
    try {
      const value: unknown = JSON.parse(localStorage.getItem(keyOf(tab)) ?? 'null');
      if (value && typeof value === 'object' && 'x' in value && 'y' in value && 'k' in value) {
        const { x, y, k } = value;
        if (typeof x === 'number' && typeof y === 'number' && typeof k === 'number' && k > 0) return { x, y, k };
      }
    } catch {
      // Unreadable or no storage: start from the default view.
    }
    return null;
  }
</script>

<script lang="ts">
  import type { Snippet } from 'svelte';
  import { toWorld, zoomAt, type Point } from '$lib/geometry';

  const GRID = 24;
  const PAN_THRESHOLD = 3;

  interface Props {
    /** Names the tab: the view is remembered under `idea-board-view-<tab>`. */
    tab: string;
    view: View;
    label?: string;
    onBackgroundClick?: () => void;
    onBackgroundDblClick?: (world: Point) => void;
    /** Drawn in world coordinates. Anything that should not start a pan carries `data-nopan`. */
    children?: Snippet;
  }

  let { tab, view = $bindable(), label = 'Canvas', onBackgroundClick, onBackgroundDblClick, children }: Props = $props();

  let element: HTMLDivElement | undefined = $state();
  let panning = $state(false);

  /** The canvas size in pixels. */
  export function size(): { width: number; height: number } {
    const box = element?.getBoundingClientRect();
    return { width: box?.width ?? 0, height: box?.height ?? 0 };
  }

  /** World coordinates of a pointer position on the page. */
  export function worldAt(clientX: number, clientY: number): Point {
    const box = element?.getBoundingClientRect();
    return toWorld(view, clientX - (box?.left ?? 0), clientY - (box?.top ?? 0));
  }

  $effect(() => {
    const { x, y, k } = view;
    try {
      localStorage.setItem(keyOf(tab), JSON.stringify({ x, y, k }));
    } catch {
      // Private mode: the view just won't be remembered.
    }
  });

  // Registered by hand because the page must be able to cancel the browser's own zoom/scroll.
  $effect(() => {
    const el = element;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const box = el.getBoundingClientRect();
      view = zoomAt(view, event.clientX - box.left, event.clientY - box.top, event.deltaY);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  });

  const isItem = (event: Event) => (event.target as Element).closest('[data-nopan]') !== null;

  function onpointerdown(event: PointerEvent): void {
    if (event.button !== 0 || isItem(event) || !element) return;
    const start = { x: event.clientX, y: event.clientY, vx: view.x, vy: view.y };
    let moved = false;
    const el = element;
    el.setPointerCapture?.(event.pointerId);
    panning = true;
    const move = (e: PointerEvent) => {
      if (Math.abs(e.clientX - start.x) + Math.abs(e.clientY - start.y) > PAN_THRESHOLD) moved = true;
      view = { ...view, x: start.vx + e.clientX - start.x, y: start.vy + e.clientY - start.y };
    };
    const end = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', end);
      el.removeEventListener('pointercancel', end);
      panning = false;
      if (!moved) onBackgroundClick?.();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }

  function ondblclick(event: MouseEvent): void {
    if (isItem(event)) return;
    onBackgroundDblClick?.(worldAt(event.clientX, event.clientY));
  }
</script>

<div
  bind:this={element}
  role="application"
  aria-label={label}
  class="relative min-w-0 flex-1 touch-none overflow-hidden bg-ink {panning ? 'cursor-grabbing' : 'cursor-grab'}"
  style:background-image="radial-gradient(var(--color-line) 1px, transparent 1px)"
  style:background-size="{GRID * view.k}px {GRID * view.k}px"
  style:background-position="{view.x}px {view.y}px"
  {onpointerdown}
  {ondblclick}
>
  <div class="absolute top-0 left-0 origin-top-left" style:transform="translate({view.x}px, {view.y}px) scale({view.k})">
    {@render children?.()}
  </div>
</div>
