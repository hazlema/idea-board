import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildPrompt } from '../lib/agent.mjs';
import { createToolRunner } from '../lib/mcp.mjs';
import { BoardStore } from '../lib/store.mjs';
import { withServer } from './helpers.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

const V2_TOOLS = [
  'view_board', 'view_picture', 'get_node', 'get_history', 'list_versions',
  'add_brief_section', 'update_brief_section', 'move_brief_section', 'delete_brief_section',
  'add_group', 'update_group', 'add_entry', 'update_entry', 'move_entry', 'delete_entry',
  'add_note', 'update_note', 'add_topic', 'update_topic', 'add_picture_from_url', 'update_picture',
  'move_object', 'delete_object', 'link', 'update_link', 'unlink',
  'rule_out', 'bring_back',
  'add_node', 'update_node', 'delete_node', 'connect', 'update_connection', 'disconnect', 'tidy_layout', 'rename_board',
  'undo_reply', 'save_version', 'restore_version', 'export_design_doc',
  'reply', 'wait_for_chat', 'batch',
];

test('initialize reports v2 and tools/list covers the full v2 tool set', () => withServer(async ({ rpc }) => {
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  assert.equal(init.result.serverInfo.version, '0.2.0');
  assert.equal(init.result.instructions, 'A shared idea board you and the user both edit: Brief (what you are building), Brainstorm (groups, notes, pictures, topics, links) and Flowchart (cards and arrows). Call view_board first and read ruled_out: never re-propose anything on it; if a tool result flags a resemblance, tell the user. Record rejections the user states with rule_out. You may change anything; every change is visible and undoable. Use batch to make several changes in one call. Use wait_for_chat to listen to the board chat; it also reports what the user changed on the board since you last looked.');
  const { tools } = (await rpc('tools/list', {})).result;
  const names = tools.map((t) => t.name);
  for (const name of V2_TOOLS) assert.ok(names.includes(name), name);
  assert.equal(new Set(names).size, names.length);
  const update = tools.find((t) => t.name === 'update_node');
  assert.deepEqual(update.inputSchema.properties.status.enum, ['idea', 'accepted']);
}));

test('view_board shows memory first and brainstorm content', () => withServer(async ({ call, userOp }) => {
  const group = (await (await userOp({ type: 'addObject', kind: 'group', title: 'Wizards', entries: [{ label: 'Staves', text: 'focus items', check: 'done' }, { label: 'Fireballs', text: 'big damage' }] })).json()).object;
  const fireballs = group.entries[1];
  await userOp({ type: 'ruleOut', target: { kind: 'entry', groupId: group.id, entryId: fireballs.id }, reason: 'too flashy' });
  await userOp({ type: 'addObject', kind: 'note', text: 'a note', x: 900, y: 0 });
  await userOp({ type: 'addObject', kind: 'topic', text: 'Magic system', x: 900, y: 300 });
  const view = await call('view_board', {});
  assert.deepEqual(Object.keys(view), ['title', 'brief', 'ruled_out', 'brainstorm', 'flowchart', 'recent_history', 'unanswered_chat']);
  assert.deepEqual(Object.keys(view.brief[0]), ['id', 'title', 'text']);
  assert.deepEqual(Object.keys(view.ruled_out[0]), ['id', 'text', 'reason', 'from', 'at']);
  assert.equal(view.ruled_out[0].reason, 'too flashy');
  assert.equal(view.ruled_out[0].from, 'user');
  assert.deepEqual(Object.keys(view.brainstorm), ['groups', 'notes', 'pictures', 'topics', 'links']);
  const [g] = view.brainstorm.groups;
  assert.deepEqual(Object.keys(g), ['id', 'title', 'color', 'claude_added', 'x', 'y', 'w', 'h', 'entries', 'ruled_out_entries']);
  assert.deepEqual(g.entries.map((e) => e.label), ['Staves']);
  assert.deepEqual(Object.keys(g.entries[0]), ['id', 'label', 'text', 'check', 'claude_added']);
  assert.equal(g.entries[0].check, 'done');
  assert.deepEqual(g.ruled_out_entries, [{ id: fireballs.id, label: 'Fireballs' }]);
  assert.equal(view.brainstorm.notes[0].text, 'a note');
  assert.deepEqual(Object.keys(view.brainstorm.notes[0]), ['id', 'text', 'claude_added', 'x', 'y', 'w', 'h']);
  assert.deepEqual([view.brainstorm.notes[0].x, view.brainstorm.notes[0].y], [900, 0]);
  assert.equal(view.brainstorm.topics[0].text, 'Magic system');
  assert.deepEqual(Object.keys(view.brainstorm.topics[0]), ['id', 'text', 'x', 'y', 'w', 'h']);
  assert.deepEqual([view.brainstorm.topics[0].x, view.brainstorm.topics[0].y], [900, 300]);
  assert.deepEqual(view.flowchart, { nodes: [], connections: [] });
  assert.ok(view.recent_history.length <= 10);
  assert.deepEqual(Object.keys(view.recent_history[0]), ['seq', 'author', 'summary', 'at']);
}));

