import { expect, test } from 'vitest';
import { curve, fitView, flowAnchors, freeSpot, linkPath, toWorld, zoomAt, type Rect, type View } from './geometry';

test('zoomAt keeps the point under the cursor fixed', () => {
  const view: View = { x: 40, y: -25, k: 1.3 };
  const before = toWorld(view, 300, 200);
  const next = zoomAt(view, 300, 200, -240);
  expect(next.k).toBeGreaterThan(view.k);
  const after = toWorld(next, 300, 200);
  expect(after.x).toBeCloseTo(before.x, 6);
  expect(after.y).toBeCloseTo(before.y, 6);
});

test('zoomAt uses the v1 factor and clamps k to 0.2-2.5', () => {
  expect(zoomAt({ x: 0, y: 0, k: 1 }, 0, 0, -100).k).toBeCloseTo(Math.exp(0.15), 10);
  expect(zoomAt({ x: 0, y: 0, k: 2.4 }, 0, 0, -1000).k).toBe(2.5);
  expect(zoomAt({ x: 0, y: 0, k: 0.21 }, 0, 0, 1000).k).toBe(0.2);
});

test('fitView fits two rects with padding', () => {
  const rects: Rect[] = [
    { x: 0, y: 0, w: 200, h: 100 },
    { x: 800, y: 400, w: 200, h: 100 },
  ];
  const view = fitView(rects, 1200, 700);
  // Content is 1000 x 500; the width is the tighter fit: (1200 - 120) / 1000.
  expect(view.k).toBeCloseTo(1.08, 10);
  // Centred, so the padding is the same on both sides.
  expect(view.x).toBeCloseTo((1200 - 1000 * view.k) / 2, 6);
  expect(view.y).toBeCloseTo((700 - 500 * view.k) / 2, 6);
  // Both rects are on screen with at least the padding left over.
  for (const r of rects) {
    expect(r.x * view.k + view.x).toBeGreaterThanOrEqual(60 - 1e-9);
    expect((r.x + r.w) * view.k + view.x).toBeLessThanOrEqual(1200 - 60 + 1e-9);
    expect(r.y * view.k + view.y).toBeGreaterThanOrEqual(60 - 1e-9);
    expect((r.y + r.h) * view.k + view.y).toBeLessThanOrEqual(700 - 60 + 1e-9);
  }
});

test('fitView never zooms in past 1.25 or out past 0.2', () => {
  expect(fitView([{ x: 0, y: 0, w: 50, h: 50 }], 2000, 2000).k).toBe(1.25);
  expect(fitView([{ x: 0, y: 0, w: 100000, h: 100000 }], 800, 600).k).toBe(0.2);
});

test('flowAnchors picks left/right sides for wide gaps and top/bottom for tall ones', () => {
  const a: Rect = { x: 0, y: 0, w: 220, h: 56 };
  const right = flowAnchors(a, { x: 400, y: 20, w: 220, h: 56 });
  expect(right.s).toEqual({ x: 220, y: 28 });
  expect(right.t).toEqual({ x: 400, y: 48 });
  expect(right.sd).toEqual({ x: 1, y: 0 });
  expect(right.td).toEqual({ x: -1, y: 0 });

  const left = flowAnchors({ x: 400, y: 0, w: 220, h: 56 }, a);
  expect(left.s).toEqual({ x: 400, y: 28 });
  expect(left.t).toEqual({ x: 220, y: 28 });
  expect(left.sd).toEqual({ x: -1, y: 0 });

  const down = flowAnchors(a, { x: 30, y: 300, w: 220, h: 56 });
  expect(down.s).toEqual({ x: 110, y: 56 });
  expect(down.t).toEqual({ x: 140, y: 300 });
  expect(down.sd).toEqual({ x: 0, y: 1 });
  expect(down.td).toEqual({ x: 0, y: -1 });

  const up = flowAnchors({ x: 30, y: 300, w: 220, h: 56 }, a);
  expect(up.s).toEqual({ x: 140, y: 300 });
  expect(up.t).toEqual({ x: 110, y: 56 });
  expect(up.sd).toEqual({ x: 0, y: -1 });
});

test('curve matches the v1 cubic and its midpoint', () => {
  const { d, mid } = curve({ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 1, y: 0 }, { x: -1, y: 0 });
  // Handle length is max(40, distance / 2.5) = 40.
  expect(d).toBe('M0,0 C40,0 60,0 100,0');
  expect(mid).toEqual({ x: 50, y: 0 });
  const long = curve({ x: 0, y: 0 }, { x: 500, y: 0 }, { x: 1, y: 0 }, { x: -1, y: 0 });
  expect(long.d).toBe('M0,0 C200,0 300,0 500,0');
});

