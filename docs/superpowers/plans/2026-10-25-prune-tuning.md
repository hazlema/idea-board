# Prune Tuning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make pruning strong enough to keep a 20-round run readable. Plain bullets stop being law. Two board settings (mechanics limit, aggressiveness) steer the pruner. New items are protected for one pass. Agents are sent less history and chat.

**Architecture:**
- `lib/prune.mjs`: the guard loses the bullet law, and the pass prompt is built from the board's settings plus a list of new items.
- `lib/board.mjs`: the line-up gains `pruneLimit` and `pruneAggressiveness`; entries and sections get `createdAt`; `colab.lastPruneAt` records when a pass ended.
- `lib/store.mjs` sets `lastPruneAt` with no History entry.
- The Settings dialog gets a Pruning section.
- `view_board` drops `recent_history`, and the chat catch-up becomes 10 messages.

**Tech Stack:** Node 18+ ESM, `node --test`; Svelte 5 + vitest (run from the repo root).

**Spec:** `docs/superpowers/specs/2026-10-25-prune-design.md`, sections from "Revision after the first real run" on. These override the original rules where they differ.

## Global Constraints

- **Law** (refused for prune-tagged ops):
  - accepted cards: title, notes, props, status and deletion;
  - arrows between two accepted cards: add, change, delete;
  - struck-through (`ruledOut`) entries: update, delete, move;
  - any group that holds a struck entry: delete and `ruleOut`;
  - ruled-out records: `bringBack`;
  - pictures: delete and `ruleOut`;
  - the chat;
  - `setTitle`;
  - the existing deny-set of tools and store calls.

  Plain bullets are fair game.
- **Line-up fields:** `pruneLimit` is an integer from 1 to 50, or `null` for no limit; the default is `5`. `pruneAggressiveness` is one of `'gentle' | 'normal' | 'aggressive'`; the default is `'normal'`. Both are optional in `setColabLineup`: when left out, the stored value stays (as `imageModel` does). Migration fills the defaults.
- **`colab.lastPruneAt`:** an ISO string or `null`. It is set by `store.setLastPruneAt(iso)`, with no History entry and no undo step (like `setColabRun`).
- **`createdAt`:** new group entries (`makeEntry`) and new Brief sections (`addSection`) get `createdAt: now()`. Existing items keep none.
- **Chat catch-up:** `turnMessage` uses the last 10 chat messages (it was 40).
- **Copy:** cut mechanics are ruled out with reasons that begin `cut by prune:`.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **An old board with no new fields** (no `pruneLimit`, no `lastPruneAt`, entries without `createdAt`): it loads with defaults, and every item counts as old. Pinned in Task 1.
2. **`pruneLimit` cleared to "no limit" from the page:** it is sent as `null` and stored as `null`, not 5. Pinned in Tasks 1 and 3.
3. **A run mid-pass when Settings change:** the dialog is locked while not idle, as the image model is. Pinned in Task 3.
4. **A group holding a struck entry** still can't be deleted or ruled out once bullets are free. Pinned in Task 2.
5. **The page keeps working** for an agent that relied on `recent_history`: the tool description no longer promises it, and `get_history` is named instead. Pinned in Task 4.

---

### Task 1: Board fields: prune settings, createdAt, lastPruneAt

**Files:** modify `lib/board.mjs`, `lib/brainstorm.mjs` (`makeEntry`) and `lib/store.mjs`. Test in `test/board.test.mjs` and `test/store.test.mjs`.

**Interfaces produced:**
- `board.colab.lineup.pruneLimit`, `board.colab.lineup.pruneAggressiveness`
- `board.colab.lastPruneAt`
- `store.setLastPruneAt(iso: string)`
- `entry.createdAt`, `section.createdAt`

- [ ] **Step 1: Write the failing tests:**
  - **`lineup keeps prune settings`:** `emptyBoard()` has `pruneLimit: 5` and `pruneAggressiveness: 'normal'`. `setColabLineup` with `pruneLimit: 3, pruneAggressiveness: 'aggressive'` stores them, and leaving them out keeps them. `pruneLimit: null` stores `null`. `pruneLimit` set to `0`, `51`, `2.5` or `'5'` throws `OpError`, and so does `pruneAggressiveness: 'wild'`. `migrateBoard` of a lineup with neither field fills `5` and `'normal'`, and keeps an explicit `null`.
  - **`new entries and sections carry createdAt`:** `addEntry`, `addObject` (a group with entries) and `addSection` give each new item an ISO `createdAt`.
  - **`setLastPruneAt saves without history`:** the value is on the board and in the saved file, and the history length is unchanged. `emptyBoard().colab.lastPruneAt === null`, and migration fills `null`.