test('adding something close to a ruled-out idea warns Claude', () => withServer(async ({ call, userOp }) => {
  await userOp({ type: 'ruleOut', target: { kind: 'idea' }, text: 'Wizards cast fireballs and damage spells', reason: 'too flashy' });
  const group = await call('add_group', { title: 'Wizards' });
  assert.equal(group.warning, undefined);
  const added = await call('add_entry', { group_id: group.id, label: 'Fireballs', text: 'wizards cast fireball spells' });
  assert.match(added.resembles_ruled_out[0].text, /fireballs/);
  assert.equal(added.resembles_ruled_out[0].reason, 'too flashy');
  assert.deepEqual(Object.keys(added.resembles_ruled_out[0]), ['id', 'text', 'reason']);
  assert.equal(added.warning, 'This resembles something the user ruled out. Remove it, or tell the user it was ruled out before and why.');
  // The op still went through.
  const view = await call('view_board', {});
  assert.deepEqual(view.brainstorm.groups[0].entries.map((e) => e.label), ['Fireballs']);

  const note = await call('add_note', { text: 'wizards cast fireballs, damage spells' });
  assert.ok(note.resembles_ruled_out);
  const topic = await call('add_topic', { text: 'Fireballs and damage spells for wizards' });
  assert.ok(topic.resembles_ruled_out);
  const card = await call('add_node', { title: 'Damage spells', notes: 'wizards cast fireballs' });
  assert.ok(card.resembles_ruled_out);
  const seeded = await call('add_group', { title: 'Spells', entries: [{ label: 'Fireballs', text: 'wizards damage spells' }] });
  assert.equal(seeded.resembles_ruled_out.length, 1);
  const clean = await call('add_note', { text: 'Potions are brewed from herbs' });
  assert.equal(clean.resembles_ruled_out, undefined);
  assert.equal(clean.warning, undefined);
}));

test('view_picture returns an image block', () => withServer(async ({ rpc, call, store }) => {
  const { asset } = store.assets.ingestBuffer(PNG);
  const { object } = store.apply({ type: 'addObject', kind: 'picture', asset, caption: 'A tiny wizard' }, 'user');
  const reply = await rpc('tools/call', { name: 'view_picture', arguments: { id: object.id } });
  const { content } = reply.result;
  assert.equal(reply.result.isError, undefined);
  assert.deepEqual(content[0], { type: 'text', text: 'A tiny wizard' });
  assert.equal(content[1].type, 'image');
  assert.equal(content[1].mimeType, 'image/png');
  assert.deepEqual(Buffer.from(content[1].data, 'base64'), PNG);
  assert.match((await call('view_picture', { id: 'missing' })).error, /no brainstorm object/);
  const note = await call('add_note', { text: 'not a picture' });
  assert.match((await call('view_picture', { id: note.id })).error, /not a picture/);
}));

