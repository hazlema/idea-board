import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOp, emptyBoard, OpError } from '../lib/board.mjs';
import { boardView } from '../lib/mcp-tools.mjs';
import { PRUNE_THRESHOLD, PRUNE_REGROW, boardSize, pruneGuard, keepCredit } from '../lib/prune.mjs';

const A = `${'a'.repeat(32)}.png`;

function sample() {
  const b = emptyBoard('Wizards');
  const group = applyOp(b, {
    type: 'addObject', kind: 'group', title: 'Wizards', x: 0, y: 0,
    entries: [{ label: 'Plain' }, { label: 'Box', check: 'open' }, { label: 'Struck', check: 'open' }],
  }, 'user').object;
  const other = applyOp(b, { type: 'addObject', kind: 'group', title: 'Other', x: 400, y: 0, entries: [{ label: 'Tick', check: 'done' }] }, 'user').object;
  const [bullet, box, struck] = group.entries;
  applyOp(b, { type: 'ruleOut', target: { kind: 'entry', groupId: group.id, entryId: struck.id }, reason: 'no' }, 'user');
  const picture = applyOp(b, { type: 'addObject', kind: 'picture', asset: A, caption: 'sketch', x: 0, y: 300 }, 'user').object;
  const accepted = applyOp(b, { type: 'addNode', title: 'Start', status: 'accepted', x: 0, y: 0 }, 'user').node;
  const accepted2 = applyOp(b, { type: 'addNode', title: 'End', status: 'accepted', x: 0, y: 200 }, 'user').node;
  const idea = applyOp(b, { type: 'addNode', title: 'Maybe', x: 300, y: 0 }, 'user').node;
  const edge = applyOp(b, { type: 'addEdge', from: accepted.id, to: accepted2.id }, 'user').edge;
  return { b, group, other, bullet, box, struck, picture, accepted, accepted2, idea, edge };
}

const refuses = (b, op) => assert.throws(() => pruneGuard(b, op), OpError, JSON.stringify(op));
const allows = (b, op) => assert.doesNotThrow(() => pruneGuard(b, op), JSON.stringify(op));

test('boardSize equals the view_board JSON length', () => {
  const { b } = sample();
  const store = { board: b, history: () => ({ entries: [] }) };
  assert.equal(boardSize(store), JSON.stringify(boardView(store)).length);
  assert.ok(PRUNE_THRESHOLD === 45_000 && PRUNE_REGROW === 10_000);
});

test('pruneGuard refuses changes to the law', () => {
  const s = sample();
  const { b, group: g, bullet, box, struck, picture, accepted: a, accepted2: a2, idea, edge } = s;
  const e = (entry) => ({ groupId: g.id, entryId: entry.id });
  refuses(b, { type: 'updateEntry', ...e(bullet), label: 'x' });
  refuses(b, { type: 'updateEntry', ...e(bullet), text: 'x' });
  refuses(b, { type: 'deleteEntry', ...e(bullet) });
  refuses(b, { type: 'updateEntry', ...e(box), check: 'none' });
  refuses(b, { type: 'addEntry', groupId: g.id, label: 'n' });
  refuses(b, { type: 'addEntry', groupId: g.id, label: 'n', check: 'none' });
  refuses(b, { type: 'addObject', kind: 'group', title: 't', entries: [{ label: 'a', check: 'open' }, { label: 'b' }] });
  refuses(b, { type: 'updateEntry', ...e(struck), text: 'x' });
  refuses(b, { type: 'deleteEntry', ...e(struck) });
  refuses(b, { type: 'deleteObject', id: g.id });
  refuses(b, { type: 'deleteObject', id: picture.id });
  for (const f of [{ title: 'x' }, { notes: 'x' }, { props: [] }, { status: 'idea' }]) refuses(b, { type: 'updateNode', id: a.id, ...f });
  refuses(b, { type: 'updateNode', id: idea.id, status: 'accepted' });
  refuses(b, { type: 'addNode', title: 'x', status: 'accepted' });
  refuses(b, { type: 'deleteNode', id: a.id });
  refuses(b, { type: 'updateEdge', id: edge.id, label: 'x' });
  refuses(b, { type: 'deleteEdge', id: edge.id });
  refuses(b, { type: 'deleteEdge', from: a.id, to: a2.id });
  refuses(b, { type: 'ruleOut', target: { kind: 'node', id: a.id } });
  refuses(b, { type: 'ruleOut', target: { kind: 'object', id: picture.id } });
  refuses(b, { type: 'ruleOut', target: { kind: 'object', id: g.id } });
  refuses(b, { type: 'ruleOut', target: { kind: 'entry', groupId: g.id, entryId: bullet.id } });
  refuses(b, { type: 'ruleOut', target: { kind: 'entry', groupId: g.id, entryId: struck.id } });
  refuses(b, { type: 'bringBack', id: 'r_1' });
  refuses(b, { type: 'chat', text: 'hi' });
  refuses(b, { type: 'setTitle', title: 'x' });
  refuses(b, { type: 'somethingNew' });
});

