# Prune by Section Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prune measures the Brief, the Brainstorm and the Flowchart separately and prunes only the sections over 80,000 characters; `/prune` with nothing over asks the host first.

**Architecture:** `lib/prune.mjs` gains section sizes and a section-aware prompt, chat note and still-over warning. `ColabRun` (`lib/colab/run.mjs`) schedules automatic passes per section with a per-section regrow baseline that every pass records. `Room` (`lib/room.mjs`) answers an unneeded `/prune` with a confirmation request, which the chat box (`web/src/components/Chat.svelte`) turns into a `confirm()` popup and resends.

**Tech Stack:** Node 18+ ESM, no runtime deps, `node --test`; Svelte 5 + vitest for the page.

**Spec:** `docs/superpowers/specs/2026-10-27-prune-by-section-design.md`

## Global Constraints

- Section limit: `80_000` characters per section; regrow: `10_000` (existing `PRUNE_REGROW`). Fixed in code, not in Settings.
- Sections, in this order: `brief` ("Brief"), `brainstorm` ("Brainstorm"), `flow` ("Flowchart").
- Sizes: `JSON.stringify(...)`.length of what `view_brief` (its `brief` list only, **not** `ruled_out` or `title`), `view_brainstorm`, and `view_flow` (no full notes) return.
- A section is over when its size is **greater than** the limit.
- Popup text, exact: `Pruning isn't needed: every section is under its limit. Prune anyway?`
- Still-over warning, exact shape: `The Brainstorm is still over its limit (84,000 of 80,000 characters). Raise Aggressiveness under ⋯ → Settings → Pruning and run /prune again.` ("The Brief", "The Brainstorm", "The Flowchart"; numbers with `toLocaleString('en-US')`).
- Size line per pruned section, exact shape: `Brainstorm: 84,000 → 61,000 characters.` These replace today's `Board size: …` line.
- The editable prune text (Edit roles… → Passes) and `PRUNE_SYSTEM_PROMPT` are not changed; the section wording goes in the server-built part of the prompt.
- Unchanged: the law guard, who prunes (Claude via `agent.prune`), the version saved first, Settings → Pruning, "new since the last pass", Stop.
- Run `npm test`, `npm run lint`; after page changes also `npm run check` and `npm run build`. No prettier.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

- A host `/prune` that leaves a section still over: the next round must not auto-prune it (baseline recorded by every pass) — Task 2 test.
- A section pruned by hand back under the limit, then grown over again: it must prune again without waiting for the regrow — Task 2 test.
- A pass stopped before it starts (or that throws): no baseline recorded, no size lines posted — Task 2 test.
- Declining the popup: nothing posted, the typed `/prune …` stays in the box — Task 3 test.
- `/prune <text>` through the popup: the guidance survives the resend — Task 3 test.

---

### Task 1: Section sizes and a section-aware pass

**Files:**
- Modify: `lib/mcp-tools.mjs` (export the three part views)
- Modify: `lib/prune.mjs`
- Test: `test/prune.test.mjs`

**Interfaces:**
- Produces in `lib/mcp-tools.mjs`: `export const briefView = (board) => [...]`, `export function brainstormView(board)`, `export const flowView = (board, fullNotes) => ({ nodes, connections })` (they exist unexported today).
- Produces in `lib/prune.mjs`:
  - `export const SECTION_LIMIT = 80_000;` `export const PRUNE_REGROW = 10_000;` (kept)
  - `export const SECTIONS = ['brief', 'brainstorm', 'flow'];`
  - `export const SECTION_NAMES = { brief: 'Brief', brainstorm: 'Brainstorm', flow: 'Flowchart' };`
  - `export function sectionSizes(store): { brief: number, brainstorm: number, flow: number }`
  - `export const sectionsOver = (sizes) => string[]` — section keys over the limit, in `SECTIONS` order.
  - `prunePrompt(store, guidance = '', sections = SECTIONS)` — `sections` is what the pass works on.
  - `Pruner.run({ guidance, sections, timeoutMs, signal })` → `{ ok, started, sections, before, after }` where `sections` is the list worked on and `before`/`after` are `sectionSizes` results. `sections` omitted (a host `/prune`): chosen when the pass starts (`onStart`) as `sectionsOver(sizes)`, or all of `SECTIONS` when none is over (a whole-board pass).
