import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OpError } from '../lib/board.mjs';
import { emptyBoard } from '../lib/board.mjs';
import { Library, configDir, defaultLibrary } from '../lib/colab/library.mjs';
import { defaults } from '../lib/defaults.mjs';
import { stripSelfTag, systemPrompt, turnMessage } from '../lib/colab/prompts.mjs';

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'idea-board-lib-')), 'sub', 'colab.json');
const X = { id: 'agent:x/x=creative', model: 'x/x', roleId: 'creative', name: 'X · Creative', modelName: 'X', color: 'amber' };
const Y = { id: 'agent:x/y=qa', model: 'x/y', roleId: 'qa', name: 'Y · QA', modelName: 'Y', color: 'blue' };

test('a role can carry the picture permission', () => {
  const lib = new Library(tmpFile());
  lib.save({ rules: '', roles: [{ id: 'a', name: 'A', job: 'j', pictures: true }, { id: 'b', name: 'B', job: 'j', pictures: false }] });
  const { roles } = lib.get();
  assert.equal(roles[0].pictures, true);
  assert.ok(!('pictures' in roles[1]));
  assert.throws(() => lib.save({ rules: '', roles: [{ id: 'a', name: 'A', job: 'j', pictures: 'yes' }] }), /pictures must be true or false/);
});

test('configDir follows each platform', () => {
  assert.equal(configDir('linux', { XDG_CONFIG_HOME: '/x' }, '/h'), '/x');
  assert.equal(configDir('linux', {}, '/h'), '/h/.config');
  assert.equal(configDir('darwin', {}, '/h'), '/h/Library/Application Support');
  assert.equal(configDir('win32', { APPDATA: 'C:\\A' }, 'C:\\h'), 'C:\\A');
});

test('a missing library file is created from the defaults', () => {
  const file = tmpFile();
  const lib = new Library(file).get();
  assert.deepEqual(lib, defaultLibrary());
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), defaultLibrary());
  assert.deepEqual(lib.roles.map((r) => r.id), ['creative', 'qa', 'foreman', 'systems']);
  assert.equal(lib.rules, defaults().shared);
  assert.deepEqual(lib.prompts, defaults().prompts);
});

test('an old library file is filled and keeps what it had', () => {
  const file = tmpFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const roles = [{ id: 'new-role', name: 'Art Director', job: 'Draw.', pictures: true }];
  fs.writeFileSync(file, JSON.stringify({ rules: 'Old.', roles, passes: { audit: 'Mine.' } }));
  const lib = new Library(file).get();
  const { chat, turn, answer, prune } = defaults().prompts;
  assert.deepEqual(lib, { rules: 'Old.', roles, prompts: { chat, turn, answer, audit: 'Mine.', prune } });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), lib);
});

test('a full library file is left byte-for-byte alone', () => {
  const file = tmpFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const full = { ...defaultLibrary(), prompts: { ...defaults().prompts, turn: 'My turn rules.' } };
  fs.writeFileSync(file, JSON.stringify(full));
  const bytes = fs.readFileSync(file, 'utf8');
  const library = new Library(file);
  library.get();
  assert.equal(library.get().prompts.turn, 'My turn rules.');
  assert.equal(fs.readFileSync(file, 'utf8'), bytes);
});

test('bad prompt values are replaced', () => {
  const file = tmpFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ rules: '', roles: [{ id: 'a', name: 'A', job: 'j' }], prompts: { chat: 5, other: 'x' } }));
  const { prompts } = new Library(file).get();
  assert.equal(prompts.chat, defaults().prompts.chat);
  assert.ok(!('other' in prompts));
});

test('save round-trips and rejects bad input', () => {
  const library = new Library(tmpFile());
  const next = { rules: 'Be nice.', roles: [{ id: 'a-1', name: 'A', job: 'Do a.' }], prompts: { ...defaults().prompts, chat: 'Hi.' } };
  assert.deepEqual(library.save(next), next);
  assert.deepEqual(library.get(), next);
  assert.throws(() => library.save({ rules: '', roles: [] }), OpError);
  const dup = { id: 'a', name: 'A', job: '' };
  assert.throws(() => library.save({ rules: '', roles: [dup, dup] }), OpError);
  assert.throws(() => library.save({ rules: '', roles: [{ id: 'Bad Id', name: 'A', job: '' }] }), OpError);
  assert.throws(() => library.save({ rules: 'x'.repeat(20001), roles: [dup] }), OpError);
  assert.deepEqual(library.get(), next);
});

