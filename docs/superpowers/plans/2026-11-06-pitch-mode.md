# Pitch Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/pitch [how many] [guidance]` chat command that has one agent add twist pitches (`toy : where it lives`) to a Pitches group, and make the host's plain bullets locked against every AI edit.

**Architecture:** The lock is a flag set by the Brainstorm ops when the host makes an entry a plain bullet, and a guard in `BoardStore.apply` that refuses AI ops touching a locked entry, at all times. `/pitch` reuses the audit machinery in `lib/colab/run.mjs` (one fresh agent session, its own system prompt, same tool list and Stop handling) with a new `pitch` library prompt and a `lib/pitch.mjs` for its texts.

**Tech Stack:** Node ESM (`node:test`), Svelte 5 + TypeScript (vitest) for the web.

**Spec:** `docs/superpowers/specs/2026-11-06-pitch-mode-design.md`

## Global Constraints

- The lock gesture is the existing "Remove checkbox" (`check: 'none'`). No new UI control.
- An entry is locked only when the **host** (author `'user'`) made it a plain bullet: by removing its checkbox, or by adding it without one. Entries an AI author made plain stay editable.
- Locked entries: no AI author may `updateEntry`, `deleteEntry`, `moveEntry`, `ruleOut` it, or `deleteObject` its group. This holds on every AI op, including prune and audit passes.
- Existing boards: entries without the flag are not locked (no migration sets it).
- Pitch label format: `toy : where it lives`. Group title: `Pitches`.
- `/pitch` with no number asks for 5. Count range 1–50.
- `/pitch` only adds pitches; it never edits or removes entries.
- Placement kinds (verbatim, in the `pitch` prompt): a person in the game; a machine in the setting; chance the player can see; the setting itself; the player's own action.
- No random seeds anywhere.
- Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