- Leaves `PRUNE_THRESHOLD` and `boardSize` exported for now (`run.mjs` still uses them); Task 2 deletes them.

- [ ] **Step 1: Write the failing tests** in `test/prune.test.mjs`

```js
test('sectionSizes measures each part as its reading tool shows it, the Brief without ruled_out', () => {
  const { store, cleanup } = prunerStore();
  try {
    store.apply({ type: 'ruleOut', target: { kind: 'idea' }, text: 'x'.repeat(500), reason: 'no' }, 'user');
    const b = store.board;
    assert.deepEqual(sectionSizes(store), {
      brief: JSON.stringify(briefView(b)).length,
      brainstorm: JSON.stringify(brainstormView(b)).length,
      flow: JSON.stringify(flowView(b, false)).length,
    });
    assert.ok(SECTION_LIMIT === 80_000 && PRUNE_REGROW === 10_000);
    assert.deepEqual(sectionsOver({ brief: 80_000, brainstorm: 80_001, flow: 90_000 }), ['brainstorm', 'flow']);
  } finally { cleanup(); }
});

test('the prompt names the sections over the limit and keeps the others to clean-up', () => {
  // prunePrompt(store, '', ['brainstorm']) includes:
  //   a line listing every section's size and the limit 80,000, with "Brainstorm"
  //   "Work on the Brainstorm" (or equivalent naming only the brainstorm)
  //   the clean-up rule: other sections change only to remove pieces of ideas cut there
  // prunePrompt(store, '', SECTIONS) (whole board) says no section is over and the host asked for it, prune the whole board.
  // Still includes the whole board JSON and the settings, as today.
});

test('a section pass posts one size line per section it worked on, and warns when one is still over', async () => {
  // Build the store so the brainstorm is > 80,000 (one group with entries totalling ~85,000 chars of text).
  // Pruner with an agent whose prune() calls onStart, then returns { ok: true, text: 'Kept: A.' }.
  // run({ sections: ['brainstorm'] }) →
  //   result.sections deepEqual ['brainstorm']; result.before/after are sectionSizes objects
  //   last chat text matches /^Kept: A\./
  //   matches /Brainstorm: [\d,]+ → [\d,]+ characters\./ and does not match /Brief:|Flowchart:|Board size/
  //   matches /The Brainstorm is still over its limit \([\d,]+ of 80,000 characters\)\. Raise Aggressiveness under ⋯ → Settings → Pruning and run \/prune again\./
  // A second run where the agent deletes the big group inside prune(): no "still over" sentence.
});

test('a host pass picks its sections when it starts: those over, else the whole board', async () => {
  // run({}) on a small store → result.sections deepEqual SECTIONS; the chat has three size lines (Brief, Brainstorm, Flowchart).
  // run({}) on a store whose brainstorm is over → result.sections deepEqual ['brainstorm'].
  // The prompt the agent receives (call the prompt function it is given) names those sections.
});
```

