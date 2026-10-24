import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyOp, emptyBoard } from '../lib/board.mjs';
import { renderDesignDoc } from '../lib/export.mjs';
import { BoardStore } from '../lib/store.mjs';

function sampleBoard() {
  const b = emptyBoard('Wizard game');
  b.title = 'Wizard game';
  const g = applyOp(b, {
    type: 'addObject', kind: 'group', title: 'Wizards', x: 0, y: 0,
    entries: [
      { label: 'Familiars', text: 'a pet\nthat helps', check: 'done' },
      { label: 'Magic', text: 'schools of spells', check: 'open' },
      { label: 'Towers', text: 'home bases' },
      { label: 'Fireballs', text: 'damage spells' },
    ],
  }, 'user').object;
  applyOp(b, { type: 'ruleOut', target: { kind: 'entry', groupId: g.id, entryId: g.entries[3].id }, reason: 'not damage dealers' }, 'user');
  const guess = applyOp(b, { type: 'addEntry', groupId: g.id, label: 'Mana', text: 'a resource' }, 'claude');
  assert.ok(guess, 'claude entry added');
  const n = applyOp(b, { type: 'addObject', kind: 'note', text: 'first line\nsecond line', near: g.id }, 'user').object;
  applyOp(b, { type: 'addObject', kind: 'note', text: 'another note', near: g.id }, 'user');
  applyOp(b, { type: 'addObject', kind: 'picture', asset: `${'a'.repeat(32)}.png`, caption: 'Tower sketch', near: g.id }, 'user');
  applyOp(b, { type: 'addLink', from: g.id, to: n.id, label: 'see' }, 'user');
  applyOp(b, { type: 'addLink', from: n.id, to: g.id }, 'user');
  applyOp(b, { type: 'addSection', title: 'Goal', text: 'A small game.' }, 'user');
  applyOp(b, { type: 'addSection', title: 'Empty one' }, 'user');
  const a = applyOp(b, { type: 'addNode', title: 'Start', notes: 'begin here\nmore', status: 'accepted', x: 0, y: 0 }, 'user').node;
  const c = applyOp(b, { type: 'addNode', title: 'Finish', status: 'accepted', x: 0, y: 0 }, 'user').node;
  const idea = applyOp(b, { type: 'addNode', title: 'Maybe', x: 0, y: 0 }, 'user').node;
  applyOp(b, { type: 'addEdge', from: a.id, to: c.id, label: 'then' }, 'user');
  applyOp(b, { type: 'addEdge', from: a.id, to: idea.id, label: 'hidden' }, 'user');
  return b;
}

const render = (b) => renderDesignDoc(b, { assetsDirName: 'game.assets', date: '2026-10-22' });

test('design doc lists agreed, undecided and plain entries, and the ruled-out list', () => {
  const md = render(sampleBoard());
  assert.match(md, /^# Wizard game\n\n_Exported 2026-10-22 from idea board\._\n/);
  assert.match(md, /- \[x\] \*\*Familiars:\*\* a pet that helps\n/);
  assert.match(md, /- \[ \] \*\*Magic:\*\* /);
  assert.match(md, /^- \*\*Towers:\*\* /m);
  assert.match(md, /## Flowchart/);
  assert.doesNotMatch(md, /### Wizards[\s\S]*Fireballs[\s\S]*## Flowchart/);
  const wizards = md.slice(md.indexOf('### Wizards'));
  assert.doesNotMatch(wizards.slice(0, wizards.search(/\n###? (?!Wizards)/)), /Fireballs/);
  assert.match(md, /## Ruled out\n\n- \*\*Fireballs: .*\*\*: "not damage dealers" \(You, \d{4}-\d{2}-\d{2}, from Wizards\)/);
});

test('design doc has the exact sections for the rest of the board', () => {
  const md = render(sampleBoard());
  assert.match(md, /- \*\*Mana:\*\* a resource _\(Claude added, not reviewed\)_\n/);
  assert.match(md, /### Notes\n\n> first line\n> second line\n\n> another note\n/);
  assert.match(md, /### Pictures\n\n\*\*Tower sketch\*\* · You\n\n!\[Tower sketch\]\(<game\.assets\/a{32}\.png>\)\n/);
  assert.match(md, /### Links\n\n- Wizards → first line \(see\)\n- first line → Wizards\n/);
  assert.match(md, /### Goal\n\nA small game\.\n\n### Empty one\n\n## Brainstorm/);
  assert.match(md, /### Accepted cards\n\n- \*\*Start\*\*: begin here\n- \*\*Finish\*\*\n/);
  assert.match(md, /### Connections\n\n- Start → Finish \(then\)\n\n## Ruled out/);
  assert.doesNotMatch(md, /Maybe|hidden/);
});

test('a Claude-added group is marked, and empty sections are omitted', () => {
  const b = emptyBoard('Plain');
  b.brief.sections = [];
  applyOp(b, { type: 'addObject', kind: 'group', title: 'Ideas', x: 0, y: 0, entries: [{ label: 'One' }] }, 'claude');
  const md = render(b);
  assert.match(md, /### Ideas _\(Claude added, not reviewed\)_\n\n- \*\*One:\*\*\n/);
  for (const heading of ['## Brief', '### Notes', '### Pictures', '### Links', '## Flowchart', '## Ruled out']) assert.doesNotMatch(md, new RegExp(heading));
});

test('a ruled-out record without a reason has no quoted reason', () => {
  const b = emptyBoard('R');
  const n = applyOp(b, { type: 'addNode', title: 'Card', x: 0, y: 0 }, 'user').node;
  applyOp(b, { type: 'ruleOut', target: { kind: 'node', id: n.id } }, 'claude');
  assert.match(render(b), /## Ruled out\n\n- \*\*Card\*\* \(Claude, \d{4}-\d{2}-\d{2}, from Card\)\n$/);
});

test('exportDesignDoc writes the design file beside the board', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-board-'));
  const store = new BoardStore(path.join(dir, 'game.json'));
  store.apply({ type: 'setTitle', title: 'Exported' }, 'user');
  const file = store.exportDesignDoc();
  assert.equal(file, path.join(dir, 'game.design.md'));
  const md = fs.readFileSync(file, 'utf8');
  assert.match(md, /^# Exported\n\n_Exported \d{4}-\d{2}-\d{2} from idea board\._\n/);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), []);
  fs.rmSync(dir, { recursive: true });
});

test('pictures are embedded as images, with who made them and a safe caption', () => {
  const b = emptyBoard('Art');
  applyOp(b, { type: 'addObject', kind: 'picture', asset: `${'b'.repeat(32)}.png`, caption: 'Comp [01]\nJewelbox' }, 'claude');
  applyOp(b, { type: 'addObject', kind: 'picture', asset: `${'c'.repeat(32)}.webp` }, 'user');
  const md = renderDesignDoc(b, { assetsDirName: 'my board.assets', date: '2026-10-24' });
  assert.match(md, /\*\*Comp \[01\] Jewelbox\*\* · Claude _\(Claude added, not reviewed\)_\n\n!\[Comp \\\[01\\\] Jewelbox\]\(<my board\.assets\/b{32}\.png>\)\n/);
  assert.match(md, /\*\*Picture\*\* · You\n\n!\[Picture\]\(<my board\.assets\/c{32}\.webp>\)\n/);
});