test('view_picture prefers the preview and refuses files over 3.75 MB', () => withServer(async ({ rpc, store }) => {
  const { asset } = store.assets.ingestBuffer(PNG);
  const big = Buffer.concat([PNG, Buffer.alloc(3.75 * 1024 * 1024)]);
  const { asset: bigAsset } = store.assets.ingestBuffer(big);
  const { object } = store.apply({ type: 'addObject', kind: 'picture', asset: bigAsset }, 'user');
  const tooBig = (await rpc('tools/call', { name: 'view_picture', arguments: { id: object.id } })).result;
  assert.equal(tooBig.isError, true);
  assert.equal(tooBig.content[0].text, 'Picture too large to view; open the board in a browser once so it can make a preview.');
  store.apply({ type: 'setPicturePreview', id: object.id, preview: asset }, 'user');
  const ok = (await rpc('tools/call', { name: 'view_picture', arguments: { id: object.id } })).result;
  assert.equal(ok.content[1].type, 'image');
  assert.deepEqual(Buffer.from(ok.content[1].data, 'base64'), PNG);
}));

test('pointing context reaches wait_for_chat and the agent prompt', () => withServer(async ({ call, userOp, store }) => {
  const group = await call('add_group', { title: 'Wizards' });
  const context = [{ kind: 'object', id: group.id, label: 'Wizards' }];
  await userOp({ type: 'chat', text: 'what about this?', context });
  const waited = await call('wait_for_chat', { timeout_seconds: 1 });
  assert.deepEqual(waited.messages[0].pointing_at, context);
  const view = await call('view_board', {});
  assert.deepEqual(view.unanswered_chat[0].pointing_at, context);

  const prompt = buildPrompt(store.board.chat.filter((m) => m.role === 'user'));
  assert.ok(prompt.startsWith(`[Pointing at: object “Wizards” (${group.id})]`), prompt);
  assert.ok(prompt.endsWith('what about this?'));
}));

test('buildPrompt joins messages, one pointer line per context entry', () => {
  const messages = [
    { text: 'first' },
    { text: 'second', context: [{ kind: 'entry', id: 'en_1', groupId: 'o_1', label: 'Staves' }, { kind: 'node', id: 'n_1', label: 'Pact' }] },
  ];
  assert.equal(buildPrompt(messages), 'first\n\n[Pointing at: entry “Staves” (en_1)]\n[Pointing at: node “Pact” (n_1)]\nsecond');
});

test('chat context is validated before anything is stored', () => withServer(async ({ userOp, store }) => {
  const pointer = { kind: 'object', id: 'o_1', label: 'x' };
  const bad = [
    [pointer, pointer, pointer, pointer, pointer, pointer],
    'nope',
    [{ kind: 'planet', id: 'o_1', label: 'x' }],
    [{ kind: 'object', label: 'x' }],
    [{ kind: 'object', id: 'o_1' }],
    [null],
  ];
  for (const context of bad) assert.equal((await userOp({ type: 'chat', text: 'hi', context })).status, 400, JSON.stringify(context));
  assert.equal(store.board.chat.length, 0);
  assert.equal((await userOp({ type: 'chat', text: 'ok', context: [pointer, pointer, pointer, pointer, pointer] })).status, 200);
  assert.equal(store.board.chat[0].context.length, 5);
  await userOp({ type: 'chat', text: 'plain' });
  assert.equal('context' in store.board.chat[1], false);
}));

test('undo_reply refuses a turn of the user\'s', () => withServer(async ({ call, userOp, store }) => {
  await userOp({ type: 'addObject', kind: 'note', text: 'mine' });
  const { entries } = await call('get_history', {});
  const row = entries.find((e) => e.author === 'user');
  assert.match((await call('undo_reply', { turn: row.turn })).error, /not one of your replies/);
  assert.equal(store.board.brainstorm.pages[0].objects.length, 1);
}));

