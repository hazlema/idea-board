// Pan/zoom maths and the curves drawn between boxes. Pure functions; the
// views own the state.

export type View = { x: number; y: number; k: number };
export type Rect = { x: number; y: number; w: number; h: number };
export type Point = { x: number; y: number };
export type Curve = { d: string; mid: Point };

export const MIN_ZOOM = 0.2;
export const MAX_ZOOM = 2.5;
const MAX_FIT_ZOOM = 1.25;
const ZOOM_SPEED = 0.0015;

/** Screen coordinates (relative to the canvas) to world coordinates. */
export function toWorld(view: View, sx: number, sy: number): Point {
  return { x: (sx - view.x) / view.k, y: (sy - view.y) / view.k };
}

/** Zooms by a wheel delta, keeping the world point under (sx, sy) where it is. */
export function zoomAt(view: View, sx: number, sy: number, deltaY: number): View {
  const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.k * Math.exp(-deltaY * ZOOM_SPEED)));
  return { k, x: sx - ((sx - view.x) * k) / view.k, y: sy - ((sy - view.y) * k) / view.k };
}

/** A view that shows all rects, centred, with `pad` pixels of margin. */
export function fitView(rects: Rect[], width: number, height: number, pad = 60): View {
  const minX = Math.min(...rects.map((r) => r.x));
  const minY = Math.min(...rects.map((r) => r.y));
  const maxX = Math.max(...rects.map((r) => r.x + r.w));
  const maxY = Math.max(...rects.map((r) => r.y + r.h));
  const fitK = Math.min((width - pad * 2) / (maxX - minX), (height - pad * 2) / (maxY - minY));
  const k = Math.min(MAX_FIT_ZOOM, Math.max(MIN_ZOOM, fitK));
  return { k, x: (width - (maxX - minX) * k) / 2 - minX * k, y: (height - (maxY - minY) * k) / 2 - minY * k };
}

/** A view that puts the middle of `rect` at the middle of the canvas. */
export function centerView(view: View, rect: Rect, width: number, height: number): View {
  return { k: view.k, x: width / 2 - (rect.x + rect.w / 2) * view.k, y: height / 2 - (rect.y + rect.h / 2) * view.k };
}

export type FlowAnchors = { s: Point; t: Point; sd: Point; td: Point };

/** Where an arrow leaves `a` and enters `b`, and which way it heads at each end. */
export function flowAnchors(a: Rect, b: Rect): FlowAnchors {
  const ac = { x: a.x + a.w / 2, y: a.y + a.h / 2 };
  const bc = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  const dx = bc.x - ac.x;
  const dy = bc.y - ac.y;
  if (Math.abs(dx) * 0.6 >= Math.abs(dy)) {
    const dir = dx >= 0 ? 1 : -1;
    return {
      s: { x: dir > 0 ? a.x + a.w : a.x, y: ac.y },
      t: { x: dir > 0 ? b.x : b.x + b.w, y: bc.y },
      sd: { x: dir, y: 0 },
      td: { x: -dir, y: 0 },
    };
  }
  const dir = dy >= 0 ? 1 : -1;
  return {
    s: { x: ac.x, y: dir > 0 ? a.y + a.h : a.y },
    t: { x: bc.x, y: dir > 0 ? b.y : b.y + b.h },
    sd: { x: 0, y: dir },
    td: { x: 0, y: -dir },
  };
}

/** A cubic from s to t leaving along sd and arriving against td, plus its midpoint. */
export function curve(s: Point, t: Point, sd: Point, td: Point): Curve {
  const d = Math.max(40, Math.hypot(t.x - s.x, t.y - s.y) / 2.5);
  const c1 = { x: s.x + sd.x * d, y: s.y + sd.y * d };
  const c2 = { x: t.x + td.x * d, y: t.y + td.y * d };
  const mid = { x: (s.x + 3 * c1.x + 3 * c2.x + t.x) / 8, y: (s.y + 3 * c1.y + 3 * c2.y + t.y) / 8 };
  return { d: `M${s.x},${s.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${t.x},${t.y}`, mid };
}

const BEND = 0.12;

/** Where a line from the centre of `r` towards `p` crosses the border of `r`. */
function borderToward(r: Rect, p: Point): Point {
  const c = { x: r.x + r.w / 2, y: r.y + r.h / 2 };
  const dx = p.x - c.x;
  const dy = p.y - c.y;
  if (dx === 0 && dy === 0) return c;
  const scale = Math.min(dx === 0 ? Infinity : r.w / 2 / Math.abs(dx), dy === 0 ? Infinity : r.h / 2 / Math.abs(dy));
  return { x: c.x + dx * scale, y: c.y + dy * scale };
}

/** A gently bent quadratic from the border of `a` to the border of `b`, plus its midpoint. */
export function linkPath(a: Rect, b: Rect): Curve {
  const ac = { x: a.x + a.w / 2, y: a.y + a.h / 2 };
  const bc = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  const dx = bc.x - ac.x;
  const dy = bc.y - ac.y;
  const control = { x: (ac.x + bc.x) / 2 - dy * BEND, y: (ac.y + bc.y) / 2 + dx * BEND };
  const s = borderToward(a, control);
  const t = borderToward(b, control);
  const mid = { x: (s.x + 2 * control.x + t.x) / 4, y: (s.y + 2 * control.y + t.y) / 4 };
  return { d: `M${s.x},${s.y} Q${control.x},${control.y} ${t.x},${t.y}`, mid };
}
