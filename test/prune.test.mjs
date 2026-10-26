import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOp, emptyBoard, OpError } from '../lib/board.mjs';
import { boardView } from '../lib/mcp-tools.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BoardStore } from '../lib/store.mjs';
import { PRUNE_SYSTEM_PROMPT, PRUNE_THRESHOLD, PRUNE_REGROW, boardSize, pruneGuard, keepCredit, Pruner, prunePrompt } from '../lib/prune.mjs';

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
  const { b, group: g, struck, picture, accepted: a, accepted2: a2, idea, edge } = s;
  const e = (entry) => ({ groupId: g.id, entryId: entry.id });
  refuses(b, { type: 'updateEntry', ...e(struck), text: 'x' });
  refuses(b, { type: 'updateEntry', ...e(struck), label: 'x' });
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
  // deleteEdge matches by id or by from/to: either match is checked.
  refuses(b, { type: 'deleteEdge', id: 'missing', from: a.id, to: a2.id });
  refuses(b, { type: 'addEdge', from: a2.id, to: a.id });
  refuses(b, { type: 'moveEntry', entryId: struck.id, toGroupId: s.other.id });
  refuses(b, { type: 'moveEntry', entryId: struck.id, toGroupId: g.id, index: 0 });
  refuses(b, { type: 'ruleOut', target: { kind: 'node', id: a.id } });
  refuses(b, { type: 'ruleOut', target: { kind: 'object', id: picture.id } });
  refuses(b, { type: 'ruleOut', target: { kind: 'object', id: g.id } });
  refuses(b, { type: 'ruleOut', target: { kind: 'entry', groupId: g.id, entryId: struck.id } });
  refuses(b, { type: 'bringBack', id: 'r_1' });
  refuses(b, { type: 'chat', text: 'hi' });
  refuses(b, { type: 'setTitle', title: 'x' });
  refuses(b, { type: 'somethingNew' });
});