test('Claude can undo its own reply and save a version', () => withServer(async ({ call }) => {
  const note = await call('add_note', { text: 'a rash idea' });
  await call('reply', { text: 'Added a note.' });
  const { entries } = await call('get_history', {});
  const row = entries.find((e) => e.author === 'claude' && e.turn);
  assert.match(row.turn, /^t_/);
  const undone = await call('undo_reply', { turn: row.turn });
  assert.equal(undone.undone, 1);
  assert.equal((await call('view_board', {})).brainstorm.notes.length, 0);
  assert.ok(note.id);

  const saved = await call('save_version', { name: 'Good point' });
  const { versions } = await call('list_versions', {});
  assert.ok(versions.some((v) => v.id === saved.version.id && v.name === 'Good point' && v.author === 'claude'));
  assert.match((await call('save_version', { name: '  ' })).error, /name/);
  assert.match((await call('restore_version', { id: 'nope' })).error, /no saved version/);
}));

test('Claude can restore a version and export the design doc', () => withServer(async ({ call, store }) => {
  await call('add_note', { text: 'before' });
  const { version } = await call('save_version', { name: 'Checkpoint' });
  await call('add_note', { text: 'after' });
  const restored = await call('restore_version', { id: version.id });
  assert.equal(restored.restored.name, 'Checkpoint');
  assert.equal((await call('view_board', {})).brainstorm.notes.length, 1);
  const exported = await call('export_design_doc', {});
  assert.equal(exported.path, store.paths.design);
  assert.ok(fs.existsSync(exported.path));
}));

test('brainstorm tools edit groups, entries, notes, topics, links and pictures', () => withServer(async ({ call, store }) => {
  const a = await call('add_group', { title: 'Races', color: 'green', entries: [{ label: 'Elves', text: 'tall', check: 'open' }] });
  assert.equal(a.entries[0].label, 'Elves');
  const b = await call('add_group', { title: 'Classes', near: a.id });
  assert.ok(store.board.brainstorm.pages[0].objects.find((o) => o.id === b.id).x > store.board.brainstorm.pages[0].objects.find((o) => o.id === a.id).x);
  await call('update_group', { id: a.id, title: 'Peoples', color: 'amber' });
  const dwarves = await call('add_entry', { group_id: a.id, label: 'Dwarves', text: 'short', check: 'done', index: 0 });
  assert.equal(dwarves.group_id, a.id);
  await call('update_entry', { group_id: a.id, entry_id: dwarves.id, text: 'stout', check: 'open' });
  await call('move_entry', { entry_id: dwarves.id, to_group_id: b.id });
  let view = await call('view_board', {});
  const groups = Object.fromEntries(view.brainstorm.groups.map((g) => [g.id, g]));
  assert.equal(groups[a.id].title, 'Peoples');
  assert.deepEqual(groups[a.id].entries.map((e) => e.label), ['Elves']);
  assert.deepEqual(groups[b.id].entries.map((e) => [e.label, e.text, e.check, e.claude_added]), [['Dwarves', 'stout', 'open', true]]);
  await call('delete_entry', { group_id: b.id, entry_id: dwarves.id });

  const note = await call('add_note', { text: 'remember', color: 'rose', near: a.id });
  await call('update_note', { id: note.id, text: 'remember this', color: 'sky' });
  const topic = await call('add_topic', { text: 'Lore' });
  await call('update_topic', { id: topic.id, text: 'World lore' });
  await call('move_object', { id: note.id, x: 500, y: 40, w: 300 });
  const moved = store.board.brainstorm.pages[0].objects.find((o) => o.id === note.id);
  assert.deepEqual([moved.x, moved.y, moved.w], [500, 40, 300]);

  const link = await call('link', { from: a.id, to: topic.id, label: 'feeds' });
  await call('update_link', { id: link.id, label: 'shapes', dashed: true });
  view = await call('view_board', {});
  assert.deepEqual(view.brainstorm.links, [{ id: link.id, from: a.id, to: topic.id, label: 'shapes', dashed: true }]);
  await call('unlink', { id: link.id });
  await call('delete_object', { id: topic.id });
  view = await call('view_board', {});
  assert.deepEqual(view.brainstorm.links, []);
  assert.deepEqual(view.brainstorm.topics, []);
  assert.deepEqual(view.brainstorm.notes.map((n) => n.text), ['remember this']);
}));