- [ ] **Step 2:** Run `node --test test/board.test.mjs test/store.test.mjs`. The new tests fail.
- [ ] **Step 3: Implement.**
  - In `setColabLineup`, validate the two fields next to `imageModel`, following its "left out → keep" pattern. `pruneLimit: null` is valid.
  - Make the server's `SYSTEM_OPS` handling unaffected. `setLastPruneAt` mirrors `setColabRun`.
  - Update the page's lineup type in `web/src/lib/types.ts` (`pruneLimit: number | null; pruneAggressiveness: 'gentle' | 'normal' | 'aggressive'`), `colab.lastPruneAt`, and `web/src/test-board.ts`.
  - Update existing tests that deep-equal the lineup.
- [ ] **Step 4:** Run `npm run test:server`, `npm run check` and `npm run lint`. Everything passes.
- [ ] **Step 5: Commit** with the message `feat: prune settings on the line-up, createdAt on entries and sections, lastPruneAt`.

### Task 2: The guard frees bullets; the pass prompt carries the settings and the new items

**Files:** modify `lib/prune.mjs`. Test in `test/prune.test.mjs`, `test/store.test.mjs` and `test/mcp.test.mjs`, wherever the bullet law is asserted.

**Interfaces:**
- **Consumes:** the Task 1 fields.
- **Produces:**
  - `pruneGuard` with the new law;
  - `prunePrompt(store, guidance)` that includes the settings and the new items;
  - `PRUNE_SYSTEM_PROMPT`, rewritten;
  - `Pruner.run` calling `store.setLastPruneAt(new Date().toISOString())` after `endPrune()`, but only when the pass started.

- [ ] **Step 1: Write the failing tests**, and turn the old bullet-law tests into their opposites:
  - **`plain bullets are fair game`:** `updateEntry`, `deleteEntry` and `moveEntry` on a bullet are allowed. So is `addEntry` with no `check`, and so is `updateEntry` with `check: 'none'`. `deleteObject` and `ruleOut` on a group of bullets are allowed. A group holding a struck entry still refuses `deleteObject` and `ruleOut`. A struck entry still refuses update, delete and move.
  - **`the prompt carries the settings and what is new`:** with `pruneLimit: 3` and `'aggressive'`, `prunePrompt` contains `Mechanics limit: 3` and `Aggressiveness: aggressive`. With `pruneLimit: null` it contains `Mechanics limit: none`. With `lastPruneAt` set, an entry and a section created after it are listed under `New since the last pass (don't cut these):` by id, and older ones aren't. With `lastPruneAt: null`, the list reads `New since the last pass: none (this is the first pass)`.
  - **`a finished pass records lastPruneAt; a pass stopped before it starts doesn't`.**
- [ ] **Step 2:** Run `node --test test/prune.test.mjs`. The new tests fail.
- [ ] **Step 3: Implement.**
  - Remove `isBullet`, `lacksCheck`, the `addObject` and `addEntry` guards, and the bullet checks in `guardEntry` and `deleteObject`. Keep the struck-entry checks, and keep `addObject` and `addEntry` allowed (move them to `FREE`).
  - **`prunePrompt`** layout, after the board JSON:

    ```
    Settings for this pass:
    - Mechanics limit: <n | none>
    - Aggressiveness: <gentle | normal | aggressive>

    New since the last pass (don't cut these): <comma-separated "kind id “label”"> | none (this is the first pass) | none
    ```

    Then the guidance line if there is any, then `Prune it now.` New items are objects (groups, notes, topics, pictures), entries, sections and nodes whose `createdAt` is later than `lastPruneAt`.
  - **`PRUNE_SYSTEM_PROMPT`** is exact copy:

```
You are pruning a shared idea board that has grown too big for its collaborators to read. Make it smaller, and keep it focused on the game's best ideas. The whole board is in the prompt, with this pass's settings; change it with the board tools.

First, the mechanics. A mechanic is a distinct system or rule of play (a group, or a cluster of entries, Brief text and cards about one thing). Judge which are most interesting: what the Brief and ticked entries lean on, and what fits the game's core. If there is a mechanics limit, keep at most that many of the established ones; new ones (listed as new since the last pass) don't count toward it and must not be cut yet. Cut each mechanic you drop completely: its groups, entries, notes, Brief text and idea cards. Record each with rule_out, with a reason that starts "cut by prune:" and says what you kept instead.

Then, in this order:
1. Delete exact duplicates.
2. Merge restatements into one place. The settled version wins: usually the Brief, or a ticked entry. Merge into the item that already exists rather than adding a new one, so whoever started the idea keeps the credit.
3. Delete working copies whose content now lives somewhere settled, and flowchart cards still marked "idea" that are covered elsewhere or went nowhere.
4. Notes: for each one, decide whether it is still needed. If not, delete it; if so, shorten it hard.
5. Shorten labels, entry text and Brief sections where the meaning, the numbers and the reasons survive.

How hard to cut depends on the aggressiveness:
- gentle: only steps 1, 2 and 5, plus notes and cards that are plainly dead ends. Don't cut mechanics unless the limit requires it.
- normal: everything above. Cut the weakest mechanics and stale working copies.
- aggressive: keep only what the Brief and the kept mechanics need. Cut anything not pulling its weight and tighten every text you keep.

Items new since the last pass may be merged or shortened, never cut.

Law (the server refuses these, so don't try): struck-through (ruled-out) entries and any group holding one, the ruled-out list (you may add to it), accepted flowchart cards and arrows between two accepted cards, pictures (you may shorten a caption) and the chat.

When you are done, reply with a short summary for the chat. Start with "Kept: …" (the mechanics kept) and "Cut: …" (the mechanics cut), then what you merged and shortened, in a few lines.
```