test('plain bullets are fair game', () => {
  const { b, group: g, other, bullet } = sample();
  const e = { groupId: g.id, entryId: bullet.id };
  allows(b, { type: 'updateEntry', ...e, label: 'x' });
  allows(b, { type: 'updateEntry', ...e, text: 'x' });
  allows(b, { type: 'updateEntry', ...e, check: 'none' });
  allows(b, { type: 'deleteEntry', ...e });
  allows(b, { type: 'moveEntry', entryId: bullet.id, toGroupId: other.id });
  allows(b, { type: 'addEntry', groupId: other.id, label: 'n' });
  allows(b, { type: 'addEntry', groupId: other.id, label: 'n', check: 'none' });
  allows(b, { type: 'addObject', kind: 'group', title: 't', entries: [{ label: 'a', check: 'open' }, { label: 'b' }] });
  allows(b, { type: 'ruleOut', target: { kind: 'entry', groupId: g.id, entryId: bullet.id } });
  const plain = applyOp(b, { type: 'addObject', kind: 'group', title: 'Plain', entries: [{ label: 'a' }, { label: 'b' }] }, 'user').object;
  allows(b, { type: 'deleteObject', id: plain.id });
  allows(b, { type: 'ruleOut', target: { kind: 'object', id: plain.id } });
  // A group holding a struck entry still can't go.
  refuses(b, { type: 'deleteObject', id: g.id });
  refuses(b, { type: 'ruleOut', target: { kind: 'object', id: g.id } });
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
  allows(b, { type: 'addEdge', from: a.id, to: idea.id });
  allows(b, { type: 'moveEntry', entryId: box.id, toGroupId: other.id });
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

function prunerStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-board-'));
  const store = new BoardStore(path.join(dir, 'board.json'));
  store.apply({ type: 'addObject', kind: 'group', title: 'G', x: 0, y: 0, entries: [{ label: 'Plain' }, { label: 'Box', check: 'open' }] }, 'user');
  return { store, dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const lastChat = (store) => store.board.chat.at(-1);

test('a pass saves a version first, guards the law, and posts a summary with the sizes', async () => {
  const { store, cleanup } = prunerStore();
  try {
    const group = store.board.brainstorm.pages[0].objects[0];
    let refused = false;
    const struck = group.entries[1];
    store.apply({ type: 'ruleOut', target: { kind: 'entry', groupId: group.id, entryId: struck.id }, reason: 'no' }, 'user');
    const agent = {
      found: true,
      async prune(prompt, { onStart }) {
        onStart('tok');
        assert.equal(store.pruneToken, 'tok');
        const prune = { prune: 'tok' };
        try { store.apply({ type: 'updateEntry', groupId: group.id, entryId: struck.id, label: 'Changed' }, 'claude', prune); } catch { refused = true; }
        store.apply({ type: 'updateEntry', groupId: group.id, entryId: group.entries[0].id, label: 'B' }, 'claude', prune);
        return { ok: true, text: 'Merged things.' };
      },
    };
    const pruner = new Pruner({ store, agent });
    assert.equal(pruner.available(), true);
    const result = await pruner.run({ guidance: '', timeoutMs: 1000 });
    assert.equal(result.ok, true);
    const names = store.versions.list().map((v) => v.name);
    assert.equal(names.length, 1);
    assert.match(names[0], /^Before prune \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    assert.ok(refused);
    const now = store.board.brainstorm.pages[0].objects[0].entries;
    assert.equal(now.find((e) => e.id === struck.id).label, 'Box');
    assert.equal(now[0].label, 'B');
    assert.equal(store.pruning, false);
    const m = lastChat(store);
    assert.equal(m.role, 'claude');
    assert.match(m.text, /^Merged things\./);
    assert.match(m.text, /Board size: [\d,]+ → [\d,]+ characters\./);
  } finally { cleanup(); }
});

test('the prompt carries the settings and what is new', () => {
  const { store, cleanup } = prunerStore();
  try {
    const group = store.board.brainstorm.pages[0].objects[0];
    store.apply({ type: 'setColabLineup', ...store.board.colab.lineup, pruneLimit: 3, pruneAggressiveness: 'aggressive' }, 'user');
    const first = prunePrompt(store);
    assert.match(first, /Mechanics limit: 3/);
    assert.match(first, /Aggressiveness: aggressive/);
    assert.match(first, /New since the last pass: none \(this is the first pass\)/);
    store.apply({ type: 'setColabLineup', ...store.board.colab.lineup, pruneLimit: null }, 'user');
    assert.match(prunePrompt(store), /Mechanics limit: none/);
    const entry = store.apply({ type: 'addEntry', groupId: group.id, label: 'Fresh', check: 'open' }, 'user').entry;
    const section = store.apply({ type: 'addSection', title: 'Late', text: 'x' }, 'user').section;
    // Old items carry an earlier createdAt than the pass; the new ones a later one.
    const old = group.entries[0];
    old.createdAt = '2000-01-01T00:00:00.000Z';
    entry.createdAt = '2100-01-01T00:00:00.000Z';
    section.createdAt = '2100-01-01T00:00:00.000Z';
    store.setLastPruneAt('2050-01-01T00:00:00.000Z');
    const p = prunePrompt(store);
    const line = p.split('\n').find((l) => l.startsWith('New since the last pass'));
    assert.match(line, /^New since the last pass \(don't cut these\): /);
    assert.ok(line.includes(`entry ${entry.id}`) && line.includes(`section ${section.id}`), line);
    assert.ok(!line.includes(old.id), line);
    // Long multi-line notes stay one short line; struck entries and pictures are not listed.
    const note = store.apply({ type: 'addObject', kind: 'note', x: 0, y: 0, text: `first line\n\n${'word '.repeat(40)}` }, 'user').object;
    const struck = store.apply({ type: 'addEntry', groupId: group.id, label: 'Struck', check: 'open' }, 'user').entry;
    store.apply({ type: 'ruleOut', target: { kind: 'entry', groupId: group.id, entryId: struck.id }, reason: 'no' }, 'user');
    const pic = store.apply({ type: 'addObject', kind: 'picture', asset: 'a'.repeat(32) + '.png', caption: 'sketch', x: 0, y: 300 }, 'user').object;
    for (const x of [note, struck, pic]) x.createdAt = '2100-01-01T00:00:00.000Z';
    const line2 = prunePrompt(store).split('\n').find((l) => l.startsWith('New since the last pass'));
    assert.ok(line2.includes(note.id) && line2.includes('first line word'), line2);
    assert.ok(line2.includes('…') && !line2.includes('word word word word word word word word word word word word word word'), line2);
    assert.ok(!line2.includes(struck.id) && !line2.includes(pic.id), line2);
    store.setLastPruneAt('2200-01-01T00:00:00.000Z');
    assert.match(prunePrompt(store), /New since the last pass: none\n/);
  } finally { cleanup(); }
});

test('a finished pass records lastPruneAt; a pass stopped before it starts does not', async () => {
  const { store, cleanup } = prunerStore();
  try {
    assert.equal(store.board.colab.lastPruneAt, null);
    await new Pruner({ store, agent: { found: true, prune: async () => ({ ok: false, error: 'stopped' }) } }).run({});
    assert.equal(store.board.colab.lastPruneAt, null);
    const t0 = Date.now();
    let atStart;
    await new Pruner({ store, agent: { found: true, prune: async (p, { onStart }) => { onStart(); atStart = store.board.colab.lastPruneAt; return { ok: true, text: 'ok' }; } } }).run({});
    assert.ok(Date.parse(atStart) >= t0, 'stamped when the pass starts');
    assert.equal(store.board.colab.lastPruneAt, atStart);
  } finally { cleanup(); }
});

test('the prompt carries the whole board and the guidance', () => {
  const { store, cleanup } = prunerStore();
  try {
    const p = prunePrompt(store, 'keep the wizard stuff');
    assert.ok(p.includes(JSON.stringify(boardView(store, { fullNotes: true }))));
    assert.ok(p.includes('keep the wizard stuff'));
  } finally { cleanup(); }
});

test('a failed or stopped pass still ends the prune and says so', async () => {
  for (const prune of [async (p, { onStart }) => { onStart(); return { ok: false, error: 'stopped' }; }, async (p, { onStart }) => { onStart(); throw new Error('stopped'); }]) {
    const { store, cleanup } = prunerStore();
    try {
      const result = await new Pruner({ store, agent: { found: true, prune } }).run({});
      assert.equal(result.ok, false);
      assert.equal(store.pruning, false);
      assert.ok(lastChat(store).text.startsWith('Pruning was cut short (stopped).'));
    } finally { cleanup(); }
  }
});

test('a failed pass with no error says why it is unknown', async () => {
  const { store, cleanup } = prunerStore();
  try {
    const result = await new Pruner({ store, agent: { found: true, prune: async (p, { onStart }) => { onStart(); return { ok: false }; } } }).run({});
    assert.equal(result.ok, false);
    assert.ok(lastChat(store).text.startsWith('Pruning was cut short (unknown error).'), lastChat(store).text);
  } finally { cleanup(); }
});

test('a pass stopped before it got the lock saves nothing and posts nothing', async () => {
  const { store, cleanup } = prunerStore();
  try {
    const chat = store.board.chat.length;
    const result = await new Pruner({ store, agent: { found: true, prune: async () => ({ ok: false, error: 'stopped' }) } }).run({});
    assert.equal(result.ok, false);
    assert.equal(result.started, false);
    assert.equal(typeof result.before, 'number');
    assert.equal(typeof result.after, 'number');
    assert.equal(store.versions.list().length, 0);
    assert.equal(store.board.chat.length, chat);
    assert.equal(store.pruning, false);
  } finally { cleanup(); }
});

test('the version is saved and the guard begins only once the agent starts, with the board as it is then', async () => {
  const { store, cleanup } = prunerStore();
  try {
    const group = store.board.brainstorm.pages[0].objects[0];
    let prompt = null;
    const agent = {
      found: true,
      async prune(p, { onStart }) {
        // The chat run in flight, still editing a plain bullet before the lock frees.
        store.apply({ type: 'updateEntry', groupId: group.id, entryId: group.entries[0].id, label: 'Edited by chat' }, 'claude');
        assert.equal(store.versions.list().length, 0);
        assert.equal(store.pruning, false);
        onStart();
        assert.equal(store.pruning, true);
        prompt = typeof p === 'function' ? p() : p;
        return { ok: true, text: 'ok' };
      },
    };
    await new Pruner({ store, agent }).run({});
    assert.equal(store.board.brainstorm.pages[0].objects[0].entries[0].label, 'Edited by chat');
    assert.ok(prompt.includes('Edited by chat'));
    assert.equal(store.versions.list().length, 1);
  } finally { cleanup(); }
});

test('the prompt tells the agent how to cut a mechanic with rule_out', () => {
  assert.match(PRUNE_SYSTEM_PROMPT, /rule_out with kind "object"/);
  assert.match(PRUNE_SYSTEM_PROMPT, /rule_out kind "idea"/);
  assert.match(PRUNE_SYSTEM_PROMPT, /Never use rule_out on single entries or cards/);
});

test("a pass uses the library's prune text", async () => {
  const seen = [];
  const agent = { found: true, prune: async (p, opts) => { seen.push(opts.systemPrompt); return { ok: true, text: 'ok' }; } };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-board-prune-'));
  const store = new BoardStore(path.join(dir, 'b.json'));
  const library = { get: () => ({ rules: '', roles: [], passes: { prune: 'Cut hard.' } }) };
  await new Pruner({ store, agent, library }).run({});
  await new Pruner({ store, agent }).run({});
  assert.deepEqual(seen, ['Cut hard.', PRUNE_SYSTEM_PROMPT]);
});
