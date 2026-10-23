// Flowchart layout: Tidy arranges cards left to right in layers by how they
// connect (a Sugiyama-style layered drawing). Cards are a fixed width; their
// heights come from the browser when it measured them, else a default.

export const NODE_W = 220;
export const NODE_H = 64;
export const GAP_X = 80;
export const GAP_Y = 40;
const COLUMN_STEP = NODE_W + GAP_X + 20;
const SWEEPS = 12;

// Drop back edges (found by depth-first search from the cards with no
// incoming arrows, topmost first) so cycles don't push depth forever.
function forwardEdges(order, out, hasIncoming) {
  const forward = [];
  const mark = new Map();
  const visit = (id) => {
    mark.set(id, 'open');
    for (const to of out.get(id)) {
      if (mark.get(to) === 'open') continue;
      forward.push([id, to]);
      if (!mark.has(to)) visit(to);
    }
    mark.set(id, 'done');
  };
  for (const id of order) if (!hasIncoming.has(id) && !mark.has(id)) visit(id);
  for (const id of order) if (!mark.has(id)) visit(id);
  return forward;
}

// Longest path: each card one column past its deepest parent. The forward
// edges form a DAG, so a topological pass settles every depth at once.
function longestPathDepth(ids, forward) {
  const children = new Map(ids.map((id) => [id, []]));
  const indegree = new Map(ids.map((id) => [id, 0]));
  for (const [from, to] of forward) {
    children.get(from).push(to);
    indegree.set(to, indegree.get(to) + 1);
  }
  const depth = new Map(ids.map((id) => [id, 0]));
  const queue = ids.filter((id) => indegree.get(id) === 0);
  while (queue.length) {
    const id = queue.shift();
    for (const to of children.get(id)) {
      depth.set(to, Math.max(depth.get(to), depth.get(id) + 1));
      indegree.set(to, indegree.get(to) - 1);
      if (indegree.get(to) === 0) queue.push(to);
    }
  }
  return depth;
}

