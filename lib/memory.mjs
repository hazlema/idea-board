// Ruled-out memory: ideas the user (or Claude, on the user's word) has turned
// down. Each one is kept as a record with the reason, so it is not suggested
// again, and with enough of a snapshot to bring it back.
import { OpError, now, shortId, text } from './board.mjs';
import { DEFAULT_SIZE, buildObject, findObject, objectLabel, placeObject } from './brainstorm.mjs';

const MAIN_PAGE = 'p_main';
const TEXT_MAX = 160;

const fit = (value) => (value.length > TEXT_MAX ? value.slice(0, TEXT_MAX) : value);
const groups = (board) => board.brainstorm.pages.flatMap((p) => p.objects).filter((o) => o.kind === 'group');
const findGroupOf = (board, entryId) => groups(board).find((g) => g.entries.some((e) => e.id === entryId));

function findNode(board, id) {
  const node = board.flow.nodes.find((n) => n.id === id);
  if (!node) throw new OpError(`no node with id ${id}`);
  return node;
}

function removeObject(page, object) {
  const gone = page.links.filter((l) => l.from === object.id || l.to === object.id).map((l) => l.id);
  page.objects = page.objects.filter((o) => o !== object);
  page.links = page.links.filter((l) => !gone.includes(l.id));
  return gone;
}

// What a ruled-out card is remembered by; ruleOut and the v1 migration both use it.
function nodeFacts(node) {
  return { text: node.title, source: { view: 'flowchart', label: node.title, nodeId: node.id }, snapshot: structuredClone(node) };
}

function makeRecord({ text: recordText, source, snapshot }, { reason = '', by, at = now() }) {
  return { id: shortId('r'), text: recordText, reason, by, at, source, snapshot };
}

// A record for a card that was already rejected before ruled-out memory existed.
export function recordForRejectedNode(node) {
  return makeRecord(nodeFacts(node), { by: node.updatedBy ?? node.author ?? 'user', at: node.updatedAt ?? now() });
}

// Each kind of target is split in two: `plan` validates and describes the
// record without touching the board; `apply` then makes the change.
const TARGETS = {
  entry(board, target) {
    const { page, object: group } = findObject(board, text(target.groupId, 'target.groupId', { required: true, max: 100 }));
    if (group.kind !== 'group') throw new OpError(`${group.id} is not a group`);
    const entryId = text(target.entryId, 'target.entryId', { required: true, max: 100 });
    const entry = group.entries.find((e) => e.id === entryId);
    if (!entry) throw new OpError(`no entry with id ${entryId} in group ${group.id}`);
    if (entry.ruledOut) throw new OpError('that entry is already ruled out');
    return {
      text: fit(entry.text ? `${entry.label}: ${entry.text}` : entry.label),
      source: { view: 'brainstorm', label: group.title, pageId: page.id, groupId: group.id, entryId: entry.id },
      snapshot: { entry: structuredClone(entry), groupTitle: group.title },
      changed: [group.id, entry.id],
      apply: () => { entry.ruledOut = true; },
    };
  },
  object(board, target) {
    const { page, object } = findObject(board, text(target.id, 'target.id', { required: true, max: 100 }));
    const label = objectLabel(object);
    const links = page.links.filter((l) => l.from === object.id || l.to === object.id);
    return {
      text: label,
      source: { view: 'brainstorm', label, pageId: page.id, objectId: object.id },
      snapshot: {
        object: structuredClone(object),
        links: structuredClone(links),
      },
      changed: [object.id, ...links.map((l) => l.id)],
      apply: () => removeObject(page, object),
    };
  },
  node(board, target) {
    const node = findNode(board, text(target.id, 'target.id', { required: true, max: 100 }));
    if (node.status === 'rejected') throw new OpError('that card is already ruled out');
    return {
      ...nodeFacts(node),
      changed: [node.id],
      apply: (author) => { node.status = 'rejected'; node.updatedAt = now(); node.updatedBy = author; },
    };
  },
  idea() {
    return { text: undefined, source: { view: 'chat', label: 'chat' }, snapshot: null, changed: [], apply: () => {} };
  },
};

function ruleOut(board, op, author) {
  const target = op.target;
  if (!target || typeof target !== 'object') throw new OpError('target is required');
  const plan = Object.hasOwn(TARGETS, target.kind) ? TARGETS[target.kind](board, target) : null;
  if (!plan) throw new OpError('target.kind must be one of entry, object, node, idea');
  const reason = text(op.reason, 'reason', { max: 2000 }) ?? '';
  const given = text(op.text, 'text', { required: target.kind === 'idea', max: 500 });
  const record = makeRecord({ ...plan, text: given || plan.text }, { reason, by: author });
  plan.apply(author);
  board.ruledOut.push(record);
  return { record, changed: [record.id, ...plan.changed] };
}

function pageFor(board, source) {
  return board.brainstorm.pages.find((p) => p.id === source?.pageId) ?? board.brainstorm.pages.find((p) => p.id === MAIN_PAGE) ?? board.brainstorm.pages[0];
}

function requireSnapshot(record, key) {
  const part = key ? record.snapshot?.[key] : record.snapshot;
  if (!part || typeof part !== 'object') throw new OpError('this record has no snapshot to bring back');
  return part;
}

