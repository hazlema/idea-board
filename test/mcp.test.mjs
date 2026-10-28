import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildPrompt } from '../lib/agent.mjs';
import { createToolRunner } from '../lib/mcp.mjs';
import { BoardStore } from '../lib/store.mjs';
import { withServer } from './helpers.mjs';
import { defaultLibrary } from '../lib/colab/library.mjs';
import { PictureMaker } from '../lib/colab/pictures.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

const V2_TOOLS = [
  'view_brief', 'view_brainstorm', 'view_flow', 'view_chat', 'view_board', 'view_picture', 'get_node', 'get_history', 'list_versions',
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
  assert.equal(init.result.instructions, 'A shared idea board you and the user both edit: Brief (what you are building), Brainstorm (groups, notes, pictures, topics, links) and Flowchart (cards and arrows). Call view_brief first and read ruled_out: never re-propose anything on it; read the rest with view_brainstorm, view_flow and view_chat as you need it; if a tool result flags a resemblance, tell the user. Record rejections the user states with rule_out. You may change anything; every change is visible and undoable. Use batch to make several changes in one call. Use wait_for_chat to listen to the board chat; it also reports what the user changed on the board since you last looked.');
  const { tools } = (await rpc('tools/list', {})).result;
  const names = tools.map((t) => t.name);
  for (const name of V2_TOOLS) assert.ok(names.includes(name), name);
  assert.equal(new Set(names).size, names.length);
  const update = tools.find((t) => t.name === 'update_node');
  assert.deepEqual(update.inputSchema.properties.status.enum, ['idea', 'accepted']);
}));

