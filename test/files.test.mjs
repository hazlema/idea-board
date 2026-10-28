import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileStore, FILE_NAME, MAX_FILE_BYTES, safeName } from '../lib/files.mjs';
import { OpError } from '../lib/board.mjs';

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-board-files-'));
  return { dir: path.join(dir, 'board.files'), files: new FileStore(path.join(dir, 'board.files')), done: () => fs.rmSync(dir, { recursive: true }) };
}

test('safeName keeps letters, digits, dots, dashes and underscores', () => {
  assert.equal(safeName('playtest-3.log'), 'playtest-3.log');
  assert.equal(safeName('Run 3 (final).txt'), 'Run-3-final-.txt');
  assert.equal(safeName('../../etc/passwd'), 'passwd');
  assert.equal(safeName('C:\\logs\\run.log'), 'run.log');
  assert.equal(safeName('.hidden.'), 'hidden');
  assert.equal(safeName('???'), 'attachment');
  assert.ok(safeName(`${'a'.repeat(200)}.log`).length <= 100);
  assert.match(safeName(`${'a'.repeat(200)}.log`), /\.log$/);
  for (const name of ['playtest-3.log', 'Run-3-final-.txt', 'passwd', 'attachment']) assert.match(name, FILE_NAME);
});

test('save stores a text file under its name; the same name twice gets -2, -3', () => {
  const { dir, files, done } = tempStore();
  try {
    assert.equal(fs.existsSync(dir), false);
    assert.equal(files.save('playtest-3.log', Buffer.from('a\nb\n')), 'playtest-3.log');
    assert.equal(files.save('playtest-3.log', Buffer.from('c')), 'playtest-3-2.log');
    assert.equal(files.save('playtest-3.log', Buffer.from('d')), 'playtest-3-3.log');
    assert.equal(files.save('notes', Buffer.from('x')), 'notes');
    assert.equal(files.save('notes', Buffer.from('y')), 'notes-2');
    assert.equal(fs.readFileSync(path.join(dir, 'playtest-3.log'), 'utf8'), 'a\nb\n');
    assert.deepEqual(files.list().map((f) => f.name), ['notes', 'notes-2', 'playtest-3-2.log', 'playtest-3-3.log', 'playtest-3.log']);
    assert.deepEqual(files.list().find((f) => f.name === 'notes'), { name: 'notes', bytes: 1 });
  } finally { done(); }
});

test('save refuses a binary file and one over 10 MB', () => {
  const { dir, files, done } = tempStore();
  try {
    assert.throws(() => files.save('game.exe', Buffer.from([0x4d, 0x5a, 0x00, 0x01])), (e) => e instanceof OpError && /not a text file/.test(e.message));
    assert.throws(() => files.save('big.log', Buffer.alloc(MAX_FILE_BYTES + 1, 0x61)), (e) => e instanceof OpError && /larger than 10 MB/.test(e.message));
    assert.equal(fs.existsSync(dir), false);
  } finally { done(); }
});

test('list is empty before anything is attached', () => {
  const { files, done } = tempStore();
  try { assert.deepEqual(files.list(), []); } finally { done(); }
});

test('read returns lines in chunks and says where to go on', () => {
  const { files, done } = tempStore();
  try {
    const lines = Array.from({ length: 1200 }, (_, i) => `line ${i + 1}`);
    const name = files.save('run.log', Buffer.from(`${lines.join('\n')}\n`));
    const first = files.read(name);
    assert.equal(first.name, 'run.log');
    assert.equal(first.total_lines, 1200);
    assert.equal(first.from_line, 1);
    assert.equal(first.to_line, 500);
    assert.equal(first.text.split('\n')[0], 'line 1');
    assert.equal(first.text.split('\n').at(-1), 'line 500');
    assert.match(first.more, /from_line 501/);
    const last = files.read(name, 1001);
    assert.equal(last.to_line, 1200);
    assert.equal(last.more, undefined);
    assert.throws(() => files.read(name, 1300), (e) => e instanceof OpError && /only 1200 lines/.test(e.message));
  } finally { done(); }
});

test('read stops a chunk at 40,000 characters', () => {
  const { files, done } = tempStore();
  try {
    const long = 'x'.repeat(1000);
    const name = files.save('wide.log', Buffer.from(Array.from({ length: 100 }, () => long).join('\n')));
    const chunk = files.read(name);
    assert.ok(chunk.text.length <= 40000);
    assert.equal(chunk.to_line, 39);
    assert.match(chunk.more, /from_line 40/);
    // A single line longer than a chunk is cut, so a read always moves on.
    const one = files.read(files.save('one.log', Buffer.from('y'.repeat(50000))));
    assert.equal(one.text.length, 40000);
    assert.equal(one.to_line, 1);
  } finally { done(); }
});

test('read refuses names that are not attachments', () => {
  const { files, done } = tempStore();
  try {
    assert.throws(() => files.read('../board.json'), (e) => e instanceof OpError && /not an attachment name/.test(e.message));
    assert.throws(() => files.read('missing.log'), (e) => e instanceof OpError && /no attachment called missing.log/.test(e.message));
  } finally { done(); }
});