Write the bodies for the three sketched tests from their comments; the assertions listed are the contract. Update the existing test `a pass saves a version first, guards the law, and posts a summary with the sizes` to expect the size lines (`/Brief: [\d,]+ → [\d,]+ characters\./` on a small store's whole-board pass) instead of `Board size`, and `the prompt carries the whole board and the guidance` keeps passing as is.

- [ ] **Step 2: Run** `node --test test/prune.test.mjs` — Expected: the new tests FAIL (missing exports).

- [ ] **Step 3: Implement** in `lib/mcp-tools.mjs` (exports) and `lib/prune.mjs`: `sectionSizes`, `sectionsOver`, the prompt block (built in `prunePrompt`, after the settings and before the guidance), and in `Pruner.run` the section choice at `onStart`, before/after sizes, the size lines and the still-over sentences (only for sections worked on whose `after` is over). `before` is measured at `onStart`, as today.

- [ ] **Step 4: Run** `npm run test:server` — Expected: all pass.

- [ ] **Step 5: Commit** `feat: prune measures and works on sections`

---

### Task 2: Automatic passes per section, with a per-section baseline

**Files:**
- Modify: `lib/colab/run.mjs` (`#roundPass`, `#runPass`, constructor, `#lastLeft`)
- Modify: `lib/prune.mjs` (delete `PRUNE_THRESHOLD`, `boardSize`)
- Test: `test/colab-run.test.mjs`, `test/prune.test.mjs` (drop the `boardSize` test and imports)

**Interfaces:**
- Consumes: `sectionSizes`, `sectionsOver`, `SECTIONS`, `SECTION_LIMIT`, `PRUNE_REGROW`; `Pruner.run` result `{ started, sections }` from Task 1.
- Produces: `new ColabRun({ ..., sizesOf = sectionSizes })` replacing `sizeOf`; `sizesOf(store)` returns `{ brief, brainstorm, flow }`.

- [ ] **Step 1: Update the test helpers and write the failing tests** in `test/colab-run.test.mjs`
  - `setup({ ..., sizesOf })` passes `sizesOf` through; replace every `sizeOf: () => 0` with `sizesOf: () => SMALL` where `const SMALL = { brief: 0, brainstorm: 0, flow: 0 };`.
  - `fakePruner`'s default `run` returns `{ ok: true, started: true, sections: opts.sections ?? SECTIONS }`.
  - Replace the test `an automatic pass runs between rounds once the board is over the threshold…` with:

```js
test('an automatic pass prunes only the sections over the limit, and each again only after it regrows 10,000', async () => {
  // rounds: 4, one agent. sizesOf returns, per call, from a script; brief/flow stay small unless noted.
  // round 1 end: brainstorm 85_000 → pass with sections ['brainstorm']; after-measure brainstorm 82_000
  // round 2 end: brainstorm 90_000 (< 82_000 + 10_000) → no pass
  // round 3 end: brainstorm 92_000, flow 81_000 → one pass with sections ['brainstorm', 'flow']
  // round 4 end: all small → no pass
  // assert pruner.calls.map((c) => c.sections) deepEqual [['brainstorm'], ['brainstorm', 'flow']]
  // assert pruner.calls[0].guidance === ''
});

test('a host /prune records what it left, so the next round does not prune that section again', async () => {
  // In a run: /prune during round 1 (sizes: brainstorm 85_000 at the pass), pass leaves 82_000 (fakePruner returns sections from opts or ['brainstorm']).
  // Round 2 end: brainstorm 83_000 → no automatic pass. pruner.calls.length === 1.
});

test('a section that dropped under the limit prunes again as soon as it is over', async () => {
  // round 1 end: brainstorm 85_000 → pass, leaves 79_000 (under → baseline cleared at next measure)
  // round 2 end: brainstorm 81_000 → pass (no regrow wait)
});

test('a pass that did not start records nothing', async () => {
  // fakePruner run returns { ok: false, started: false }; next round with the same over size prunes again.
});
```

  Write the bodies from the comments. Make the existing tests that call `run.prune({})` still pass unchanged (the confirmation lives in `Room`, Task 3).

- [ ] **Step 2: Run** `node --test test/colab-run.test.mjs` — Expected: the new tests FAIL.

- [ ] **Step 3: Implement** in `lib/colab/run.mjs`:
  - `#lastLeft = {}` keyed by section.
  - `#roundPass`, when no host pass is waiting: measure `this.sizesOf(this.store)`; drop `#lastLeft[s]` for each section not over; `due = sectionsOver(sizes).filter((s) => this.#lastLeft[s] === undefined || sizes[s] >= this.#lastLeft[s] + PRUNE_REGROW)`; none due → return; else the pass is `{ guidance: '', sections: due, controller, done: null }` (the "Skipped pruning: it needs the claude command." note stays as is).
  - `#runPass` passes `sections: pass.sections` (undefined for a host pass) to `pruner.run`, and when the result has `started !== false` and a `sections` list, records `#lastLeft[s] = this.sizesOf(this.store)[s]` for each — for host and automatic passes alike. Remove the old `if (auto) this.#lastLeft = …`.
  - Import `{ PRUNE_REGROW, sectionSizes, sectionsOver }` instead of `PRUNE_THRESHOLD`/`boardSize`; delete `PRUNE_THRESHOLD` and `boardSize` from `lib/prune.mjs` and from `test/prune.test.mjs`.

- [ ] **Step 4: Run** `npm run test:server` and `npm run lint` — Expected: all pass, no lint errors.

- [ ] **Step 5: Commit** `feat: automatic prune passes run per section`

---

### Task 3: `/prune` asks first when nothing needs pruning

**Files:**
- Modify: `lib/room.mjs` (`userChat`, the `prune` branch)
- Modify: `web/src/lib/live.svelte.ts` (`chat`), `web/src/components/Chat.svelte` (`submit`)
- Modify: `README.md` (the `/prune` row and the Pruning paragraph)
- Test: `test/room.test.mjs`, `web/src/components/Chat.test.ts`

**Interfaces:**
- Consumes: `sectionSizes`, `sectionsOver` from `lib/prune.mjs`.
- Produces:
  - `room.userChat({ text, context, confirmed })`: for `/prune`, when `confirmed !== true` and `sectionsOver(sectionSizes(this.store))` is empty, returns `{ confirm: "Pruning isn't needed: every section is under its limit. Prune anyway?" }` without calling `colab.prune` or posting. Otherwise as today. The op reaches it unchanged through `POST /api/op` (`server.mjs` already passes chat ops to `room.userChat(op)`).
  - `live.chat(text, context?, confirmed?)` → `Promise<{ ok: true } | { error: string } | { confirm: string }>`; sends `{ type: 'chat', text, context, confirmed: true }` only when `confirmed` is true (otherwise the op is exactly as today, so existing `api.op` expectations hold).

- [ ] **Step 1: Write the failing tests**

`test/room.test.mjs` (the room tests' boards are small, so nothing is over):

```js
test('/prune with no section over asks first and posts nothing; confirmed, it runs', () => {
  const a = setup();
  assert.deepEqual(a.room.userChat({ text: '/prune the pirates' }), { confirm: "Pruning isn't needed: every section is under its limit. Prune anyway?" });
  assert.deepEqual(a.calls.prune ?? [], []);
  assert.equal(a.store.board.chat.length, 0);
  a.room.userChat({ text: '/prune the pirates', confirmed: true });
  assert.deepEqual(a.calls.prune, [{ guidance: 'the pirates' }]);
  assert.equal(a.store.board.chat.at(-1).text, 'Prune the board: the pirates');
});

test('/prune with a section over runs without asking', () => {
  // add a group whose entries total > 80,000 characters to a.store, then userChat({ text: '/prune' }) → calls.prune has one call, chat posted.
});
```

Update `/prune starts a pass and posts the request, owing nothing` and `a refused /prune throws and posts nothing` to send `confirmed: true`.

`web/src/components/Chat.test.ts`:

```js
test('an unneeded /prune pops up a confirmation; yes resends it confirmed', async () => {
  // api.op mocked to resolve { confirm: "Pruning isn't needed: every section is under its limit. Prune anyway?" } once, then {}.
  // window.confirm spied → true. typeAndSend('/prune keep lore').
  // expect confirm called with that text; api.op second call deepEqual { type: 'chat', text: '/prune keep lore', context: undefined, confirmed: true }; box empty.
});

test('declining the confirmation keeps the /prune in the box and sends nothing more', async () => {
  // window.confirm → false; api.op called once; input.value === '/prune keep lore'.
});
```

- [ ] **Step 2: Run** `node --test test/room.test.mjs` and `npx vitest run web/src/components/Chat.test.ts` — Expected: the new tests FAIL.

- [ ] **Step 3: Implement** the `Room` branch, `live.chat`'s third argument and `{ confirm }` result (pass through the `confirm` field of `api.chat`'s answer when it is a string), and in `Chat.svelte`'s `submit`: on `{ confirm }`, `window.confirm(sent.confirm)` → resend with `confirmed = true` and handle that result as today; on No, `if (!draft) draft = text`. Update the README `/prune` row: it prunes the sections over 80,000 characters (Brief, Brainstorm, Flowchart, measured separately), asks first when none is, and runs on its own between rounds when a section is over; and the Pruning paragraph: a pass that leaves a section over says so and suggests raising Aggressiveness.

- [ ] **Step 4: Run** `npm test`, `npm run lint`, `npm run check`, `npm run build` — Expected: all pass, 0 errors, build OK.

- [ ] **Step 5: Commit** `feat: /prune asks first when nothing needs pruning`