test('pruneGuard allows what pruning needs', () => {
  const { b, group: g, other, bullet, box, picture, accepted: a, idea } = sample();
  allows(b, { type: 'moveEntry', entryId: bullet.id, toGroupId: other.id });
  allows(b, { type: 'updateEntry', groupId: g.id, entryId: box.id, text: 'shorter' });
  allows(b, { type: 'deleteEntry', groupId: g.id, entryId: box.id });
  allows(b, { type: 'addEntry', groupId: g.id, label: 'n', check: 'open' });
  allows(b, { type: 'updateObject', id: picture.id, caption: 'new' });
  allows(b, { type: 'updateNode', id: a.id, x: 5, y: 6 });
  allows(b, { type: 'deleteNode', id: idea.id });
  allows(b, { type: 'updateSection', id: 's' , text: 'x' });
  allows(b, { type: 'deleteSection', id: 's' });
  allows(b, { type: 'ruleOut', target: { kind: 'idea' }, text: 'x' });
  allows(b, { type: 'ruleOut', target: { kind: 'node', id: idea.id } });
  allows(b, { type: 'ruleOut', target: { kind: 'entry', groupId: g.id, entryId: box.id } });
  allows(b, { type: 'ruleOut', target: { kind: 'object', id: other.id } });
  allows(b, { type: 'deleteObject', id: other.id });
  allows(b, { type: 'deleteEdge', id: 'missing' });
});

test('keepCredit keeps authors and unmarks what the pass made', () => {
  const b = emptyBoard('t');
  const sec = applyOp(b, { type: 'addSection', title: 'Goal', text: 'x' }, 'user').section;
  const grp = applyOp(b, { type: 'addObject', kind: 'group', title: 'G', entries: [{ label: 'e', check: 'open' }] }, 'user').object;
  const before = structuredClone(b);
  applyOp(b, { type: 'updateSection', id: sec.id, text: 'y' }, 'claude');
  applyOp(b, { type: 'updateEntry', groupId: grp.id, entryId: grp.entries[0].id, text: 'z' }, 'claude');
  const made = applyOp(b, { type: 'addObject', kind: 'group', title: 'New', entries: [{ label: 'q', check: 'open' }] }, 'claude').object;
  const added = applyOp(b, { type: 'addEntry', groupId: grp.id, label: 'w', check: 'open' }, 'claude').entry;
  const node = applyOp(b, { type: 'addNode', title: 'N' }, 'claude').node;
  keepCredit(before, b);
  assert.equal(b.brief.sections[0].updatedBy, 'user');
  assert.equal(grp.updatedBy, 'user');
  assert.equal(grp.entries[0].author, 'user');
  assert.equal(made.claudeAdded, false);
  assert.ok(made.entries.every((e) => e.claudeAdded === false));
  assert.equal(added.claudeAdded, false);
  assert.equal(node.updatedBy, 'claude');
});