test('systemPrompt names the agent, the others, the job and the rules', () => {
  const prompt = systemPrompt({ me: Y, others: [X], job: 'Find the holes.', rules: 'Rule one.' });
  for (const part of ['Y · QA', 'X · Creative', 'Your role: Find the holes.', 'Rule one.', 'How to play your turn']) assert.ok(prompt.includes(part), part);
});

test('turnMessage shows the host and the agents by name', () => {
  const board = emptyBoard();
  board.colab = { roster: [Y] };
  board.chat.push({ id: 'm1', role: 'user', text: 'Go.', at: '' }, { id: 'm2', role: Y.id, text: 'Done.', at: '' });
  const text = turnMessage(board, X);
  assert.ok(text.startsWith('The chat so far:\n\n'));
  assert.ok(text.includes('Host: Go.\n\nY · QA: Done.'));
  assert.ok(text.endsWith('It is your turn, X · Creative.'));
});

test('turnMessage keeps only the last 10 messages', () => {
  const board = emptyBoard();
  for (let i = 0; i < 15; i += 1) board.chat.push({ id: `m${i}`, role: 'user', text: `msg${i}`, at: '' });
  const text = turnMessage(board, X);
  assert.ok(!text.includes('msg4\n') && text.includes('Host: msg5\n') && text.includes('Host: msg14\n'));
});

test('stripSelfTag drops only a tag naming this agent', () => {
  assert.equal(stripSelfTag('**Y · QA:** Hi', 'Y · QA'), 'Hi');
  assert.equal(stripSelfTag('Idea: hi', 'Y · QA'), 'Idea: hi');
  assert.equal(stripSelfTag('**X · Creative:** Hi', 'Y · QA'), '**X · Creative:** Hi');
});

test('the turn rules say the final reply is posted for the agent', async () => {
  const { TURN_RULES } = await import('../lib/colab/prompts.mjs');
  assert.match(TURN_RULES, /no tool call/);
});

test('a blank prompt is refilled', () => {
  const lib = new Library(tmpFile());
  const saved = lib.save({ ...defaultLibrary(), prompts: { ...defaults().prompts, turn: '  ' } });
  assert.equal(saved.prompts.turn, defaults().prompts.turn);
});

test('save keeps prompts and checks them', () => {
  const lib = new Library(tmpFile());
  const roles = [{ id: 'a', name: 'A', job: 'j' }];
  assert.equal(lib.save({ rules: '', roles, prompts: { audit: 'Check X' } }).prompts.audit, 'Check X');
  assert.equal(lib.get().prompts.audit, 'Check X');
  assert.equal(lib.save({ rules: '', roles }).prompts.audit, 'Check X');
  assert.throws(() => lib.save({ rules: '', roles, prompts: { other: 'x' } }), OpError);
  assert.throws(() => lib.save({ rules: '', roles, prompts: { constructor: 'x' } }), OpError);
  assert.throws(() => lib.save({ rules: '', roles, prompts: { turn: 'x'.repeat(20001) } }), OpError);
  assert.throws(() => lib.save({ rules: '', roles, prompts: { turn: 5 } }), OpError);
  assert.throws(() => lib.save({ rules: '', roles, prompts: 'x' }), OpError);
});

test("a request step reads as the foreman's request, approved by the host", () => {
  const board = emptyBoard();
  board.colab = { roster: [X, Y], claudeName: 'Claude · Foreman' };
  board.chat.push({ id: 'm1', role: 'user', text: 'Check the numbers.', at: '', to: [Y.id], owed: [Y.id], request: { by: 'claude', step: 1, of: 2 } });
  assert.ok(turnMessage(board, Y).includes("Host (to Y · QA), passing on Claude · Foreman's request, which the host approved: Check the numbers."));
});