- [ ] **Step 4:** Run `npm run test:server` and `npm run lint`. Everything passes.
- [ ] **Step 5: Commit** with the message `feat: pruning cuts weak mechanics, bullets are fair game, new items get a pass`.

### Task 3: Settings dialog: a Pruning section

**Files:** modify `web/src/components/SettingsDialog.svelte`. Test in `web/src/components/SettingsDialog.test.ts`.

**Interfaces consumed:** the Task 1 line-up fields. Send them the same way the image model is sent (`setColabLineup` with the board's lineup plus the changed field).

- [ ] **Step 1: Write the failing tests:**
  - **`Pruning: the mechanics limit saves, and clearing it means no limit`:** a number input labelled `Mechanics limit` shows 5. Changing it to 3 sends `pruneLimit: 3`. Clearing it sends `pruneLimit: null`, and the field then shows the placeholder `No limit`. Values outside 1–50 are clamped.
  - **`Pruning: aggressiveness saves`:** a select labelled `Aggressiveness` with options Gentle, Normal and Aggressive (values `gentle`, `normal`, `aggressive`) shows Normal. Choosing Aggressive sends `pruneAggressiveness: 'aggressive'`.
  - **`Pruning is locked while agents run`.**
- [ ] **Step 2:** Run `npx vitest run web/src/components/SettingsDialog.test.ts`. The new tests fail.
- [ ] **Step 3: Implement** a second `<section>` titled `Pruning`, styled like the Pictures section, with the two controls. The help text is exact copy:
  - **Under the limit:** `How many established mechanics a prune keeps; the rest are cut and ruled out. New ones get one pass first.`
  - **Under aggressiveness:** `Gentle: tidy only. Normal: also cut the weakest mechanics. Aggressive: keep only what the Brief and the kept mechanics need.`
- [ ] **Step 4:** Run `npm run test:web`, `npm run check`, `npm run lint` and `npm run build`. Everything passes.
- [ ] **Step 5: Commit** with the message `feat: pruning settings in the Settings dialog`.

### Task 4: Agents get less history and chat; README

**Files:** modify `lib/mcp-tools.mjs` (`boardView` and the `view_board` description), `lib/colab/prompts.mjs` (`turnMessage`) and `README.md`. Test in `test/mcp.test.mjs` and the prompts tests (`test/colab-run.test.mjs`, or wherever `turnMessage` is tested).

- [ ] **Step 1: Write the failing tests:**
  - **`view_board`:** its keys are `['title', 'brief', 'ruled_out', 'brainstorm', 'flowchart', 'unanswered_chat']`, and its description mentions `get_history`.
  - **`turnMessage`:** it includes only the last 10 chat messages. Build a board with 15 messages: the first 5 are absent and the last 10 are present.
- [ ] **Step 2:** Run the focused tests. They fail.
- [ ] **Step 3: Implement.**
  - Remove `recent_history` from `boardView`.
  - In the `view_board` description, replace "recent changes" with "(use get_history for what changed recently)".
  - Change the `slice(-40)` to `slice(-10)`.
  - **README:** in the `/prune` row, add that plain bullets are fair game, and replace "without touching plain bullets, accepted cards, …" with "without touching accepted cards, struck-through entries, pictures, the ruled-out list or the chat". Add a sentence after the table about **⋯ → Settings → Pruning**: the mechanics limit and aggressiveness, plus the fact that new ideas get one pass before they can be cut and that cut mechanics go on the ruled-out list.
- [ ] **Step 4:** Run `npm test`, `npm run lint`, `npm run check` and `npm run build`. Everything passes.
- [ ] **Step 5: Commit** with the message `feat: agents get less history and chat; docs for pruning settings`.