// Crossings between two adjacent layers, for the edges `pairs` ([upper, lower] ids).
function crossingsBetween(pairs, upperPos, lowerPos) {
  const sorted = pairs.map(([u, l]) => [upperPos.get(u), lowerPos.get(l)]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let count = 0;
  for (let i = 0; i < sorted.length; i += 1) {
    for (let j = i + 1; j < sorted.length; j += 1) if (sorted[j][0] > sorted[i][0] && sorted[j][1] < sorted[i][1]) count += 1;
  }
  return count;
}

// Order the cards within each column to keep arrows from crossing:
// alternating barycenter sweeps (down by parents, up by children), keeping
// the order with the fewest crossings. An arrow that skips columns gets a
// stand-in in each column it passes, so it pulls on the order like any other.
function orderLayers(layers, segments) {
  const up = new Map();
  const down = new Map();
  for (const [from, to] of segments) {
    (down.get(from) ?? down.set(from, []).get(from)).push(to);
    (up.get(to) ?? up.set(to, []).get(to)).push(from);
  }
  const positions = (order) => {
    const pos = new Map();
    for (const layer of order) layer.forEach((id, i) => pos.set(id, i));
    return pos;
  };
  const crossings = (order) => {
    const pos = positions(order);
    let total = 0;
    for (let d = 0; d + 1 < order.length; d += 1) {
      const lower = new Set(order[d + 1]);
      const pairs = order[d].flatMap((id) => (down.get(id) ?? []).filter((to) => lower.has(to)).map((to) => [id, to]));
      total += crossingsBetween(pairs, pos, pos);
    }
    return total;
  };
  const sweep = (order, downward) => {
    const pos = positions(order);
    const range = downward ? [...order.keys()].slice(1) : [...order.keys()].reverse().slice(1);
    for (const d of range) {
      const neighbours = downward ? up : down;
      const layer = order[d];
      const score = new Map(layer.map((id, i) => {
        const near = (neighbours.get(id) ?? []).map((n) => pos.get(n)).filter((p) => p !== undefined);
        // A card with nothing on that side keeps its place.
        return [id, near.length ? near.reduce((a, b) => a + b, 0) / near.length : i];
      }));
      layer.sort((a, b) => score.get(a) - score.get(b) || pos.get(a) - pos.get(b));
      layer.forEach((id, i) => pos.set(id, i));
    }
  };

  let order = layers.map((l) => [...l]);
  let best = order.map((l) => [...l]);
  let fewest = crossings(order);
  for (let i = 0; i < SWEEPS && fewest > 0; i += 1) {
    sweep(order, i % 2 === 0);
    const count = crossings(order);
    if (count < fewest) {
      fewest = count;
      best = order.map((l) => [...l]);
    }
  }
  return best;
}

// Stack one column's cards in order with no overlaps, each as close as it
// can get to where it wants to be. `want` is each card's preferred top.
function packColumn(layer, want, height) {
  // Push down past the card above, then pull up from below, and settle
  // halfway; one last downward pass keeps the gaps.
  const downPass = layer.map(() => 0);
  layer.forEach((id, i) => {
    downPass[i] = i ? Math.max(want.get(id), downPass[i - 1] + height(layer[i - 1]) + GAP_Y) : want.get(id);
  });
  const upPass = layer.map(() => 0);
  for (let i = layer.length - 1; i >= 0; i -= 1) {
    const id = layer[i];
    upPass[i] = i === layer.length - 1 ? want.get(id) : Math.min(want.get(id), upPass[i + 1] - height(id) - GAP_Y);
  }
  const tops = new Map();
  layer.forEach((id, i) => {
    const mid = (downPass[i] + upPass[i]) / 2;
    tops.set(id, i ? Math.max(mid, tops.get(layer[i - 1]) + height(layer[i - 1]) + GAP_Y) : mid);
  });
  return tops;
}

// Arrange `board.flow.nodes` in place. Cards with no connections go in a
// final column. `heights` maps card ids to measured heights in pixels.
export function tidyLayout(board, { heights = {} } = {}) {
  const nodes = board.flow.nodes;
  if (!nodes.length) return;
  const ids = nodes.map((n) => n.id);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const height = (id) => heights[id] ?? NODE_H;
  const out = new Map(ids.map((id) => [id, []]));
  const edges = board.flow.edges.filter((e) => byId.has(e.from) && byId.has(e.to));
  for (const e of edges) out.get(e.from).push(e.to);

  const byY = [...nodes].sort((a, b) => a.y - b.y || a.x - b.x).map((n) => n.id);
  const forward = forwardEdges(byY, out, new Set(edges.map((e) => e.to)));
  const depth = longestPathDepth(ids, forward);

  const connected = new Set(edges.flatMap((e) => [e.from, e.to]));
  const maxDepth = Math.max(0, ...[...connected].map((id) => depth.get(id)));
  const layers = Array.from({ length: maxDepth + 2 }, () => []);
  for (const id of byY) layers[connected.has(id) ? depth.get(id) : maxDepth + 1].push(id);

  // Arrows split into one-column segments through stand-ins.
  const segments = [];
  for (const [from, to] of forward) {
    let prev = from;
    for (let d = depth.get(from) + 1; d < depth.get(to); d += 1) {
      const stand = `~${from}>${to}@${d}`;
      layers[d].push(stand);
      segments.push([prev, stand]);
      prev = stand;
    }
    segments.push([prev, to]);
  }
  const ordered = orderLayers(layers, segments).map((layer) => layer.filter((id) => byId.has(id)));

  // Vertical placement: the first column stacks top-down; each later card
  // aims to centre on its parents (the loners' column just stacks). Every
  // column is packed so nothing overlaps.
  const parents = new Map(ids.map((id) => [id, []]));
  const children = new Map(ids.map((id) => [id, []]));
  for (const [from, to] of forward) {
    parents.get(to).push(from);
    children.get(from).push(to);
  }
  const centre = new Map();
  const centreOf = (list) => list.reduce((a, id) => a + centre.get(id), 0) / list.length;
  const place = (layer, aim) => {
    let stacked = 0;
    const want = new Map(layer.map((id) => {
      const top = aim(id) ?? stacked;
      stacked = Math.max(stacked, top + height(id) + GAP_Y);
      return [id, top];
    }));
    const tops = packColumn(layer, want, height);
    for (const id of layer) centre.set(id, tops.get(id) + height(id) / 2);
  };
  ordered.forEach((layer) => place(layer, (id) => {
    const placed = parents.get(id).filter((p) => centre.has(p));
    return placed.length ? centreOf(placed) - height(id) / 2 : undefined;
  }));
  // The first column (the roots) then slides toward the middle of its children.
  if (ordered.length > 1) {
    place(ordered[0], (id) => (children.get(id).length ? centreOf(children.get(id)) : centre.get(id)) - height(id) / 2);
  }

  const left = Math.min(...nodes.map((n) => n.x));
  const top = Math.min(...nodes.map((n) => n.y));
  const shift = top - Math.min(...ids.map((id) => centre.get(id) - height(id) / 2));
  ordered.filter((layer) => layer.length).forEach((layer, column) => {
    for (const id of layer) {
      const node = byId.get(id);
      node.x = left + column * COLUMN_STEP;
      node.y = Math.round(centre.get(id) - height(id) / 2 + shift);
    }
  });
}