- An agent `batch` that mixes allowed ops with one touching a locked entry: the refused call reports the lock message naming the entry (batch applies call by call through `store.apply`; Task 1 adds a test in `test/mcp.test.mjs` running `batch` with an `update_entry` on a locked entry and asserting that call's error matches /locked/).
- The host unlocking by adding a checkbox back: the entry becomes editable by agents again (Task 1 test).
- An agent setting `check: 'none'` on its own entry must not lock it, and an agent cannot "re-lock" or unlock a host entry (Task 1 tests).
- `/pitch` while a run is going or an audit is going: refused with a clear message, nothing posted (Task 2 and Task 3 tests).
- `/pitch 0`, `/pitch 99`, `/pitch abc`: a number out of range is an error; a non-number first word is guidance with the default count (Task 2 tests).

---

### Task 1: The host's plain bullets are locked

**Files:**
- Modify: `lib/brainstorm.mjs` (`makeEntry` ~114, `updateEntry` ~248)
- Create: `lib/locks.mjs`
- Modify: `lib/store.mjs` (`apply` ~126)
- Modify: `lib/mcp-tools.mjs:72` (entries in `brainstormView` show `locked`)
- Modify: `defaults.json` (`shared`: one rule line)
- Modify: `web/src/lib/types.ts` (`Entry` gets `locked?: boolean`)
- Test: `test/locks.test.mjs` (new), `test/store.test.mjs`, `test/mcp.test.mjs` (the batch case from Review Focus)

**Interfaces:**
- Produces: entry field `locked: boolean` (present on new entries). `lockGuard(board, op): void` in `lib/locks.mjs`, throws `OpError`. `BoardStore.apply` calls it for every op whose author `isAi(author)`.

- [ ] **Step 1: Write the failing tests** in `test/locks.test.mjs`

```js
test('the host adding a plain bullet locks it; with a checkbox it does not', () => {
  // applyOp addObject group as 'user' with entries [{label:'Fact'},{label:'Box',check:'open'}]
  assert.equal(fact.locked, true); assert.equal(box.locked, false);
});
test('the host removing a checkbox locks; adding one back unlocks', () => {
  // updateEntry {check:'none'} by 'user' -> locked true; {check:'open'} by 'user' -> locked false
});
test('an AI author making its own entry plain does not lock it', () => {
  // addEntry by 'claude' without check -> locked false; updateEntry check:'none' by 'claude' -> still false
});
test('lockGuard refuses every AI op that touches a locked entry', () => {
  for (const op of [
    { type: 'updateEntry', groupId, entryId, text: 'x' },
    { type: 'updateEntry', groupId, entryId, check: 'open' },
    { type: 'deleteEntry', groupId, entryId },
    { type: 'moveEntry', entryId, toGroupId: other.id },
    { type: 'ruleOut', target: { kind: 'entry', groupId, entryId }, reason: 'no' },
    { type: 'deleteObject', id: groupId },
  ]) assert.throws(() => lockGuard(b, op), (e) => e instanceof OpError && /locked/.test(e.message) && e.message.includes('Fact'));
});
test('lockGuard allows ops on unlocked entries and adding entries to a group with a locked one', () => {
  // updateEntry on box, addEntry to the same group: doesNotThrow
});
```

In `test/store.test.mjs`:

```js
test('the store refuses an AI edit to a locked entry and leaves the board unchanged', () => {
  // store.apply(updateEntry text 'x') by 'claude' throws OpError /locked/; entry text unchanged; version unchanged
  // the same op by 'user' succeeds
});
test('the lock holds during a prune pass too', () => {
  // beginPrune(token); store.apply(deleteEntry on locked, 'claude', { prune: token }) throws /locked/
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test test/locks.test.mjs test/store.test.mjs`
Expected: FAIL (`lib/locks.mjs` missing; `locked` undefined).

- [ ] **Step 3: Set the flag in `lib/brainstorm.mjs`**

`makeEntry`: `locked: !isAi(author) && check === 'none'` (compute `check` once). `updateEntry`: when `fields.check !== undefined && !isAi(author)`, set `entry.locked = fields.check === 'none'`. AI authors never change `locked`.

- [ ] **Step 4: Write `lockGuard(board, op)` in `lib/locks.mjs`**

Finds the target entry for `updateEntry`/`deleteEntry` (`groupId`+`entryId`), `moveEntry` (`entryId`, any group), `ruleOut` with `target.kind === 'entry'`; for `deleteObject` of a group, the first locked entry in it. If the entry has `locked === true`, throw `OpError(`"${entry.label}" is locked by the host: build on it, don't change it`)`. A missing target returns silently (the op itself reports it). Every other op type passes.

- [ ] **Step 5: Call it in `BoardStore.apply`**

Inside `#atomically`, before `applyOp`: `if (isAi(author)) lockGuard(this.board, op);` (before the prune guard, so the lock message wins).

- [ ] **Step 6: Show it to agents**

`brainstormView` entries gain `locked: e.locked === true`. Add to `defaults.json` `shared`, under "Editing the board": `- Entries marked locked are the host's decisions. Build on them; never change, move or remove them.`

- [ ] **Step 7: Run the server suite**

Run: `npm run test:server`
Expected: PASS. Tests elsewhere that had an AI author edit or prune-delete a host-made plain bullet now fail by design: change those fixtures to give the entry a checkbox (or make the AI the author) so they keep testing what they meant to; don't weaken the guard.

- [ ] **Step 8: Commit**

```bash
git add lib/brainstorm.mjs lib/locks.mjs lib/store.mjs lib/mcp-tools.mjs defaults.json web/src/lib/types.ts test/
git commit -m "feat: the host's plain bullets are locked against every agent edit"
```

### Task 2: `/pitch` parses and reaches the run

**Files:**
- Modify: `lib/commands.mjs` (hint strings :5, :7; new `case 'pitch'`)
- Modify: `lib/room.mjs` (`userChat`, beside `/audit` ~84)
- Modify: `web/src/components/Chat.svelte:22` (hint)
- Test: `test/commands.test.mjs`, `test/room.test.mjs`

**Interfaces:**
- Produces: `parseCommand('/pitch …')` → `{ kind: 'pitch', count: number, text: string }`. Room calls `this.colab.pitch({ count, guidance })`, expecting `{ ok: true, by }` or `{ error }` (Task 3 implements it).

- [ ] **Step 1: Write the failing tests**

`test/commands.test.mjs`:

```js
test('/pitch takes an optional count and guidance', () => {
  assert.deepEqual(parseCommand('/pitch'), { kind: 'pitch', count: 5, text: '' });
  assert.deepEqual(parseCommand('/pitch 20'), { kind: 'pitch', count: 20, text: '' });
  assert.deepEqual(parseCommand('/pitch 10 more like the heckler'), { kind: 'pitch', count: 10, text: 'more like the heckler' });
  assert.deepEqual(parseCommand('/pitch more like the heckler'), { kind: 'pitch', count: 5, text: 'more like the heckler' });
});
test('/pitch refuses a count out of range', () => {
  for (const t of ['/pitch 0', '/pitch 51']) assert.deepEqual(parseCommand(t), { kind: 'error', error: 'Ask for 1 to 50 pitches: /pitch 20' });
});
```

Update the hint and unknown-command assertions to include `/pitch` after `/audit`: hint `'/chat N (or /c N) · /r · /start · /stop · /prune · /audit · /pitch · /design_wiki'`.

`test/room.test.mjs` (fake colab gets `pitch: (o) => { calls.pitch.push(o); return calls.pitchResult ?? { ok: true, by: 'Claude' }; }`):

```js
test('/pitch starts a pass and posts the request, owing nothing', () => {
  // userChat({ text: '/pitch 20 funnier' }) -> calls.pitch == [{ count: 20, guidance: 'funnier' }]
  // last chat: role user, text 'Pitch 20 twists: funnier', owed []
  // '/pitch' -> text 'Pitch 5 twists.'
});
test('a refused /pitch throws an OpError and posts nothing', () => { /* pitchResult = { error: 'X' } */ });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test test/commands.test.mjs test/room.test.mjs`
Expected: FAIL (unknown command /pitch).

- [ ] **Step 3: Implement**

`case 'pitch'`: if the first word is all digits, it is the count (must be 1–50, else the error above) and the rest is the text; otherwise count 5 and all of `args` is the text. Room: mirror the `/audit` branch; post `Pitch ${count} twists: ${guidance}` or `Pitch ${count} twists.`

- [ ] **Step 4: Run them to verify they pass**

Run: `node --test test/commands.test.mjs test/room.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/commands.mjs lib/room.mjs web/src/components/Chat.svelte test/commands.test.mjs test/room.test.mjs
git commit -m "feat: /pitch in the chat"
```

### Task 3: The pitch pass

**Files:**
- Create: `lib/pitch.mjs`
- Modify: `lib/colab/run.mjs` (beside `audit()` ~432, `#startAudit`, `#runAudit`, `#claudeAudit`, `#auditMessages`, `#takeTurn` mode handling)
- Modify: `lib/defaults.mjs:7` (`PROMPT_NAMES` gets `'pitch'`), `defaults.json` (new `pitch` key)
- Modify: `web/src/lib/types.ts` (`Prompts.pitch`), `web/src/colab/colab.svelte.ts:10` (empty `pitch: ''`)
- Modify: `README.md` (one paragraph under the ways to use the board)
- Test: `test/colab-run.test.mjs`, `test/defaults.test.mjs`, `test/pitch.test.mjs` (new)

**Interfaces:**
- Consumes: room calls `colab.pitch({ count, guidance })` (Task 2).
- Produces: `ColabRun.pitch({ count = 5, guidance = '' }) → { ok: true, by: string } | { error: string }`. `lib/pitch.mjs` exports `PITCH_FRAME: string`, `pitchSystemPrompt(text: string): string`, `pitchPrompt({ count, guidance = '', snapshot = null }): string`.

- [ ] **Step 1: Write the failing tests**

`test/pitch.test.mjs`:

```js
test('pitchPrompt asks for the count, names the group and the format, and carries guidance', () => {
  const p = pitchPrompt({ count: 20, guidance: 'funnier' });
  assert.match(p, /20 pitches/); assert.match(p, /"Pitches"/); assert.match(p, /toy : where it lives/); assert.match(p, /funnier/);
});
test('the default pitch prompt names every placement kind', () => {
  for (const k of ['a person in the game', 'a machine in the setting', 'chance the player can see', 'the setting itself', "the player's own action"]) assert.ok(defaults().prompts.pitch.includes(k), k);
});
```

`test/defaults.test.mjs`: add `pitch: 'Pitch.'` to the GOOD fixture and expected prompts.

`test/colab-run.test.mjs` (reuse `auditingClaude`, `setup`):

```js
test('/pitch by Claude runs a fresh session with the pitch prompts', async () => {
  // run.pitch({ count: 20, guidance: 'x' }) -> { ok: true, by: 'Claude' }; await quiet
  // claude.calls[0].p matches /20 pitches/; calls[0].o.systemPrompt starts with PITCH_FRAME; Claude's reply posted
});
test('/pitch prefers the first card that can answer, in a fresh conversation', async () => {
  // with agents [A], the card's first message system content starts with PITCH_FRAME; tools exclude AUDIT_DENIED
});
test('/pitch is refused during a run and while an audit or pitch is going', () => {
  // state running -> { error: 'Wait for the run to end, then /pitch.' }; second pitch while first going -> { error: 'An audit or pitch is already going.' }
});
test('Stop cuts a pitch short', async () => { /* mirrors 'Stop during the final audit cuts it short' */ });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test test/pitch.test.mjs test/defaults.test.mjs test/colab-run.test.mjs`
Expected: FAIL

- [ ] **Step 3: Write `lib/pitch.mjs`**, shaped like `lib/audit.mjs`

`PITCH_FRAME`: `'You are pitching twists for a shared idea board. Add your pitches to the board with your tools; never change or remove entries that are already there. Your final reply is posted to the chat.'` `pitchPrompt`: `Add ${count} pitches to the group titled "Pitches" on the Brainstorm tab (create it if it doesn't exist). Label each one "toy : where it lives".` plus guidance and snapshot as `auditPrompt` does.

- [ ] **Step 4: Add the `pitch` library prompt** to `defaults.json` and `PROMPT_NAMES`

Text (copy exactly):

> Read the Brief, the Flowchart and the Brainstorm first. A pitch is a twist: a toy (something fun to do or see before any rules) and where it lives in the game, meaning how it reaches the player. Before you pitch, think of the most obvious twists for this game, the ones anyone would make (a card drawn between turns, a power-up pickup), and don't pitch those. Spread your pitches across these places a twist can live, using each about equally: a person in the game (a dealer calls it out, a heckler yells it, an officer reacts); a machine in the setting (a slot machine's dials, a vending machine, a radio); chance the player can see (dice, a wheel, a card in the deck); the setting itself (the lights, the weather, a phone ringing, time running out); the player's own action (the twist comes out of something the player does). Every pitch must fit this game's story and tone. Label each pitch "toy : where it lives", with a sentence or two of text saying what the toy is and how it reaches the player. Give each a checkbox (open). Don't add mechanics or rules beyond the pitch. Reply in chat with one line: how many pitches you added.