test('view_board shows memory first and brainstorm content', () => withServer(async ({ rpc, call, userOp }) => {
  const group = (await (await userOp({ type: 'addObject', kind: 'group', title: 'Wizards', entries: [{ label: 'Staves', text: 'focus items', check: 'done' }, { label: 'Fireballs', text: 'big damage' }] })).json()).object;
  const fireballs = group.entries[1];
  await userOp({ type: 'ruleOut', target: { kind: 'entry', groupId: group.id, entryId: fireballs.id }, reason: 'too flashy' });
  await userOp({ type: 'addObject', kind: 'note', text: 'a note', x: 900, y: 0 });
  await userOp({ type: 'addObject', kind: 'topic', text: 'Magic system', x: 900, y: 300 });
  const view = await call('view_board', {});
  assert.deepEqual(Object.keys(view), ['notice', 'title', 'brief', 'ruled_out', 'brainstorm', 'flowchart', 'unanswered_chat']);
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
  const tool = (await rpc('tools/list', {})).result.tools.find((t) => t.name === 'view_board');
  assert.ok(tool.description.includes('view_brief'));
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
  await userOp({ type: 'chat', text: 'what about this?', context, owed: ['claude'] });
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

test('wait_for_chat skips messages not owed by Claude', () => withServer(async ({ call, userOp, store }) => {
  store.apply({ type: 'chat', text: 'not you', owed: [] }, 'user');
  await userOp({ type: 'chat', text: 'you', owed: ['claude'] });
  const waited = await call('wait_for_chat', { timeout_seconds: 1 });
  assert.deepEqual(waited.messages.map((m) => m.text), ['you']);
}));

test('a run turn is offered through wait_for_chat and finished by reply', () => withServer(async ({ call, store, presence }) => {
  const offer = presence.offerTurn('Round 1: your turn', { timeoutMs: 2000 });
  const waited = await call('wait_for_chat', { timeout_seconds: 1 });
  assert.deepEqual(waited.messages, []);
  assert.equal(waited.turn.prompt, 'Round 1: your turn');
  assert.match(waited.next, /It is your turn in the agents' run/);
  const replied = await call('reply', { text: 'did it' });
  assert.equal(replied.turn, 'done');
  assert.equal(await offer, true);
  const last = store.board.chat.at(-1);
  assert.equal(last.role, 'claude');
  assert.equal(last.text, 'did it');
}));

test('a turn offered while the session is already waiting wakes the wait', () => withServer(async ({ call, presence }) => {
  const waiting = call('wait_for_chat', { timeout_seconds: 5 });
  await new Promise((r) => setTimeout(r, 50));
  const offer = presence.offerTurn('now', { timeoutMs: 2000 });
  assert.equal((await waiting).turn.prompt, 'now');
  await call('reply', { text: 'ok' });
  assert.equal(await offer, true);
}));

test('a turn reply does not clear what the user still owes Claude', () => withServer(async ({ call, userOp, store, presence }) => {
  await userOp({ type: 'chat', text: 'question', owed: ['claude'] });
  const offer = presence.offerTurn('go', { timeoutMs: 2000 });
  await call('wait_for_chat', { timeout_seconds: 1 });
  await call('reply', { text: 'turn post' });
  await offer;
  assert.deepEqual(store.board.chat.find((m) => m.role === 'user').owed, ['claude']);
}));

test('an unanswered turn times out', () => withServer(async ({ call, presence }) => {
  assert.equal(await presence.offerTurn('x', { timeoutMs: 100 }), false);
  const replied = await call('reply', { text: 'late' });
  assert.equal('turn' in replied, false);
}));

test('an aborted turn resolves false and a second offer is rejected while one is pending', () => withServer(async ({ presence }) => {
  const controller = new AbortController();
  const offer = presence.offerTurn('x', { timeoutMs: 5000, signal: controller.signal });
  await assert.rejects(async () => presence.offerTurn('y', { timeoutMs: 100 }), /a turn is already offered/);
  controller.abort();
  assert.equal(await offer, false);
}));

test('a turn offered to a session that has gone is settled as detached', () => withServer(async ({ presence }) => {
  // The session's last wait has returned; it is inside its grace period, then gone.
  await presence.waitForChat(10);
  assert.equal(presence.attached(), true);
  const offer = presence.offerTurn('x', { timeoutMs: 5000 });
  const started = Date.now();
  assert.equal(await offer, 'detached');
  assert.ok(Date.now() - started < 1000);
  assert.equal(presence.turn, null);
}, { graceMs: 50 }));

test('your_role appears when set', () => withServer(async ({ call, presence }) => {
  presence.role = () => 'Foreman job';
  const waited = await call('wait_for_chat', { timeout_seconds: 1 });
  assert.equal(waited.your_role, 'Foreman job');
}));

test('a reply before the turn is handed over is an ordinary reply', () => withServer(async ({ call, userOp, store, presence }) => {
  await userOp({ type: 'chat', text: 'question', owed: ['claude'] });
  const offer = presence.offerTurn('go', { timeoutMs: 2000 });
  const replied = await call('reply', { text: 'answer' });
  assert.equal('turn' in replied, false);
  assert.deepEqual(store.board.chat.find((m) => m.role === 'user').owed, []);
  const waited = await call('wait_for_chat', { timeout_seconds: 1 });
  assert.equal(waited.turn.prompt, 'go');
  await call('reply', { text: 'turn' });
  assert.equal(await offer, true);
}));

// A PictureMaker over the server's library with an 'art' role that can make pictures,
// and a fake image model that returns a 1x1 PNG.
const withPictures = (store, library) => {
  library.save({ ...defaultLibrary(), roles: [...defaultLibrary().roles, { id: 'art', name: 'Concept Art', job: 'Draw.', pictures: true }] });
  store.board.colab.lineup.imageModel = 'acme/painter';
  return new PictureMaker({ store, library, openrouter: { image: async () => ({ data: PNG, cost: 0.05 }) } });
};

test("tools/list hides generate_image unless Claude's role can make pictures", () => withServer(async ({ rpc, store }) => {
  const names = async () => (await rpc('tools/list', {})).result.tools.map((t) => t.name);
  store.board.colab.lineup.claudeRoleId = 'qa';
  assert.ok(!(await names()).includes('generate_image'));
  store.board.colab.lineup.claudeRoleId = 'art';
  assert.ok((await names()).includes('generate_image'));
}, { pictures: withPictures }));

test('a refused generate_image adds no picture', () => withServer(async ({ call, store }) => {
  store.board.colab.lineup.claudeRoleId = 'qa';
  const result = await call('generate_image', { prompt: 'a castle' });
  assert.deepEqual(result, { error: 'Only roles that can make pictures can use generate_image.' });
  assert.equal(store.board.brainstorm.pages[0].objects.filter((o) => o.kind === 'picture').length, 0);
  store.board.colab.lineup.claudeRoleId = 'art';
  const made = await call('generate_image', { prompt: 'a castle', caption: 'Castle' });
  assert.equal(made.caption, 'Castle');
  const picture = store.board.brainstorm.pages[0].objects.find((o) => o.id === made.id);
  assert.equal(picture.author, 'claude');
}, { pictures: withPictures }));

test('generate_image without a picture maker says no image model is set, and is not batchable', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-board-'));
  try {
    const store = new BoardStore(path.join(dir, 'board.json'));
    const tools = createToolRunner(store, null);
    await assert.rejects(tools.call('generate_image', { prompt: 'x' }), { message: 'No image model is set; choose one in ⋯ → Settings.' });
    const batch = await tools.call('batch', { calls: [{ tool: 'generate_image', args: { prompt: 'x' } }] });
    assert.equal(batch.failed.error, "generate_image can't run inside a batch");
    store.historyLog.flush();
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test("Claude's spent is announced after generate_image, and a wait_for_chat return resets its picture count", () => withServer(async ({ call, store }) => {
  store.board.colab.lineup.claudeRoleId = 'art';
  const spents = [];
  store.subscribe((event) => event.type === 'colab' && spents.push(event.status.spent));
  await call('generate_image', { prompt: 'a' });
  assert.ok(spents.at(-1) >= 0.05);
  await call('generate_image', { prompt: 'b' });
  assert.match((await call('generate_image', { prompt: 'c' })).error, /Picture limit/);
  await call('wait_for_chat', { timeout_seconds: 1 });
  assert.equal((await call('generate_image', { prompt: 'c' })).error, undefined);
}, { pictures: withPictures }));

// A board with a plain bullet, a box and an earlier Claude reply (a plain bullet and a
// ruled-out record), and a version from before all of it.
function lawBoard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-board-'));
  const store = new BoardStore(path.join(dir, 'board.json'));
  const version = store.saveVersion('empty', 'user');
  const { object } = store.apply({ type: 'addObject', kind: 'group', title: 'G', x: 0, y: 0, entries: [{ label: 'Plain law' }, { label: 'Box', check: 'open' }] }, 'user');
  store.apply({ type: 'addEntry', groupId: object.id, label: 'Agent fact' }, 'claude');
  store.apply({ type: 'ruleOut', target: { kind: 'idea' }, text: 'no lasers', reason: 'r' }, 'claude');
  const turn = store.historyLog.entries().at(-1).turn;
  store.apply({ type: 'chat', text: 'done', answers: [] }, 'claude');
  return { dir, store, version, object, turn, cleanup: () => { store.historyLog.flush(); fs.rmSync(dir, { recursive: true }); } };
}

test("the prune pass's runner can't undo, save, restore or reach its denied tools, alone or in a batch", async () => {
  const { store, version, turn, cleanup } = lawBoard();
  try {
    const prune = store.beginPrune();
    const tools = createToolRunner(store, null, { prune });
    const snapshot = JSON.stringify(store.board);
    const versions = store.versions.list().length;
    for (const [tool, args] of [['undo_reply', { turn }], ['restore_version', { id: version.id }], ['save_version', { name: 'n' }], ['rename_board', { title: 't' }], ['add_picture_from_url', { url: 'http://127.0.0.1:1/x.png' }], ['reply', { text: 'hi' }]]) {
      await assert.rejects(tools.call(tool, args), new RegExp(`${tool} isn't allowed during a prune`));
      const batch = await tools.call('batch', { calls: [{ tool, args }] });
      assert.deepEqual(batch.results, [], tool);
      assert.match(batch.failed.error, /isn't allowed during a prune/, tool);
    }
    assert.equal(JSON.stringify(store.board), snapshot);
    assert.equal(store.versions.list().length, versions);
    store.endPrune();
  } finally { cleanup(); }
});

test("the prune pass's runner is guarded by the law and keeps credit", async () => {
  const { store, object, cleanup } = lawBoard();
  try {
    const prune = store.beginPrune();
    const tools = createToolRunner(store, null, { prune });
    const [plain, box] = object.entries;
    store.apply({ type: 'ruleOut', target: { kind: 'entry', groupId: object.id, entryId: plain.id }, reason: 'no' }, 'user');
    await assert.rejects(tools.call('delete_entry', { entry_id: plain.id }), /ruled-out entries are law/);
    const batch = await tools.call('batch', { calls: [{ tool: 'delete_entry', args: { entry_id: plain.id } }] });
    assert.match(batch.failed.error, /ruled-out entries are law/);
    const credit = (e) => ({ author: e.author, updatedBy: e.updatedBy });
    const group = store.board.brainstorm.pages[0].objects[0];
    const was = credit(group.entries.find((e) => e.id === box.id));
    await tools.call('update_entry', { entry_id: box.id, label: 'Short' });
    const now = group.entries.find((e) => e.id === box.id);
    assert.equal(now.label, 'Short');
    assert.deepEqual(credit(now), was);
    assert.notEqual(was.author ?? was.updatedBy, 'claude');
    assert.equal(group.entries.find((e) => e.id === plain.id).label, 'Plain law');
    store.endPrune();
  } finally { cleanup(); }
});

test('while a pass runs, any other runner can read but not change the board', async () => {
  const { store, object, turn, cleanup } = lawBoard();
  try {
    store.beginPrune();
    const session = createToolRunner(store, null);
    const snapshot = JSON.stringify(store.board);
    const held = /a prune is running; try again when it finishes/;
    await assert.rejects(session.call('add_note', { text: 'x' }), held);
    await assert.rejects(session.call('undo_reply', { turn }), held);
    await assert.rejects(session.call('reply', { text: 'hi' }), held);
    const batch = await session.call('batch', { calls: [{ tool: 'view_board' }, { tool: 'undo_reply', args: { turn } }] });
    assert.equal(batch.results.length, 1);
    assert.match(batch.failed.error, held);
    assert.equal(JSON.stringify(store.board), snapshot);
    assert.equal((await session.call('view_board')).title, store.board.title);
    assert.ok(await session.call('get_history'));
    store.endPrune();
    await session.call('add_note', { text: 'after' });
    assert.ok(store.board.brainstorm.pages[0].objects.some((o) => o.text === 'after'));
    assert.ok(object);
  } finally { cleanup(); }
});

test('a host message sent during a pass is handed to the waiting session once the pass ends', () => withServer(async ({ call, userOp, store }) => {
  store.beginPrune();
  const wait = call('wait_for_chat', { timeout_seconds: 5 });
  await userOp({ type: 'chat', text: 'during the prune' });
  let got = null;
  wait.then((r) => { got = r; });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(got, null);
  store.endPrune();
  const result = await wait;
  assert.deepEqual(result.messages.map((m) => m.text), ['during the prune']);
}));

test('/mcp?prune=<token> is the pass: guarded, tagged and without its denied tools; plain /mcp is held', () => withServer(async ({ base, call, store }) => {
  const { object } = store.apply({ type: 'addObject', kind: 'group', title: 'G', x: 0, y: 0, entries: [{ label: 'Plain' }, { label: 'Box', check: 'open' }] }, 'user');
  const token = store.beginPrune();
  const pruneRpc = async (method, params, t = token) => {
    const res = await fetch(`${base}/mcp?prune=${t}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    return (await res.json()).result;
  };
  const names = (await pruneRpc('tools/list')).tools.map((t) => t.name);
  for (const denied of ['reply', 'undo_reply', 'wait_for_chat', 'save_version', 'restore_version', 'rename_board', 'add_picture_from_url', 'generate_image']) assert.ok(!names.includes(denied), denied);
  assert.ok(names.includes('batch') && names.includes('view_board'));
  store.apply({ type: 'ruleOut', target: { kind: 'entry', groupId: object.id, entryId: object.entries[0].id }, reason: 'no' }, 'user');
  const refused = await pruneRpc('tools/call', { name: 'delete_entry', arguments: { entry_id: object.entries[0].id } });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /ruled-out entries are law/);
  const ok = await pruneRpc('tools/call', { name: 'update_entry', arguments: { entry_id: object.entries[1].id, label: 'B' } });
  assert.ok(!ok.isError);
  const stale = await pruneRpc('tools/call', { name: 'add_note', arguments: { text: 'x' } }, 'not-the-token');
  assert.match(stale.content[0].text, /this prune pass has ended/);
  assert.match((await call('add_note', { text: 'x' })).error, /a prune is running/);
  store.endPrune();
}));

test("a read-only runner reads but can't change the board", () => withServer(async ({ store }) => {
  const tools = createToolRunner(store, null, { readOnly: true });
  await tools.call('view_board', {});
  const before = JSON.stringify(store.board);
  await assert.rejects(tools.call('add_group', { title: 'x' }), /isn't allowed during an audit/);
  const batch = await tools.call('batch', { calls: [{ tool: 'view_board' }, { tool: 'add_group', args: { title: 'x' } }] });
  assert.equal(batch.failed.index, 1);
  assert.match(batch.failed.error, /isn't allowed during an audit/);
  assert.equal(JSON.stringify(store.board), before);
}));

test('ask_agents reaches the requests object as the caller', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-board-ask-'));
  const store = new BoardStore(path.join(dir, 'board.json'));
  const asked = [];
  const requests = { ask: (author, steps) => { asked.push([author, steps]); return { waiting: true, id: 'r_1' }; } };
  const steps = [{ agent: 'qa', request: 'check it' }];
  const result = await createToolRunner(store, null, { requests }).call('ask_agents', { steps });
  assert.deepEqual(asked, [['claude', steps]]);
  assert.equal(result.waiting, true);
  assert.equal(result.id, 'r_1');
  assert.match(result.next, /approve/);
  await assert.rejects(createToolRunner(store, null).call('ask_agents', { steps }), /Requests are not available here\./);
  await assert.rejects(createToolRunner(store, null, { requests, readOnly: true }).call('ask_agents', { steps }), /isn't allowed during an audit/);
  await assert.rejects(createToolRunner(store, null, { requests, prune: 'tok' }).call('ask_agents', { steps }), /isn't allowed during a prune/);
  const batch = await createToolRunner(store, null, { requests }).call('batch', { calls: [{ tool: 'ask_agents', args: { steps } }] });
  assert.match(batch.failed.error, /can't run inside a batch/);
  assert.equal(asked.length, 1);
  store.historyLog.flush();
  fs.rmSync(dir, { recursive: true });
});

test('the tool list hides ask_agents unless Claude is the foreman', () => withServer(async ({ rpc, store }) => {
  const names = async () => (await rpc('tools/list', {})).result.tools.map((t) => t.name);
  assert.ok((await names()).includes('ask_agents'));
  store.board.colab.lineup.claudeRoleId = 'qa';
  assert.ok(!(await names()).includes('ask_agents'));
}));

test("the binary's prompt says a request step is the foreman's, approved by the host", () => {
  const board = { colab: { roster: [], claudeName: 'Claude' } };
  const card = { id: 'agent:x=foreman', name: 'X · Foreman' };
  board.colab.roster.push(card);
  const prompt = buildPrompt([{ id: 'm1', role: 'user', text: 'rework the saves', request: { by: card.id, step: 1, of: 1 } }], board);
  assert.equal(prompt, "[X · Foreman's request, approved by the host]\nrework the saves");
});

test("a session's reply doesn't answer a foreman's request step it was never handed", () => withServer(async ({ call, store, presence }) => {
  const { message: asked } = store.apply({ type: 'chat', text: 'plain question', owed: ['claude'] }, 'user');
  presence.delivered.add(asked.id);
  const { message: step } = store.apply({ type: 'chat', text: 'step', to: ['claude'], owed: ['claude'], request: { by: 'claude', step: 1, of: 1 } }, 'user');
  await call('reply', { text: 'answered the plain one' });
  assert.deepEqual(store.board.chat.find((m) => m.id === asked.id).owed, []);
  assert.deepEqual(store.board.chat.find((m) => m.id === step.id).owed, ['claude']);
  presence.delivered.add(step.id);
  await call('reply', { text: 'now the step' });
  assert.deepEqual(store.board.chat.find((m) => m.id === step.id).owed, []);
}));
