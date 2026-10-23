// Dragging and resizing boxes on a zoomable canvas. Positions and sizes are in
// world units: pointer travel is divided by the canvas zoom.
import type { ActionReturn } from 'svelte/action';
import type { Point } from './geometry';

const THRESHOLD = 3;
// Pointer presses on these keep their normal meaning (typing, clicking); a
// resize grip inside a draggable box carries data-no-drag.
const INTERACTIVE = 'input, textarea, select, button, [contenteditable], [data-no-drag]';

export interface DragOptions {
  /** Where the box is when the drag starts. */
  getStart: () => Point;
  /** The canvas zoom. */
  scale: () => number;
  onMove: (x: number, y: number) => void;
  /** Called on release, only if the box actually moved. */
  onEnd: (x: number, y: number) => void;
}

export interface ResizeOptions {
  min: { w: number; h: number };
  scale: () => number;
  /** Live size while the grip is held. */
  onMove?: (w: number, h: number) => void;
  /** Called on release, only if the size changed. */
  onEnd: (w: number, h: number) => void;
}

type Gesture = (dx: number, dy: number) => void;

/** Follows one pointer from press to release, reporting travel in screen pixels. */
function follow(node: HTMLElement, event: PointerEvent, onMove: Gesture, onEnd: Gesture): void {
  const sx = event.clientX;
  const sy = event.clientY;
  let moved = false;
  node.setPointerCapture?.(event.pointerId);
  const move = (e: PointerEvent) => {
    const dx = e.clientX - sx;
    const dy = e.clientY - sy;
    if (!moved && Math.abs(dx) + Math.abs(dy) < THRESHOLD) return;
    moved = true;
    onMove(dx, dy);
  };
  const end = (e: PointerEvent) => {
    node.removeEventListener('pointermove', move);
    node.removeEventListener('pointerup', end);
    node.removeEventListener('pointercancel', end);
    if (moved) onEnd(e.clientX - sx, e.clientY - sy);
  };
  node.addEventListener('pointermove', move);
  node.addEventListener('pointerup', end);
  node.addEventListener('pointercancel', end);
}

/** Moves a box by dragging `node` (a title bar or grip). */
export function drag(node: HTMLElement, options: DragOptions | undefined): ActionReturn<DragOptions | undefined> {
  let current = options;
  const down = (event: PointerEvent) => {
    if (!current || event.button !== 0 || (event.target as Element).closest(INTERACTIVE)) return;
    const { onMove, onEnd } = current;
    const start = current.getStart();
    const k = current.scale();
    const at = (dx: number, dy: number): Point => ({ x: Math.round(start.x + dx / k), y: Math.round(start.y + dy / k) });
    follow(
      node,
      event,
      (dx, dy) => {
        const p = at(dx, dy);
        onMove(p.x, p.y);
      },
      (dx, dy) => {
        const p = at(dx, dy);
        onEnd(p.x, p.y);
      },
    );
  };
  node.addEventListener('pointerdown', down);
  return {
    update: (next) => (current = next),
    destroy: () => node.removeEventListener('pointerdown', down),
  };
}

/** Resizes the box that holds `node` (a bottom-right grip). */
export function resize(node: HTMLElement, options: ResizeOptions | undefined): ActionReturn<ResizeOptions | undefined> {
  let current = options;
  const down = (event: PointerEvent) => {
    if (!current || event.button !== 0) return;
    const { min, onMove, onEnd } = current;
    const box = node.parentElement;
    const start = { w: box?.offsetWidth ?? 0, h: box?.offsetHeight ?? 0 };
    const k = current.scale();
    const size = (dx: number, dy: number) => ({
      w: Math.max(min.w, Math.round(start.w + dx / k)),
      h: Math.max(min.h, Math.round(start.h + dy / k)),
    });
    follow(
      node,
      event,
      (dx, dy) => {
        const s = size(dx, dy);
        onMove?.(s.w, s.h);
      },
      (dx, dy) => {
        const s = size(dx, dy);
        onEnd(s.w, s.h);
      },
    );
  };
  node.addEventListener('pointerdown', down);
  return {
    update: (next) => (current = next),
    destroy: () => node.removeEventListener('pointerdown', down),
  };
}

/** Grows a textarea to fit its text, so a box never shows an inner scrollbar. Pass the value so it refits as it changes. */
export function autogrow(node: HTMLTextAreaElement, _value: string): ActionReturn<string> {
  let width = -1;
  const fit = () => {
    node.style.height = 'auto';
    node.style.height = `${node.scrollHeight}px`;
  };
  // A narrower box wraps the text onto more lines.
  const observer = new ResizeObserver(() => {
    if (node.offsetWidth === width) return;
    width = node.offsetWidth;
    fit();
  });
  observer.observe(node);
  fit();
  return { update: fit, destroy: () => observer.disconnect() };
}

/** Calls `onclose` on a press outside `node` or on Escape (for small menus). */
export function outside(node: HTMLElement, onclose: () => void): ActionReturn<() => void> {
  let close = onclose;
  const press = (event: PointerEvent) => {
    if (!node.contains(event.target as Node)) close();
  };
  const key = (event: KeyboardEvent) => {
    if (event.key === 'Escape') close();
  };
  // Capture, so a press that a box stops from bubbling still closes the menu.
  window.addEventListener('pointerdown', press, true);
  window.addEventListener('keydown', key);
  return {
    update: (next) => (close = next),
    destroy: () => {
      window.removeEventListener('pointerdown', press, true);
      window.removeEventListener('keydown', key);
    },
  };
}
