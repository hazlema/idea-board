import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULTS_FILE, PROMPT_NAMES, readDefaults, roleId } from '../lib/defaults.mjs';

const GOOD = {
  shared: 'Be good.',
  roles: { Foreman: 'Run it.', 'QA & Playtester': 'Test it.' },
  chat: 'Chat.',
  turn: 'Turn.',
  answer: 'Answer.',
  audit: 'Audit.',
  prune: 'Prune.',
};

const fixture = (content) => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'idea-board-defaults-')), 'defaults.json');
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  return file;
};

test('the shipped file loads', () => {
  const d = readDefaults(DEFAULTS_FILE);
  assert.deepEqual(d.roles.map((r) => r.id), ['creative', 'qa', 'foreman', 'systems']);
  assert.ok(d.shared.trim());
  assert.deepEqual(Object.keys(d.prompts), PROMPT_NAMES);
  for (const name of PROMPT_NAMES) assert.ok(d.prompts[name].trim(), name);
});

test('a fixture becomes shared, roles with ids, and prompts', () => {
  const d = readDefaults(fixture(GOOD));
  assert.deepEqual(d, {
    shared: 'Be good.',
    roles: [{ id: 'foreman', name: 'Foreman', job: 'Run it.' }, { id: 'qa', name: 'QA & Playtester', job: 'Test it.' }],
    prompts: { chat: 'Chat.', turn: 'Turn.', answer: 'Answer.', audit: 'Audit.', prune: 'Prune.' },
  });
});

test('roleId takes the first word', () => {
  assert.equal(roleId('Creative Director & Lore', new Set()), 'creative');
  assert.equal(roleId('QA & Playtester', new Set()), 'qa');
  assert.equal(roleId('Foreman', new Set()), 'foreman');
  assert.equal(roleId('Art Lead', new Set(['art'])), 'art-2');
  assert.equal(roleId('Art Lead', new Set(['art', 'art-2'])), 'art-3');
  assert.equal(roleId('& !', new Set()), 'role');
});

test('two roles with the same first word get distinct ids', () => {
  const d = readDefaults(fixture({ ...GOOD, roles: { 'Art Director': 'a', 'Art Lead': 'b' } }));
  assert.deepEqual(d.roles.map((r) => r.id), ['art', 'art-2']);
});

test('a BOM is ignored', () => {
  assert.equal(readDefaults(fixture(`\uFEFF${JSON.stringify(GOOD)}`)).shared, 'Be good.');
});

test('readDefaults names the file and the problem', () => {
  const fails = (content, pattern) => {
    const file = typeof content === 'symbol' ? path.join(os.tmpdir(), 'idea-board-no-such', 'defaults.json') : fixture(content);
    assert.throws(() => readDefaults(file), (error) => error.message.startsWith(file) && pattern.test(error.message));
  };
  fails(Symbol('missing'), /can't read it/);
  fails('{', /not valid JSON/);
  const { turn: _turn, ...noTurn } = GOOD;
  fails(noTurn, /turn is missing/);
  fails({ ...GOOD, turns: 'x' }, /unknown key "turns"/);
  fails({ ...GOOD, chat: '  ' }, /chat must not be empty/);
  fails({ ...GOOD, roles: {} }, /roles must list 1 to 20 roles/);
  fails({ ...GOOD, roles: ['x'] }, /roles must list 1 to 20 roles/);
  fails({ ...GOOD, roles: { ['n'.repeat(81)]: 'job' } }, /longer than 80/);
  fails({ ...GOOD, roles: { Foreman: ' ' } }, /must not be empty/);
  fails({ ...GOOD, audit: 'x'.repeat(20001) }, /longer than 20000/);
  fails('[]', /must be an object/);
});