// Same split as above: check everything, then change the board.
function restore(board, record, author) {
  const { source } = record;
  if (source?.entryId) {
    const holder = findGroupOf(board, source.entryId);
    if (holder) {
      const entry = holder.entries.find((e) => e.id === source.entryId);
      return { changed: [holder.id, entry.id], apply: () => { entry.ruledOut = false; } };
    }
    const entry = structuredClone(requireSnapshot(record, 'entry'));
    const page = pageFor(board, source);
    const existing = groups(board).find((g) => g.id === source.groupId);
    return {
      changed: [entry.id],
      apply: () => {
        entry.ruledOut = false;
        if (existing) {
          existing.entries.push(entry);
          existing.updatedAt = now();
          existing.updatedBy = author;
          return [existing.id];
        }
        const title = record.snapshot.groupTitle ?? source.label ?? '';
        const base = { ...DEFAULT_SIZE.group };
        const group = buildObject({ kind: 'group', at: placeObject(page, base), base, body: { title, color: 'slate', entries: [entry] }, author });
        page.objects.push(group);
        return [group.id];
      },
    };
  }
  if (source?.objectId) {
    const copy = structuredClone(requireSnapshot(record, 'object'));
    const page = pageFor(board, source);
    return {
      changed: [copy.id],
      apply: () => {
        if (page.objects.some((o) => o.id === copy.id)) return [];
        page.objects.push(copy);
        const ids = new Set(page.objects.map((o) => o.id));
        const have = new Set(page.links.map((l) => l.id));
        const links = (record.snapshot.links ?? []).filter((l) => ids.has(l.from) && ids.has(l.to) && !have.has(l.id));
        page.links.push(...structuredClone(links));
        return links.map((l) => l.id);
      },
    };
  }
  if (source?.nodeId) {
    const node = board.flow.nodes.find((n) => n.id === source.nodeId);
    const copy = node ? null : structuredClone(requireSnapshot(record));
    return {
      changed: [source.nodeId],
      apply: () => {
        const target = node ?? copy;
        target.status = 'idea';
        if (node) { node.updatedAt = now(); node.updatedBy = author; } else board.flow.nodes.push(copy);
      },
    };
  }
  return { changed: [], apply: () => {} };
}

function bringBack(board, op, author) {
  const id = text(op.id, 'id', { required: true, max: 100 });
  const record = board.ruledOut.find((r) => r.id === id);
  if (!record) throw new OpError(`no ruled-out record with id ${id}`);
  const plan = restore(board, record, author);
  const extra = plan.apply() ?? [];
  board.ruledOut = board.ruledOut.filter((r) => r !== record);
  return { restored: record.id, changed: [record.id, ...plan.changed, ...extra] };
}

const OPS = { ruleOut, bringBack };

// Returns undefined for op types that are not memory ops, so applyOp can
// report them as unknown.
export function memoryOp(board, op, author) {
  const handler = Object.hasOwn(OPS, op?.type) ? OPS[op.type] : undefined;
  return handler ? handler(board, op, author) : undefined;
}

// After a version restore the content may have lost its struck-out state:
// put every record's effect back on whatever exists. The content may also
// carry a struck-out state whose record is gone (brought back since the
// version was saved): clear that, or the item is stuck with no Bring back.
export function enforceRuledOut(board) {
  const entryIds = new Set(board.ruledOut.map((r) => r.source?.entryId).filter(Boolean));
  const nodeIds = new Set(board.ruledOut.map((r) => r.source?.nodeId).filter(Boolean));
  for (const page of board.brainstorm.pages) {
    for (const object of page.objects) {
      if (object.kind !== 'group') continue;
      for (const entry of object.entries) if (entry.ruledOut && !entryIds.has(entry.id)) entry.ruledOut = false;
    }
  }
  for (const node of board.flow.nodes) if (node.status === 'rejected' && !nodeIds.has(node.id)) node.status = 'idea';
  for (const { source } of board.ruledOut) {
    if (source?.entryId) {
      const holder = findGroupOf(board, source.entryId);
      if (holder) holder.entries.find((e) => e.id === source.entryId).ruledOut = true;
    } else if (source?.objectId) {
      for (const page of board.brainstorm.pages) {
        const object = page.objects.find((o) => o.id === source.objectId);
        if (object) removeObject(page, object);
      }
    } else if (source?.nodeId) {
      const node = board.flow.nodes.find((n) => n.id === source.nodeId);
      if (node) node.status = 'rejected';
    }
  }
}

const STOPWORDS = new Set('the and for with that this can are was but not they them their from have has use using into when then than more most mostly very also just only about over under each other some such out off its'.split(' '));

function tokens(value) {
  const found = String(value ?? '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t))
    .map((t) => (t.length > 3 && t.endsWith('s') ? t.slice(0, -1) : t));
  return new Set(found);
}

// Records whose text is close to `value`: at least two shared words (or the
// record's only word, so ruling out "Fireballs" catches "Fireballs" again),
// and at least half of the shorter text's words shared. A one-word `value` is
// not enough on its own to match a longer record (a group titled "Wizards" is
// not "Wizards cast fireballs").
export function findRuledOutMatches(value, records) {
  const mine = tokens(value);
  if (!mine.size) return [];
  return records.filter((record) => {
    const theirs = tokens(record.text);
    let shared = 0;
    for (const t of mine) if (theirs.has(t)) shared += 1;
    return shared >= Math.min(2, theirs.size) && shared / Math.min(mine.size, theirs.size) >= 0.5;
  });
}