test('brief, memory, flowchart and title tools', () => withServer(async ({ call, store }) => {
  const s1 = await call('add_brief_section', { title: 'Goals', text: 'ship' });
  const s2 = await call('add_brief_section', { title: 'Limits', text: 'none' });
  await call('move_brief_section', { id: s2.id, by: -1 });
  await call('update_brief_section', { id: s1.id, text: 'ship it' });
  assert.deepEqual(store.board.brief.sections.map((s) => s.title), ["What we're building", 'Limits', 'Goals']);
  await call('delete_brief_section', { id: s2.id });

  const card = await call('add_node', { title: 'Pact' });
  const other = await call('add_node', { title: 'Tax', connect_from: card.id });
  assert.match((await call('update_node', { id: card.id, status: 'rejected' })).error, /rule_out|ruleOut/);
  await call('update_node', { id: card.id, status: 'accepted' });
  const out = await call('rule_out', { reason: 'too grindy', target: { kind: 'node', id: other.id } });
  assert.ok(out.id);
  assert.equal(store.board.ruledOut[0].reason, 'too grindy');
  assert.equal((await call('view_board', {})).ruled_out[0].from, 'claude');
  const idea = await call('rule_out', { reason: 'no time', text: 'Live multiplayer' });
  assert.equal(store.board.ruledOut[1].text, 'Live multiplayer');
  assert.match((await call('rule_out', { text: 'no reason given' })).error, /reason/);
  await call('bring_back', { id: idea.id });
  assert.equal(store.board.ruledOut.length, 1);
  await call('bring_back', { id: out.id });
  assert.equal(store.board.flow.nodes.find((n) => n.id === other.id).status, 'idea');

  await call('rename_board', { title: 'Spellbook' });
  assert.equal(store.board.title, 'Spellbook');
  await call('tidy_layout', {});
  await call('disconnect', { from: card.id, to: other.id });
  await call('connect', { from: card.id, to: other.id });
}));

test('Claude can move a card and relabel an existing arrow', () => withServer(async ({ call, store }) => {
  const a = await call('add_node', { title: 'Start' });
  const b = await call('add_node', { title: 'End', connect_from: a.id, edge_label: 'old' });
  const before = { ...store.board.flow.nodes.find((n) => n.id === b.id) };
  await call('update_node', { id: b.id, x: 700, y: 55 });
  const card = store.board.flow.nodes.find((n) => n.id === b.id);
  assert.deepEqual([card.x, card.y], [700, 55]);
  assert.equal(card.updatedAt, before.updatedAt, 'a move is not an edit');
  assert.equal(store.board.flow.nodes.find((n) => n.id === a.id).x, 0);
  const seen = (await call('view_board', {})).flowchart.nodes.find((n) => n.id === b.id);
  assert.deepEqual([seen.x, seen.y], [700, 55]);

  const edgeId = store.board.flow.edges[0].id;
  assert.deepEqual((await call('view_board', {})).flowchart.connections, [{ id: edgeId, from: a.id, to: b.id, label: 'old' }]);
  // connect on an existing pair returns the arrow and keeps its label.
  assert.deepEqual(await call('connect', { from: a.id, to: b.id, label: 'ignored' }), { id: edgeId, from: a.id, to: b.id, label: 'old' });
  assert.deepEqual(await call('update_connection', { from: a.id, to: b.id, label: 'new' }), { id: edgeId, from: a.id, to: b.id, label: 'new' });
  assert.equal(store.board.flow.edges[0].label, 'new');
  assert.equal((await call('update_connection', { from: a.id, to: b.id })).label, '');
  assert.match((await call('update_connection', { from: b.id, to: a.id, label: 'x' })).error, /no connection from .* to /);
}));