function onBorder(r: Rect, p: { x: number; y: number }): boolean {
  const insideX = p.x >= r.x - 1 && p.x <= r.x + r.w + 1;
  const insideY = p.y >= r.y - 1 && p.y <= r.y + r.h + 1;
  const onVertical = Math.abs(p.x - r.x) <= 1 || Math.abs(p.x - (r.x + r.w)) <= 1;
  const onHorizontal = Math.abs(p.y - r.y) <= 1 || Math.abs(p.y - (r.y + r.h)) <= 1;
  return insideX && insideY && (onVertical || onHorizontal);
}

function ends(d: string): { s: { x: number; y: number }; t: { x: number; y: number } } {
  const nums = (d.match(/-?\d+(\.\d+)?(e-?\d+)?/g) ?? []).map(Number);
  return { s: { x: nums[0], y: nums[1] }, t: { x: nums[4], y: nums[5] } };
}

test('linkPath starts and ends on the rect borders', () => {
  const pairs: [Rect, Rect][] = [
    [{ x: 0, y: 0, w: 200, h: 100 }, { x: 500, y: 40, w: 160, h: 80 }],
    [{ x: 0, y: 0, w: 200, h: 100 }, { x: 40, y: 400, w: 160, h: 80 }],
    [{ x: 300, y: 300, w: 200, h: 100 }, { x: 0, y: 0, w: 160, h: 80 }],
    [{ x: 0, y: 0, w: 200, h: 100 }, { x: 150, y: 90, w: 160, h: 80 }],
  ];
  for (const [a, b] of pairs) {
    const { d, mid } = linkPath(a, b);
    const { s, t } = ends(d);
    expect(onBorder(a, s)).toBe(true);
    expect(onBorder(b, t)).toBe(true);
    expect(Number.isFinite(mid.x) && Number.isFinite(mid.y)).toBe(true);
  }
});

test('linkPath survives two rects with the same centre', () => {
  const r: Rect = { x: 0, y: 0, w: 100, h: 50 };
  const { d, mid } = linkPath(r, r);
  expect(d).not.toContain('NaN');
  expect(Number.isFinite(mid.x)).toBe(true);
});

const overlaps = (a: Rect, b: Rect): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

test('freeSpot keeps the wanted spot when nothing is there', () => {
  const want = { x: 0, y: 0, w: 200, h: 100 };
  expect(freeSpot(want, [])).toEqual({ x: 0, y: 0 });
  expect(freeSpot(want, [{ x: 400, y: 0, w: 100, h: 100 }])).toEqual({ x: 0, y: 0 });
});

test('freeSpot moves off an object to the nearest free spot, with a gap', () => {
  const want = { x: 0, y: 0, w: 240, h: 220 };
  const taken = { x: 0, y: 0, w: 240, h: 220 };
  const spot = freeSpot(want, [taken]);
  const placed = { ...spot, w: want.w, h: want.h };
  expect(overlaps(placed, { x: taken.x - 16, y: taken.y - 16, w: taken.w + 32, h: taken.h + 32 })).toBe(false);
  // Nearest: one move to the side, not a long way off.
  expect(Math.hypot(spot.x, spot.y)).toBeLessThanOrEqual(240 + 16 + 40);
});

test('freeSpot never stacks a second picture on the first one', () => {
  const size = { w: 240, h: 220 };
  const first = freeSpot({ x: 0, y: 0, ...size }, []);
  const second = freeSpot({ x: 0, y: 0, ...size }, [{ ...first, ...size }]);
  const third = freeSpot({ x: 0, y: 0, ...size }, [{ ...first, ...size }, { ...second, ...size }]);
  expect(overlaps({ ...second, ...size }, { ...first, ...size })).toBe(false);
  expect(overlaps({ ...third, ...size }, { ...first, ...size })).toBe(false);
  expect(overlaps({ ...third, ...size }, { ...second, ...size })).toBe(false);
});

test('freeSpot finds a gap between objects when there is one', () => {
  // A ring of boxes with a hole in the middle big enough for the new one.
  const around = [
    { x: -300, y: -300, w: 600, h: 200 },
    { x: -300, y: 100, w: 600, h: 200 },
    { x: -300, y: -100, w: 150, h: 200 },
    { x: 150, y: -100, w: 150, h: 200 },
  ];
  expect(freeSpot({ x: -40, y: -60, w: 80, h: 60 }, around)).toEqual({ x: -40, y: -60 });
  const spot = freeSpot({ x: -300, y: -100, w: 80, h: 60 }, around);
  for (const r of around) expect(overlaps({ ...spot, w: 80, h: 60 }, r)).toBe(false);
});