- [ ] **Step 5: Implement `ColabRun.pitch` in `lib/colab/run.mjs`**

Reuse the `#audit` slot and its Stop/emit handling: generalise `#startAudit(id, focus)` to `#startPass(id, job)` where `job = { kind: 'audit', focus } | { kind: 'pitch', count, guidance }`, and have `#runAudit`, `#claudeAudit` and `#auditMessages` pick `pitchSystemPrompt(library.prompts.pitch)` / `pitchPrompt(...)` when `job.kind === 'pitch'` (busy activity `'pitching twists'`). Claude goes through the existing `claude.audit(...)` (a fresh session on the audit tool list). Who pitches (`#pitcher()`): the first card in the lineup that is not muted and `canAnswer`, else Claude when `claude.found` and not muted, else `{ error: 'No one can pitch: connect an agent, or install the claude command.' }`. Refusals: `state !== 'idle'` → `'Wait for the run to end, then /pitch.'`; `#audit` set → `'An audit or pitch is already going.'`; change the audit's own busy message to the same shared text.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS

- [ ] **Step 7: README**

Under "There are several ways to use the board", add **Pitching twists**: after a first `/start`, `/pitch 20` adds twist pitches to a Pitches group, each `toy : where it lives`; remove the checkbox on the ones you keep (that locks them), then `/start` again to build around them. Add `/pitch` wherever the README lists the commands.

- [ ] **Step 8: Commit**

```bash
git add lib/pitch.mjs lib/colab/run.mjs lib/defaults.mjs defaults.json web/src/lib/types.ts web/src/colab/colab.svelte.ts README.md test/
git commit -m "feat: /pitch has one agent pitch twists to a Pitches group"
```