test('add_picture_from_url ingests the picture and places it', () => withServer(async ({ call, store }) => {
  const original = store.assets.ingestUrl.bind(store.assets);
  store.assets.ingestUrl = async (url) => {
    assert.equal(url, 'https://example.test/wizard.png');
    return store.assets.ingestBuffer(PNG);
  };
  const near = await call('add_note', { text: 'anchor' });
  const pic = await call('add_picture_from_url', { url: 'https://example.test/wizard.png', caption: 'Wizard', near: near.id });
  store.assets.ingestUrl = original;
  const object = store.board.brainstorm.pages[0].objects.find((o) => o.id === pic.id);
  assert.equal(object.kind, 'picture');
  assert.equal(object.caption, 'Wizard');
  assert.equal(object.claudeAdded, true);
  await call('update_picture', { id: pic.id, caption: 'Old wizard' });
  const [seenPicture] = (await call('view_board', {})).brainstorm.pictures;
  assert.equal(seenPicture.caption, 'Old wizard');
  assert.deepEqual([seenPicture.x, seenPicture.y, seenPicture.w, seenPicture.h], [object.x, object.y, object.w, object.h]);
  assert.match((await call('add_picture_from_url', { url: 'file:///etc/passwd' })).error, /http/);
}));

test('update_entry, delete_entry and rule_out need only the entry id', () => withServer(async ({ call }) => {
  const group = await call('add_group', { title: 'Attacks', entries: [{ label: 'Life Drain' }, { label: 'Bite' }, { label: 'Hex' }] });
  const [drain, bite, hex] = group.entries;
  const updated = await call('update_entry', { entry_id: drain.id, text: 'heals the caster', check: 'open' });
  assert.equal(updated.group_id, group.id);
  assert.equal(updated.text, 'heals the caster');
  // A group_id that does not hold the entry is still an error.
  const other = await call('add_group', { title: 'Other' });
  assert.match((await call('update_entry', { entry_id: drain.id, group_id: other.id, label: 'x' })).error, /no entry/);
  assert.match((await call('update_entry', { entry_id: 'en_nope', label: 'x' })).error, /no entry with id en_nope/);
  assert.match((await call('update_entry', { label: 'x' })).error, /entry_id is required/);
  await call('delete_entry', { entry_id: bite.id });
  const ruled = await call('rule_out', { reason: 'too strong', target: { kind: 'entry', entryId: hex.id } });
  assert.match(ruled.text, /Hex/);
  const [g] = (await call('view_board', {})).brainstorm.groups.filter((x) => x.id === group.id);
  assert.deepEqual(g.entries.map((e) => e.label), ['Life Drain']);
  assert.deepEqual(g.ruled_out_entries.map((e) => e.label), ['Hex']);
}));

test('add_node can be placed with near or x and y', () => withServer(async ({ call, store }) => {
  const a = await call('add_node', { title: 'A' });
  const placed = await call('add_node', { title: 'Placed', x: 900, y: 450 });
  const node = (id) => store.board.flow.nodes.find((n) => n.id === id);
  assert.deepEqual([node(placed.id).x, node(placed.id).y], [900, 450]);
  const beside = await call('add_node', { title: 'Beside', near: placed.id });
  assert.ok(node(beside.id).x > 900 && node(beside.id).y === 450, 'right of the card it is near');
  assert.equal(store.board.flow.edges.length, 0, 'near does not connect');
  // near wins over connect_from for placement; the arrow still comes from connect_from.
  const both = await call('add_node', { title: 'Both', connect_from: a.id, near: placed.id });
  assert.ok(node(both.id).x > 900);
  assert.deepEqual(store.board.flow.edges.map((e) => [e.from, e.to]), [[a.id, both.id]]);
  // An unknown card is refused before anything is added.
  const before = store.board.flow.nodes.length;
  assert.match((await call('add_node', { title: 'Lost', near: 'n_nope' })).error, /no node with id n_nope/);
  assert.match((await call('add_node', { title: 'Lost', connect_from: 'n_nope' })).error, /no node with id n_nope/);
  assert.equal(store.board.flow.nodes.length, before);
}));

