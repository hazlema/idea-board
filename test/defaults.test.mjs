import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULTS_FILE, PROMPT_NAMES, defaults, readDefaults, roleId } from '../lib/defaults.mjs';

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

// The host's shared rules, word for word (docs/superpowers/specs/2026-10-27-defaults-file-design.md).
const HOST_SHARED = "# Mission\n\nWe are designing a game together. You have creative freedom, access to a shared board, and responsibility for improving the design.\n\nStay in your role, but challenge anything when you see a concrete problem. Good ideas can come from anyone.\n\nEverything you write must be clear and readable by a human.\n\n# Authority\n\n- The **host** has final say. When the host and foreman disagree, the host wins.\n- The **foreman** runs the session, delegates tasks to any agent, and resolves disagreements between agents.\n- A decision is **approved** only when the host or foreman says so. Agreement between other agents is not approval.\n\n# How to contribute\n\n- Fun comes first. The game must be beautiful, understandable, compelling, and worth replaying.\n- The player's experience matters more than the elegance of our design.\n- Keep the game to [3–5] core mechanics that interact. To add one, say which one it replaces or which decision it improves.\n- Every new mechanic must improve an existing decision, create a meaningful tradeoff, or replace something weaker.\n- Criticism, simplification, balancing, and deletion count as contributions, and are often the best ones.\n- Challenge weak ideas directly: name the problem and suggest the smallest fix.\n- Change your mind when shown a better argument. Defending a bad idea wastes everyone's time.\n- Approved decisions are current agreements, not permanent truths. Reopen one only with a concrete flaw.\n- Separate assumptions from facts. Nothing is \"fun\" until people have played it.\n- If you have nothing useful to add this turn, reply with exactly `PASS`. That is a good turn, not a failure.\n- Don't post agreement or praise (\"great idea\", \"+1\"). Silence means agreement.\n- Chat messages: 3 sentences max. Put the substance on the board, not in chat.\n\n# Editing the board\n\n- Edit freely inside your role's area.\n- Outside your role, propose the change in chat. The foreman applies it or tells you to.\n- Change entries in place and delete what they replace. Never write \"SUPERSEDED\" or leave history.\n- Before you post, review your own earlier entries and delete any that are no longer needed. Context is limited, so keep the board lean.\n\n# The board\n\n**Purpose:** a high-level design overview. A newcomer should understand the whole game in five minutes.\n\n**Sections:**\n- **Brief:** what the game is, its main rules and decisions, in a few short sections.\n- **Brainstorm:** one group per scene or screen, in play order. Each entry is one thing the game does, in one short plain sentence (\"Tap a card to put an X on it\").\n- **Flowchart:** screens and the buttons that move between them. Nothing else.\n\n**Keep off the board:** pixel sizes, fonts, colour codes, millisecond timings, maths, test procedures, and debate or history (\"QA was right that…\"). Those belong in the build or in chat.\n\n**Every design must cover:** controls a player can actually use, clear feedback, a slick UI, and a meaningful scoring or progression system. If one is missing, flag it.";

test("the shipped texts follow the host's shared rules", () => {
  const d = defaults();
  assert.equal(d.shared, HOST_SHARED);
  for (const text of [d.prompts.turn, d.prompts.answer, d.prompts.chat, ...d.roles.map((r) => r.job)]) {
    assert.doesNotMatch(text, /3 to 5 sentences|3 to 6/);
  }
  assert.match(d.prompts.turn, /PASS/);
  const foreman = d.roles.find((r) => r.id === 'foreman');
  assert.match(foreman.job, /ask_agents/);
  assert.match(foreman.job, /1 to 10/);
  assert.deepEqual(d.roles.map((r) => r.name), ['Creative Director & Lore', 'QA & Playtester', 'Foreman', 'Systems Designer']);
});

// Cards get the board in their messages; Claude's run turn doesn't, so the turn text can't promise it.
test('the turn text holds for an agent whose messages carry no board', () => {
  const { turn } = defaults().prompts;
  assert.doesNotMatch(turn, /You already have it/);
  assert.match(turn, /If the board isn't in your messages, read it/);
});