test('batch runs calls in order and passes ids along', () => withServer(async ({ call, store }) => {
  const result = await call('batch', { calls: [
    { tool: 'add_group', args: { title: 'Attacks' } },
    { tool: 'add_entry', args: { group_id: '$0.id', label: 'Life Drain', text: 'heals' } },
    { tool: 'update_entry', args: { entry_id: '$1.id', check: 'done' } },
    { tool: 'add_brief_section', args: { title: 'Combat', text: 'Drain heals' } },
    { tool: 'add_node', args: { title: 'Drain', props: { cost: '2' } } },
    { tool: 'update_node', args: { id: '$4.id', notes: 'heals the caster' } },
  ] });
  assert.equal(result.failed, undefined);
  assert.deepEqual(result.results.map((r) => r.tool), ['add_group', 'add_entry', 'update_entry', 'add_brief_section', 'add_node', 'update_node']);
  assert.equal(result.results[2].result.check, 'done');
  const [group] = store.board.brainstorm.pages[0].objects;
  assert.deepEqual(group.entries.map((e) => [e.label, e.check]), [['Life Drain', 'done']]);
  assert.equal(store.board.flow.nodes[0].notes, 'heals the caster');
  // All of it is one reply's worth of changes, so undo_reply takes it back at once.
  const turns = new Set(store.history({ limit: 10 }).entries.map((e) => e.turn));
  assert.equal(turns.size, 1);
}));

test('batch stops at the first error and says what ran', () => withServer(async ({ call, store }) => {
  const result = await call('batch', { calls: [
    { tool: 'add_note', args: { text: 'kept' } },
    { tool: 'update_entry', args: { entry_id: 'en_nope', label: 'x' } },
    { tool: 'add_note', args: { text: 'never' } },
  ] });
  assert.equal(result.results.length, 1);
  assert.deepEqual(result.failed, { index: 1, tool: 'update_entry', error: 'no entry with id en_nope' });
  assert.equal(result.not_run, 1);
  assert.deepEqual(store.board.brainstorm.pages[0].objects.map((o) => o.text), ['kept']);
  assert.match((await call('batch', { calls: [{ tool: 'wait_for_chat', args: {} }] })).failed.error, /can't run inside a batch/);
  assert.match((await call('batch', { calls: [{ tool: 'add_note', args: { text: '$3.id' } }] })).failed.error, /has not run yet/);
  assert.match((await call('batch', { calls: [{ tool: 'add_note', args: { text: 'a' } }, { tool: 'add_note', args: { text: '$0.nope' } }] })).failed.error, /returned no nope/);
  assert.match((await call('batch', { calls: [] })).error, /non-empty/);
}));

test('wait_for_chat reports what the user changed on the board since Claude last looked', () => withServer(async ({ call, userOp }) => {
  const group = await call('add_group', { title: 'Attacks', entries: [{ label: 'Life Drain' }] });
  await call('view_board', {});
  // Claude's own edits are not news to Claude.
  await call('add_note', { text: 'mine' });
  const res = await userOp({ type: 'updateEntry', groupId: group.id, entryId: group.entries[0].id, text: 'now costs health' });
  assert.equal(res.status, 200);
  const waited = await call('wait_for_chat', { timeout_seconds: 1 });
  assert.equal(waited.messages.length, 0);
  assert.equal(waited.board_changes.length, 1);
  assert.match(waited.board_changes[0].summary, /edited “Life Drain” in “?Attacks/);
  assert.ok(waited.board_changes[0].ids.includes(group.entries[0].id));
  assert.match(waited.next, /changed the board/);
  // Seen once, not again.
  const again = await call('wait_for_chat', { timeout_seconds: 1 });
  assert.deepEqual(again.board_changes, []);
  assert.equal(again.next, 'No new messages. Call wait_for_chat again to keep listening.');
}));

test('the tool runner acts as the author it was given, claude by default', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-board-'));
  try {
    const store = new BoardStore(path.join(dir, 'board.json'));
    const id = 'agent:x/y=qa';
    store.board.colab.roster.push({ id, model: 'x/y', roleId: 'qa', name: 'Y · QA', modelName: 'Y', color: 'amber' });
    const authorOf = (groupId) => store.board.brainstorm.pages[0].objects.find((o) => o.id === groupId).author;
    const agent = await createToolRunner(store, null, { author: id }).call('add_group', { title: 'Agent group' });
    assert.equal(authorOf(agent.id), id);
    const claude = await createToolRunner(store, null).call('add_group', { title: 'Claude group' });
    assert.equal(authorOf(claude.id), 'claude');
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});
