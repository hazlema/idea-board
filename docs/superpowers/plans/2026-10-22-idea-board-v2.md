# Idea Board v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a free-form Brainstorm view, a Ruled-out memory, history with undo and saved versions, pictures, pointing, and design-doc export to the idea board, and rebuild the page in Svelte.

**Architecture:** The zero-dependency Node server stays the single source of truth: every change is an op applied by `lib/` modules, written atomically to the board JSON, diffed into an append-only history log, and broadcast over SSE. Claude reaches the same ops through the hand-rolled MCP endpoint. The browser is a Vite-built Svelte 5 single-page app served from `dist/`; it only sends ops and renders the board it receives.

**Tech Stack:** Node ≥ 18 (`node:test`, `node:http`, no runtime packages); Svelte 5 (runes) + TypeScript (strict) + Tailwind CSS 4 + Vite + ESLint; Vitest + @testing-library/svelte + jsdom for front-end tests.

**Spec:** `docs/superpowers/specs/2026-10-22-idea-board-v2-design.md` (read it before starting any task).

## Global Constraints

- Server has **zero runtime dependencies**: `package.json` `"dependencies"` stays absent or empty; Svelte/Vite/Tailwind/test tools are `devDependencies` only.
- Node 18+. Server listens on `127.0.0.1` only; the v1 Host and Origin checks in `server.mjs` stay unchanged.
- Board file stays human-readable JSON (2-space indent, trailing newline), written atomically (tmp + rename) as in v1.
- Files beside the board, where `<base>` is the board path without its `.json` extension: `<base>.assets/`, `<base>.versions/`, `<base>.history.jsonl`, `<base>.design.md`.
- Pictures: png, jpeg, gif, webp only (no SVG); 30 MB maximum (`30 * 1024 * 1024` bytes); stored as files, never inlined in the board JSON; assets are never deleted in v2.
- v1 board files (top-level `nodes`/`edges`, no `schema`) must load with nothing lost.
- Background Claude keeps `--tools ""`, `--strict-mcp-config`, board MCP only.
- Front end follows `~/Dev/bun3/artboard2/AGENTS.md`: Svelte 5 runes (`$state`, `$props`, `$derived`, snippets), TypeScript strict, Tailwind 4, PascalCase components, `$lib`-style imports via the `$lib` alias pointing at `web/src/lib`.
- Neutral, non-game-specific defaults and UI copy (the tool is general purpose).
- Exact UI copy: tabs `Brief`, `Brainstorm`, `Flowchart`; `Claude added`; `Keep`; `Dismiss…`; prompt `Why not?`; panel `Memory` with tabs `Ruled out` and `History`; `Bring back`; `Undo this reply`; `★ Save version`; `Preview`; `Restore`; `All changes saved`; chip `Talking about: <label>` with `×`; folded list `<N> ruled out`; `+ add item`.
- Run `npm test` (server + web) green at the end of every task.

## Review Focus

1. **Claude edits the group you are typing in.** An SSE update arriving while an entry's text field has focus must not overwrite or drop what you are typing; other fields update. Pinned in Task 13.
2. **Bad picture input** (a 40 MB file, a PDF renamed `.png`, a URL that returns an HTML page, a URL that never answers): a clear error message and nothing added or broken. Pinned in Task 7.
3. **A v1 board with chat and a Claude session id** loads into v2 with flowchart, brief, chat and session intact. Pinned in Task 2.
4. **Undo after the server restarts** still works, from the history file. Pinned in Task 5.
5. **Undoing a deleted object brings back its links too**, and undoing a Claude reply after you edited one of its items skips that item and says so. Pinned in Task 5.

---

## File structure

Server (`.mjs`, plain JS, zero deps):

| File | Responsibility |
|---|---|
| `lib/paths.mjs` (new) | `boardPaths(file)` → all sibling paths |
| `lib/board.mjs` (modify) | Board shape, `migrateBoard`, validation helpers, `applyOp` dispatch, flow/brief/chat ops, `tidyLayout` |
| `lib/brainstorm.mjs` (new) | Brainstorm objects, entries, links, `placeObject` |
| `lib/memory.mjs` (new) | `ruleOut` / `bringBack` ops, `enforceRuledOut`, `findRuledOutMatches` |
| `lib/history.mjs` (new) | `diffContent`, `applyChanges`, `describeOp`, `HistoryLog` |
| `lib/versions.mjs` (new) | `VersionStore` |
| `lib/assets.mjs` (new) | `AssetStore`: sniff, ingest buffer/URL, serve |
| `lib/export.mjs` (new) | `renderDesignDoc` |
| `lib/store.mjs` (new; `BoardStore` moves here from `board.mjs`) | Load/save, apply + history + turns, undo/redo/undoTurn, versions, events |
| `lib/mcp.mjs` (modify) | v2 tool set, image results, guard warnings |
| `lib/agent.mjs` (modify) | v2 prompt, pointing context |
| `server.mjs` (modify) | New endpoints, serve `dist/` and `/assets/` |

Front end (`web/`, built to `dist/`):

| File | Responsibility |
|---|---|
| `vite.config.ts`, `tsconfig.json`, `eslint.config.js`, `svelte.config.js` (root) | Build, types, lint, test config |
| `web/index.html`, `web/src/main.ts`, `web/src/app.css` | Entry |
| `web/src/App.svelte` | Top bar, tabs, panels layout, chat dock |
| `web/src/lib/types.ts` | Board types mirroring the server |
| `web/src/lib/api.ts` | HTTP calls |
| `web/src/lib/live.svelte.ts` | SSE board state, agent/presence, flash, pointing, save status |
| `web/src/lib/geometry.ts` | Pan/zoom math, `linkPath`, `flowAnchors` |
| `web/src/lib/pictures.ts` | Preview downscaling, paste/drop helpers |
| `web/src/lib/actions.ts` | `drag` and `resize` Svelte actions |
| `web/src/components/*.svelte` | TopBar, ChatDock, Canvas, Toast |
| `web/src/views/BriefView.svelte` | Brief tab |
| `web/src/views/FlowchartView.svelte` + `web/src/flow/*.svelte` | Flowchart tab |
| `web/src/views/BrainstormView.svelte` + `web/src/brainstorm/*.svelte` | Brainstorm tab |
| `web/src/memory/*.svelte` | Memory panel |

Shared board shape (server JSON = `web/src/lib/types.ts`):

```ts
type Author = 'user' | 'claude';
type Check = 'none' | 'open' | 'done';
interface Board {
  schema: 2; version: number; title: string;
  brief: { sections: Section[] };
  flow: { nodes: FlowNode[]; edges: FlowEdge[] };              // v1 node/edge shapes unchanged
  brainstorm: { pages: Page[] };                               // v2 always one page, id 'p_main'
  ruledOut: RuledOut[]; chat: ChatMessage[]; claudeSessionId: string | null;
}
interface Page { id: string; name: string; objects: BObject[]; links: BLink[] }
interface Base { id: string; x: number; y: number; w: number; h: number; author: Author; claudeAdded: boolean; createdAt: string; updatedAt: string; updatedBy: Author }
interface Group extends Base { kind: 'group'; title: string; color: Color; entries: Entry[] }
interface Note extends Base { kind: 'note'; text: string; color: Color }
interface Picture extends Base { kind: 'picture'; asset: string; preview: string | null; caption: string }
interface Topic extends Base { kind: 'topic'; text: string }
type BObject = Group | Note | Picture | Topic;
interface Entry { id: string; label: string; text: string; check: Check; ruledOut: boolean; author: Author; claudeAdded: boolean }
interface BLink { id: string; from: string; to: string; label: string; dashed: boolean; author: Author }
type Color = 'slate' | 'violet' | 'green' | 'amber' | 'rose' | 'sky';
interface RuledOut { id: string; text: string; reason: string; by: Author; at: string;
  source: { view: 'brainstorm' | 'flowchart' | 'chat'; label: string; pageId?: string; objectId?: string; groupId?: string; entryId?: string; nodeId?: string };
  snapshot: unknown | null }
interface ChatMessage { id: string; role: Author; text: string; at: string; handled: boolean; context?: Pointer[] }
interface Pointer { kind: 'object' | 'entry' | 'node' | 'section'; id: string; groupId?: string; label: string }
```

`h: 0` means "auto height"; a positive `h` is a minimum height. `w`/`h` are 0 for topics (size to text).

---

### Task 1: Baseline repository

**Files:**
- Create: `.gitignore` additions (`node_modules/`, `dist/`, `*.tmp`, `.superpowers/`)

- [ ] **Step 1:** In `~/Dev/tools/idea-board`, run `git init`, then `npm test`. Expected: 17 tests pass.
- [ ] **Step 2:** Commit the v1 baseline.

```bash
git add -A && git commit -m "chore: v1 idea board baseline"
```

---

### Task 2: Board model v2 and v1 migration

**Files:**
- Create: `lib/paths.mjs`, `lib/store.mjs`
- Modify: `lib/board.mjs` (board shape, ops now read/write `board.flow.*`; remove `BoardStore`), `lib/mcp.mjs` and `lib/agent.mjs` (references `b.nodes` → `b.flow.nodes`, `b.edges` → `b.flow.edges`), `server.mjs` (import `BoardStore` from `./lib/store.mjs`), `test/board.test.mjs`, `test/server.test.mjs`
- Test: `test/board.test.mjs`, `test/store.test.mjs` (new)

**Interfaces:**
- Produces: `boardPaths(file: string) → { board, base, assets, versions, history, design }` (absolute paths). `emptyBoard(title?) → Board` (schema 2, one page `{ id: 'p_main', name: 'Brainstorm', objects: [], links: [] }`, `ruledOut: []`). `migrateBoard(raw: object) → Board`. `applyOp(board, op, author) → object` unchanged signature. `BoardStore` in `lib/store.mjs`: `new BoardStore(file)`, `.board`, `.file`, `.paths`, `.apply(op, author)`, `.setSessionId(id)`, `.emit(event)`, `.subscribe(fn) → unsubscribe`. Board events: `{ type: 'board', board, op, author, changed: string[] }` (`changed` is now always an array of ids).

- [ ] **Step 1: Write the failing tests**

```js
// test/board.test.mjs (add; update existing tests to read board.flow.nodes / board.flow.edges)
test('new boards use schema 2 with one brainstorm page', () => {
  const b = emptyBoard('X');
  assert.equal(b.schema, 2);
  assert.deepEqual(b.flow, { nodes: [], edges: [] });
  assert.equal(b.brainstorm.pages[0].id, 'p_main');
  assert.deepEqual(b.ruledOut, []);
});

test('migrateBoard turns a v1 board into v2 without losing anything', () => {
  const v1 = { version: 9, title: 'Old', brief: { sections: [{ id: 's_1', title: 'T', text: 'x', updatedBy: 'user', updatedAt: 'a' }] },
    nodes: [{ id: 'n_1', title: 'A', notes: '', props: [], status: 'accepted', author: 'user', x: 0, y: 0 }],
    edges: [{ id: 'e_1', from: 'n_1', to: 'n_1', label: '', author: 'user' }],
    chat: [{ id: 'm_1', role: 'user', text: 'hi', at: 'a', handled: true }], claudeSessionId: 'sess-1' };
  const b = migrateBoard(v1);
  assert.equal(b.schema, 2);
  assert.equal(b.flow.nodes[0].title, 'A');
  assert.equal(b.flow.edges[0].id, 'e_1');
  assert.equal(b.brief.sections[0].text, 'x');
  assert.equal(b.chat[0].text, 'hi');
  assert.equal(b.claudeSessionId, 'sess-1');
  assert.equal(b.version, 9);
  assert.equal('nodes' in b, false);
});
```

```js
// test/store.test.mjs
test('boardPaths derives sibling files from the board path', () => {
  const p = boardPaths('/tmp/x/plans/game.json');
  assert.equal(p.base, '/tmp/x/plans/game');
  assert.equal(p.assets, '/tmp/x/plans/game.assets');
  assert.equal(p.versions, '/tmp/x/plans/game.versions');
  assert.equal(p.history, '/tmp/x/plans/game.history.jsonl');
  assert.equal(p.design, '/tmp/x/plans/game.design.md');
});

test('a v1 board file on disk loads, and saves back as v2', () => {
  // write the v1 object from the migrate test to <tmp>/board.json, open BoardStore,
  // assert store.board.flow.nodes.length === 1, apply { type: 'setTitle', title: 'New' },
  // re-read the file: JSON has schema 2, flow.nodes[0].title 'A', chat[0].text 'hi', claudeSessionId 'sess-1'
});
```

- [ ] **Step 2:** Run `node --test test/board.test.mjs test/store.test.mjs`. Expected: FAIL (`migrateBoard` / `boardPaths` not defined).
- [ ] **Step 3:** Implement `lib/paths.mjs`, `migrateBoard` + schema-2 `emptyBoard` in `lib/board.mjs`, move `BoardStore` to `lib/store.mjs` (load runs `migrateBoard`), and repoint every `board.nodes`/`board.edges` use in `lib/` to `board.flow.*`. `migrateBoard` is idempotent on schema-2 input and fills any missing top-level key from `emptyBoard()`.
- [ ] **Step 4:** Run `npm test`. Expected: all pass (existing server tests still pass through the moved store).
- [ ] **Step 5:** Commit: `git commit -am "feat: board schema 2 with v1 migration"` (add new files first).

---

### Task 3: Brainstorm objects, entries and links

**Files:**
- Create: `lib/brainstorm.mjs`, `test/brainstorm.test.mjs`
- Modify: `lib/board.mjs` (`applyOp` delegates unknown op types to `brainstormOp` before throwing)

**Interfaces:**
- Consumes: `OpError`, validation helpers from `lib/board.mjs` (export `text`, `number` as named exports).
- Produces (all in `lib/brainstorm.mjs`):
  - `KINDS = ['group','note','picture','topic']`, `COLORS = ['slate','violet','green','amber','rose','sky']`, `CHECKS = ['none','open','done']`
  - `DEFAULT_SIZE = { group: { w: 320, h: 0 }, note: { w: 220, h: 140 }, picture: { w: 240, h: 0 }, topic: { w: 0, h: 0 } }`
  - `findObject(board, id) → { page, object }` (throws `OpError`)
  - `objectLabel(object) → string` (group title; note text first line ≤ 60 chars; picture caption or `'picture'`; topic text)
  - `placeObject(page, { near?: string, w: number, h: number }) → { x, y }`: right of `near` (gap 60) or right of everything; step down 40 px until the rect overlaps nothing; treat `h: 0` as 160 for overlap.
  - `brainstormOp(board, op, author) → result | undefined` handling these op types (page defaults to `'p_main'`; `changed` ids returned as `result.changed: string[]`):
    - `addObject { kind, x?, y?, near?, w?, h?, title?, color?, entries?: {label,text,check?}[], text?, caption?, asset?, preview? }` → `{ object }`; `claudeAdded = author === 'claude'`; entries created inside it get `claudeAdded: false`; picture requires `asset`.
    - `updateObject { id, title?, text?, caption?, color? }`, `moveObject { id, x?, y?, w?, h? }`, `deleteObject { id }` (also removes links touching it), `keep { id, entryId? }` (clears `claudeAdded`), `setPicturePreview { id, preview }`
    - `addEntry { groupId, label, text, check?, index? }` (`claudeAdded = author === 'claude'`), `updateEntry { groupId, entryId, label?, text?, check? }`, `moveEntry { entryId, toGroupId, index? }`, `deleteEntry { groupId, entryId }`
    - `addLink { from, to, label?, dashed? }` (no self-links; duplicate from→to returns the existing link), `updateLink { id, label?, dashed? }`, `deleteLink { id }`
  - Limits: title/label 200 chars, text 20 000, caption 500. `moveObject` does not change `updatedBy`.

- [ ] **Step 1: Write the failing tests**

```js
test('a Claude-added group is marked; its starting entries are not', () => {
  const b = emptyBoard();
  const { object: g } = applyOp(b, { type: 'addObject', kind: 'group', title: 'Wizards', entries: [{ label: 'Familiars', text: 'conjured with soul points', check: 'done' }] }, 'claude');
  assert.equal(g.claudeAdded, true);
  assert.equal(g.entries[0].claudeAdded, false);
  assert.equal(g.entries[0].check, 'done');
  assert.equal(g.w, 320);
});

test('entries can be added, edited, ticked, moved between groups and deleted', () => {
  const b = emptyBoard();
  const a = applyOp(b, { type: 'addObject', kind: 'group', title: 'A', x: 0, y: 0 }, 'user').object;
  const c = applyOp(b, { type: 'addObject', kind: 'group', title: 'C', x: 600, y: 0 }, 'user').object;
  const { entry } = applyOp(b, { type: 'addEntry', groupId: a.id, label: 'Magic', text: 'shields' }, 'claude');
  assert.equal(entry.claudeAdded, true);
  assert.equal(entry.check, 'none');
  applyOp(b, { type: 'updateEntry', groupId: a.id, entryId: entry.id, text: 'shields, mind control', check: 'open' }, 'user');
  applyOp(b, { type: 'moveEntry', entryId: entry.id, toGroupId: c.id, index: 0 }, 'user');
  assert.equal(a.entries.length, 0);
  assert.equal(c.entries[0].text, 'shields, mind control');
  applyOp(b, { type: 'deleteEntry', groupId: c.id, entryId: entry.id }, 'user');
  assert.equal(c.entries.length, 0);
});

test('deleting an object removes its links', () => {
  // add group g and topic t, addLink g→t, deleteObject t → page.links is empty
});

test('placeObject puts new things beside their neighbour without overlap', () => {
  const b = emptyBoard();
  const g = applyOp(b, { type: 'addObject', kind: 'group', title: 'G', x: 0, y: 0 }, 'user').object;
  const n1 = applyOp(b, { type: 'addObject', kind: 'note', text: 'one', near: g.id }, 'claude').object;
  const n2 = applyOp(b, { type: 'addObject', kind: 'note', text: 'two', near: g.id }, 'claude').object;
  assert.equal(n1.x, 380);
  assert.equal(n1.x, n2.x);
  assert.ok(n2.y >= n1.y + 140);
});

test('bad brainstorm ops are refused', () => {
  // addObject kind 'video' → OpError; addObject picture without asset → OpError;
  // addLink from === to → OpError; updateEntry with check 'maybe' → OpError; keep on unknown id → OpError
});
```

- [ ] **Step 2:** Run `node --test test/brainstorm.test.mjs`. Expected: FAIL.
- [ ] **Step 3:** Implement `lib/brainstorm.mjs` as specified and wire it into `applyOp`.
- [ ] **Step 4:** Run `npm test`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat: brainstorm objects, entries and links`.

---

### Task 4: Ruled-out memory

**Files:**
- Create: `lib/memory.mjs`, `test/memory.test.mjs`
- Modify: `lib/board.mjs` (`updateNode` refuses `status: 'rejected'` with `OpError('use ruleOut to reject a card')` and refuses changing a rejected card's status with `OpError('use bringBack to restore a rejected card')`; `applyOp` delegates `ruleOut`/`bringBack` to `memoryOp`)

**Interfaces:**
- Consumes: `findObject`, `objectLabel`, `placeObject` from Task 3.
- Produces:
  - `memoryOp(board, op, author) → result | undefined`:
    - `ruleOut { target, reason?: string, text?: string }` → `{ record }`, where `target` is one of `{ kind: 'entry', groupId, entryId }`, `{ kind: 'object', id }`, `{ kind: 'node', id }`, `{ kind: 'idea' }` (`text` required). Effects: entry → `ruledOut = true` (stays in its group); object → removed with its links, `snapshot = { object, links }`; node → `status = 'rejected'`, `snapshot = node`; entry snapshot = `{ entry, groupTitle }`. Default `text`: entry `"<label>: <text>"` (≤ 160 chars), object `objectLabel`, node title. `source.label`: group title / object label / card title / `'chat'`.
    - `bringBack { id }` → removes the record and restores: entry `ruledOut = false` (re-inserted from snapshot if missing; if the group is gone, a new group titled `snapshot.groupTitle` is created at `placeObject`); object re-inserted with links whose ends still exist; node `status = 'idea'` (re-added from snapshot if missing); idea → record removed only.
  - `enforceRuledOut(board) → void`: re-applies every record's effect to whatever exists (used after a version restore).
  - `findRuledOutMatches(text, records) → RuledOut[]`: tokenize both texts (lowercase; split on non-letters/digits; drop tokens shorter than 3 and the stopwords below; strip a trailing `s` from tokens longer than 3); a record matches when the two token sets share ≥ 2 tokens **and** shared ÷ size of the smaller set ≥ 0.5.
    Stopwords: `the and for with that this can are was but not they them their from have has use using into when then than more most mostly very also just only about over under each other some such out off its`.

- [ ] **Step 1: Write the failing tests**

```js
test('ruling out an entry keeps it in its group, struck, and records the reason', () => {
  const b = emptyBoard();
  const g = applyOp(b, { type: 'addObject', kind: 'group', title: 'Wizards', x: 0, y: 0, entries: [{ label: 'Fireballs', text: 'damage spells' }] }, 'user').object;
  const e = g.entries[0];
  const { record } = applyOp(b, { type: 'ruleOut', target: { kind: 'entry', groupId: g.id, entryId: e.id }, reason: "wizards aren't damage dealers" }, 'user');
  assert.equal(e.ruledOut, true);
  assert.equal(record.text, 'Fireballs: damage spells');
  assert.equal(record.source.label, 'Wizards');
  assert.equal(record.by, 'user');
  applyOp(b, { type: 'bringBack', id: record.id }, 'user');
  assert.equal(e.ruledOut, false);
  assert.equal(b.ruledOut.length, 0);
});

test('dismissing a Claude object removes it; Bring back restores it and its links', () => {
  // claude adds note N near group G, user addLink G→N; ruleOut { kind: 'object', id: N.id };
  // page has no N and no links; bringBack → N back with same id and the G→N link back
});

test('bring back recreates the group when the group was deleted meanwhile', () => {
  // rule out an entry of group "Trolls", deleteObject the group, bringBack →
  // a group titled "Trolls" exists containing that entry with ruledOut false
});

test('flowchart cards are rejected only through ruleOut', () => {
  const b = emptyBoard();
  const { node } = applyOp(b, { type: 'addNode', title: 'Mana only on kills', x: 0, y: 0 }, 'user');
  assert.throws(() => applyOp(b, { type: 'updateNode', id: node.id, status: 'rejected' }, 'user'), /ruleOut/);
  const { record } = applyOp(b, { type: 'ruleOut', target: { kind: 'node', id: node.id }, reason: 'stalls' }, 'user');
  assert.equal(node.status, 'rejected');
  assert.throws(() => applyOp(b, { type: 'updateNode', id: node.id, status: 'idea' }, 'user'), /bringBack/);
  applyOp(b, { type: 'bringBack', id: record.id }, 'user');
  assert.equal(node.status, 'idea');
});

test('findRuledOutMatches flags close ideas but not loose ones', () => {
  const records = [{ id: 'r_1', text: 'Wizards cast fireballs and damage spells', reason: 'x' }];
  assert.equal(findRuledOutMatches('Wizards cast fireballs', records).length, 1);
  assert.equal(findRuledOutMatches('Fireball spell for wizards', records).length, 1);
  assert.equal(findRuledOutMatches('Wizards can fly', records).length, 0);
  assert.equal(findRuledOutMatches('', records).length, 0);
});

test('enforceRuledOut re-applies records to restored content', () => {
  // board with group G entry E; ruleOut E; then set E.ruledOut = false by hand (as a restored version would);
  // enforceRuledOut(b) → E.ruledOut === true. Same for an object record: re-add the object by hand → removed again.
});
```

- [ ] **Step 2:** Run `node --test test/memory.test.mjs`. Expected: FAIL.
- [ ] **Step 3:** Implement `lib/memory.mjs` and the `updateNode` guards.
- [ ] **Step 4:** Run `npm test`. Expected: PASS (update the v1 test that rejected via `updateNode` to use `ruleOut`).
- [ ] **Step 5:** Commit: `feat: ruled-out memory`.

---

### Task 5: History, undo, redo and undo-a-reply

**Files:**
- Create: `lib/history.mjs`, `test/history.test.mjs`
- Modify: `lib/store.mjs` (record history on every content op; turns; `undo`/`redo`/`undoTurn`), `server.mjs` (endpoints), `test/server.test.mjs`

**Interfaces:**
- Produces in `lib/history.mjs`:
  - `collections(board) → Array<{ key: string, items: object[] }>` for keys `brief.sections`, `flow.nodes`, `flow.edges`, `brainstorm.<pageId>.objects`, `brainstorm.<pageId>.links`, `ruledOut`; plus the scalar key `title`.
  - `diffContent(before: Board, after: Board) → Change[]`, where `Change` is `{ key, id, before: object|null, after: object|null, index: number }` (item added/removed/changed; `index` = position in the array that held it), `{ key, order: { before: string[], after: string[] } }` (same ids, new order), or `{ key: 'title', before: string, after: string }`. `chat`, `version`, `claudeSessionId` are never diffed. Item equality = `JSON.stringify` equality.
  - `applyChanges(board, changes, direction: 'undo' | 'redo') → { applied: Change[], skipped: Change[] }`: walk changes (reversed for undo); the expected current value is `after` (undo) or `before` (redo); apply only if the current item/order/title deep-equals the expected value, else skip. Removal deletes by id; insertion splices at `min(index, length)`.
  - `describeOp(op, result, boardBefore, author) → string`. Pinned examples: `addObject` group → `added group “Wizards”`; `addEntry` → `added “Magic” to Wizards`; `updateEntry` → `edited “Magic” in Wizards`; `moveObject` → `moved “Trolls”`; `deleteObject` note → `deleted note “Scene idea…”`; `ruleOut` → `ruled out “Fireballs: damage spells”`; `bringBack` → `brought back “…”`; `addNode` → `added card “…”`. Others: a short past-tense phrase naming the target.
  - `class HistoryLog { constructor(file, { now = Date.now, coalesceMs = 2000 } = {}); record({ author, turn, op, summary, changes, kind? }) → HistoryEntry; entries() → HistoryEntry[] (oldest first); isUndone(seq) → boolean; flush() → void }`. `HistoryEntry = { seq, at, author, turn, op, summary, changes, kind?: 'undo'|'redo'|'restore', targets?: number[] }`. Persists one JSON line per entry to the `.history.jsonl` file. **Coalescing:** a user entry whose op is one of `updateObject updateEntry updateSection updateNode updateEdge updateLink moveObject` and whose target id (op `id`/`entryId`) matches the previous user entry's, within `coalesceMs`, merges into it (keeps the first `before`, takes the latest `after`); the pending entry is written to disk when a non-mergeable entry arrives, after `coalesceMs`, or on `flush()`. Undone state is rebuilt on load from `kind: 'undo' | 'redo'` entries and their `targets`.
- Produces in `lib/store.mjs`: `store.apply(op, author)` now (1) deep-clones content, (2) applies, (3) diffs, (4) records a history entry when there are changes, with `turn` = `u<seq>` for the user, or the current Claude turn id for Claude. The Claude turn id is `t_<8 hex>`; a new one starts after every Claude `chat` op. Also `store.undo() → { undone: HistoryEntry | null, skipped: Change[] }`, `store.redo() → same shape`, `store.undoTurn(turn) → { undone: number, skipped: { seq, summary }[] }`, `store.history({ limit = 50, before?: number }) → { entries: (HistoryEntry minus changes, plus undone: boolean)[] }`, newest first, `before` = only entries with `seq < before`. Undo targets the newest user entry that is not undone and not itself an undo/redo; redo targets the newest undone user entry, only if no new user entry was recorded after that undo. Every undo/redo/undoTurn records its own history entry (`kind`, `targets`) and emits a board event plus `{ type: 'history' }`.
- Endpoints: `POST /api/undo`, `POST /api/redo`, `POST /api/undo-turn` `{ turn }`, `GET /api/history?limit=&before=`.

- [ ] **Step 1: Write the failing tests**

```js
test('diff and undo restore a deleted object together with its links', () => {
  // board with group G, topic T, link G→T; before = clone; deleteObject T; changes = diffContent(before, b)
  // applyChanges(b, changes, 'undo') → T is back at its old index and the link G→T is back; applied.length === 2
});

test('undo skips an item that changed since', () => {
  // claude addEntry E (turn t1); user updateEntry E text; store.undoTurn(t1) →
  // { undone: 0, skipped: [{ summary: 'added “…” to …' }] } and E still exists with the user's text
});

test('typing coalesces into one undo step', () => {
  // HistoryLog with fake now; three updateSection ops on the same id at t=0, 500, 900 ms by user →
  // one entry; its changes go from the original text to the last text; one store.undo() restores the original
});

test('undo works after a restart', () => {
  // BoardStore A: user addObject note; A.history log flushed; new BoardStore B on the same file;
  // B.undo() → note gone; B.redo() → note back
});

test('undoTurn reverts every change of one Claude reply and nothing else', () => {
  // user adds group U; claude (turn 1) adds note N1 and entry E1 in U, then chat 'done';
  // claude (turn 2) adds note N2; undoTurn(turn 1) → N1 and E1 gone, U and N2 remain
});

test('history endpoint lists newest first with undone flags', () => {
  // via HTTP: two user ops, POST /api/undo, GET /api/history → entries[0].kind === 'undo', the undone op has undone: true
});
```

- [ ] **Step 2:** Run `node --test test/history.test.mjs`. Expected: FAIL.
- [ ] **Step 3:** Implement `lib/history.mjs`, the store integration and endpoints. Call `history.flush()` on `SIGINT`/`SIGTERM` in `server.mjs` before exiting.
- [ ] **Step 4:** Run `npm test`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat: history with undo, redo and undo-a-reply`.

---

### Task 6: Saved versions

**Files:**
- Create: `lib/versions.mjs`, `test/versions.test.mjs`
- Modify: `lib/store.mjs`, `server.mjs`

**Interfaces:**
- Produces: `class VersionStore { constructor(dir); save(content, { name, author, auto = false }) → VersionMeta; list() → VersionMeta[] (newest first); read(id) → { meta: VersionMeta, content } }`. `VersionMeta = { id, name, at, author, auto, stats: { groups, entries, notes, pictures, cards } }`. Files: `<dir>/<id>.json` holding `{ meta, content }`; `id` = `v_<YYYYMMDD-HHMMSS>_<4 hex>`. `content` = `{ title, brief, flow, brainstorm }` only.
- Store: `store.saveVersion(name, author) → VersionMeta`; `store.restoreVersion(id, author) → { restored: VersionMeta, backup: VersionMeta }`: auto-saves the current content as `Before restoring “<name>”` (`auto: true`), replaces the content keys, runs `enforceRuledOut`, then records a history entry `kind: 'restore'` whose changes come from `diffContent`, so plain undo reverses it.
- Endpoints: `GET /api/versions`, `POST /api/versions` `{ name }`, `GET /api/versions/:id` (`{ meta, content }` for Preview), `POST /api/versions/:id/restore`.

- [ ] **Step 1: Write the failing tests**

```js
test('restoring a version brings content back but keeps memory and chat', () => {
  // user adds group "Wizards" with entry "Fireballs"; saveVersion('first');
  // user rules out "Fireballs"; user chats 'hello'; claude adds note N;
  // restoreVersion(first) → N gone; "Fireballs" present but ruledOut === true; ruledOut.length === 1;
  // chat still has 'hello'; versions list has an auto version named 'Before restoring “first”'
});

test('a restore can be undone', () => {
  // after restoreVersion, store.undo() → note N back
});

test('versions survive a restart and list newest first with stats', () => {
  // save 'a' then 'b'; new VersionStore(dir).list().map(v => v.name) deepEqual ['b', 'a']; stats.groups correct
});
```

- [ ] **Step 2:** Run `node --test test/versions.test.mjs`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm test`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat: saved versions with preview and restore`.

---

### Task 7: Pictures (assets)

**Files:**
- Create: `lib/assets.mjs`, `test/assets.test.mjs`
- Modify: `server.mjs` (body limit 30 MB for `/api/assets`, 1 MB elsewhere)
- Reference: `~/Dev/bun3/artboard/src/workspace/manager.ts` (`downloadRemoteAsset`, Google Images URL handling) for the URL ingest

**Interfaces:**
- Produces: `MAX_ASSET_BYTES = 30 * 1024 * 1024`; `sniffImageType(buf) → 'png'|'jpg'|'gif'|'webp'|null` (magic bytes `89 50 4E 47`, `FF D8 FF`, `47 49 46 38`, `RIFF....WEBP`); `class AssetStore { constructor(dir); ingestBuffer(buf) → { asset: string, bytes: number }; ingestUrl(url, { fetchImpl = fetch, timeoutMs = 15000 } = {}) → Promise<{ asset, bytes }>; resolve(name) → absolute path (throws OpError unless name matches /^[0-9a-f]{32}\.(png|jpg|gif|webp)$/); read(name) → Buffer }`. Asset name = first 32 hex chars of sha256 + `.` + sniffed type; identical bytes give the same name. `ingestUrl`: only http/https; unwraps Google Images result URLs (`imgurl` query parameter); rejects when content-length or the downloaded size exceeds the max, when the sniffed type is null, on timeout; all failures are `OpError` with a human message (`not an image (got text/html)`, `picture is larger than 30 MB`, `could not download: timed out`).
- Endpoints: `POST /api/assets` (raw body) → `{ asset }`; `POST /api/assets/url` `{ url }` → `{ asset }`; `GET /assets/<name>` → bytes with `content-type` from the extension, `cache-control: public, max-age=31536000, immutable`, `x-content-type-options: nosniff`. Errors → 400 `{ error }`, 413 for size.

- [ ] **Step 1: Write the failing tests**

```js
test('ingestBuffer stores by content hash and rejects non-images', () => {
  // 1×1 PNG buffer (reuse the base64 from archify tests: iVBORw0KGgo…) → asset /^[0-9a-f]{32}\.png$/, file exists;
  // same bytes again → same name; Buffer.from('%PDF-1.4') → OpError /not an image/
});

test('ingestUrl handles Google Images links, HTML pages and timeouts', async () => {
  // local http server: /pic.png → png bytes; /page → text/html; /slow → never answers
  // ingestUrl(`https://www.google.com/imgres?imgurl=${encodeURIComponent(base + '/pic.png')}`) → png asset
  // ingestUrl(base + '/page') → rejects /not an image/
  // ingestUrl(base + '/slow', { timeoutMs: 200 }) → rejects /timed out/
  // ingestUrl('file:///etc/passwd') → rejects
});

test('the server refuses a 40 MB upload and serves stored pictures safely', async () => {
  // POST /api/assets with 40 MB → 413; POST png → { asset }; GET /assets/<asset> → 200, image/png, nosniff;
  // GET /assets/../board.json → 404 or 400; GET /assets/evil.svg → 400
});
```

- [ ] **Step 2:** Run `node --test test/assets.test.mjs`. Expected: FAIL.
- [ ] **Step 3:** Implement `lib/assets.mjs` and the endpoints.
- [ ] **Step 4:** Run `npm test`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat: picture assets with upload and URL ingest`.

---

### Task 8: Design-doc export

**Files:**
- Create: `lib/export.mjs`, `test/export.test.mjs`
- Modify: `server.mjs` (`POST /api/export` → `{ path }`)

**Interfaces:**
- Produces: `renderDesignDoc(board, { assetsDirName, date }) → string`; `store.exportDesignDoc() → string` (writes `paths.design`, returns the path).
- Format (exact headings and line forms):

```markdown
# <title>

_Exported <date> from idea board._

## Brief

### <section title>

<section text>

## Brainstorm

### <group title>

- [x] **<label>:** <text>
- [ ] **<label>:** <text>
- **<label>:** <text>

### Notes

> <note text, each line prefixed with "> ">

### Pictures

- <caption> (`<assetsDirName>/<asset>`)

### Links

- <from label> → <to label> (<link label>)

## Flowchart

### Accepted cards

- **<title>**: <first line of notes>

### Connections

- <from title> → <to title> (<label>)

## Ruled out

- **<text>**: "<reason>" (<You|Claude>, <YYYY-MM-DD>, from <source label>)
```

Rules: `check: 'done'` → `- [x]`, `'open'` → `- [ ]`, `'none'` → `- `; ruled-out entries are left out of groups; an unreviewed Claude-added entry or group gets ` _(Claude added, not reviewed)_` appended; empty sections are omitted; the `(<label>)` suffix is omitted when the label is empty, and so is `: "<reason>"` when there is no reason; connections list only edges whose both ends are accepted cards.

- [ ] **Step 1: Write the failing test**

```js
test('design doc lists agreed, undecided and plain entries, and the ruled-out list', () => {
  // group "Wizards": Familiars done, Magic open, Towers none, Fireballs ruled out (reason "not damage dealers")
  const md = renderDesignDoc(b, { assetsDirName: 'game.assets', date: '2026-10-22' });
  assert.match(md, /^# /);
  assert.match(md, /- \[x\] \*\*Familiars:\*\* /);
  assert.match(md, /- \[ \] \*\*Magic:\*\* /);
  assert.match(md, /^- \*\*Towers:\*\* /m);
  assert.doesNotMatch(md, /### Wizards[\s\S]*Fireballs[\s\S]*## Flowchart/);
  assert.match(md, /## Ruled out\n\n- \*\*Fireballs: .*\*\*: "not damage dealers" \(You, \d{4}-\d{2}-\d{2}, from Wizards\)/);
});
```

- [ ] **Step 2:** Run it. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm test`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat: export design doc`.

---

### Task 9: MCP tools v2, guard, pointing, agent prompt

**Files:**
- Modify: `lib/mcp.mjs`, `lib/agent.mjs`, `lib/board.mjs` (`chat` op accepts `context: Pointer[]`, max 5 items), `test/server.test.mjs`
- Create: `test/mcp.test.mjs`

**Interfaces:**
- Consumes: everything above.
- Tools (names and required args; optional args in brackets). Every add/update returns the affected ids; every tool that creates text runs `findRuledOutMatches` on the new text (group title + entries, entry `label + text`, note text, topic text, card title + notes) and, on a match, adds `resembles_ruled_out: [{ id, text, reason }]` and `warning: "This resembles something the user ruled out. Remove it, or tell the user it was ruled out before and why."` to the result.
  - Read: `view_board` [`full_notes`]; `view_picture` `id`; `get_node` `id`; `get_history` [`limit`, `before`]; `list_versions`.
  - Brief: `add_brief_section` `title text`; `update_brief_section` `id` [`title text`]; `move_brief_section` `id by(-1|1)`; `delete_brief_section` `id`.
  - Brainstorm: `add_group` `title` [`color entries[{label,text,check}] near x y`]; `update_group` `id` [`title color`]; `add_entry` `group_id label text` [`check index`]; `update_entry` `group_id entry_id` [`label text check`]; `move_entry` `entry_id to_group_id` [`index`]; `delete_entry` `group_id entry_id`; `add_note` `text` [`color near x y`]; `update_note` `id` [`text color`]; `add_topic` `text` [`near x y`]; `update_topic` `id text`; `add_picture_from_url` `url` [`caption near`]; `update_picture` `id caption`; `move_object` `id` [`x y w h`]; `delete_object` `id`; `link` `from to` [`label dashed`]; `update_link` `id` [`label dashed`]; `unlink` `id`.
  - Memory: `rule_out` `reason` [`text target{kind,...}`]; `bring_back` `id`.
  - Flowchart: `add_node`, `update_node` (status enum now `idea|accepted`), `delete_node`, `connect`, `disconnect`, `tidy_layout` (v1 shapes); `rename_board` `title`.
  - History/versions/export: `undo_reply` `turn`; `save_version` `name`; `restore_version` `id`; `export_design_doc`.
  - Chat: `reply` `text`; `wait_for_chat` [`timeout_seconds`] (messages now include `pointing_at`).
- `view_board` returns exactly: `{ title, brief: [{ id, title, text }], ruled_out: [{ id, text, reason, from, at }], brainstorm: { groups: [{ id, title, color, claude_added, x, y, entries: [{ id, label, text, check, claude_added }], ruled_out_entries: [{ id, label }] }], notes: [{ id, text, claude_added }], pictures: [{ id, caption, claude_added }], topics: [{ id, text }], links: [{ id, from, to, label, dashed }] }, flowchart: { nodes, connections }, recent_history: [{ seq, author, summary, at }] (last 10), unanswered_chat: [{ id, text, at, pointing_at }] }`.
- `view_picture` returns MCP content `[{ type: 'text', text: '<caption>' }, { type: 'image', data: <base64>, mimeType }]` using `preview ?? asset`; if the file is over 3.75 MB it returns `isError` with `Picture too large to view; open the board in a browser once so it can make a preview.` The tool runner signals raw content by returning `{ mcpContent: [...] }`; `createMcpHandler` passes it through as `result.content`.
- `initialize` → `serverInfo.version: '0.2.0'` and `instructions` exactly: `A shared idea board you and the user both edit: Brief (what you are building), Brainstorm (groups, notes, pictures, topics, links) and Flowchart (cards and arrows). Call view_board first and read ruled_out: never re-propose anything on it; if a tool result flags a resemblance, tell the user. Record rejections the user states with rule_out. You may change anything; every change is visible and undoable. Use wait_for_chat to listen to the board chat.`
- Agent: user messages with `context` are prefixed in the prompt with `[Pointing at: <kind> “<label>” (<id>)]`. `SYSTEM_PROMPT` exactly:

```text
You are Claude, the user's collaborator on a shared idea board. You and the user can both do anything on it. The user just wrote in the board's chat.

The board has three views:
- Brief: what you are building and what has been decided. Keep your ideas consistent with it, and record goals, decisions and constraints the user settles there.
- Brainstorm: a free-form surface of groups (a title plus entries), notes, pictures, topic bubbles and links. Entry checkboxes mean: ticked = agreed, unticked = undecided, no checkbox = a note or fact.
- Flowchart: cards and arrows.

Rules:
- Start with view_board. Read ruled_out first: never propose anything on that list again. If a tool result says something resembles a ruled-out idea, remove it or tell the user it was ruled out before and why.
- When the user rejects something in chat ("we don't want X"), record it with rule_out, with their reason.
- You may add, edit, move, link and delete anything, including the user's own content, when the conversation calls for it. Every change you make is shown to the user and can be undone, so act, then say what you changed.
- New things you add are marked "Claude added" until the user keeps or dismisses them.
- Use view_picture to look at pictures when they matter.
- If the user is pointing at something, the message starts with [Pointing at: …]; that is what "this" means.
- Finish with a short chat reply (one to three sentences) saying what you changed. Your final message is posted to the board chat, so do not call reply yourself.
```

- [ ] **Step 1: Write the failing tests** (`test/mcp.test.mjs`, using the `withServer` helper moved to `test/helpers.mjs`)

```js
test('tools/list covers the full v2 tool set', async () => {
  // names include every tool listed in Task 9, and update_node's status enum is ['idea', 'accepted']
});

test('view_board shows memory first and brainstorm content', async () => {
  // user group Wizards with entries + rule out one; call view_board → keys in order start with
  // ['title', 'brief', 'ruled_out', 'brainstorm']; groups[0].ruled_out_entries[0].label === 'Fireballs'
});

test('adding something close to a ruled-out idea warns Claude', async () => {
  // ruled out "Wizards cast fireballs and damage spells"; add_entry label 'Fireballs' text 'wizards cast fireball spells'
  // → result.resembles_ruled_out[0].text matches /fireballs/ and result.warning is set; entry still added
});

test('view_picture returns an image block', async () => {
  // upload png, add picture object, view_picture → content[1].type === 'image', mimeType 'image/png'
});

test('pointing context reaches wait_for_chat and the agent prompt', async () => {
  // user chat op with context [{ kind: 'object', id: g.id, label: 'Wizards' }] →
  // wait_for_chat messages[0].pointing_at[0].label === 'Wizards';
  // Agent prompt builder (export buildPrompt(messages) from lib/agent.mjs) starts with '[Pointing at: object “Wizards” ('
});

test('Claude can undo its own reply and save a version', async () => {
  // claude add_note, reply, get turn from get_history, undo_reply → note gone; save_version → list_versions has it
});
```

- [ ] **Step 2:** Run `node --test test/mcp.test.mjs`. Expected: FAIL.
- [ ] **Step 3:** Implement the tool set, the `mcpContent` passthrough, guard, prompt text and `buildPrompt(messages: ChatMessage[]) → string` in `lib/agent.mjs`.
- [ ] **Step 4:** Run `npm test`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat: MCP v2 tools, ruled-out guard and pointing`.

---

### Task 10: Svelte app shell

**Files:**
- Create: `vite.config.ts`, `svelte.config.js`, `tsconfig.json`, `eslint.config.js`, `web/index.html`, `web/src/main.ts`, `web/src/app.css`, `web/src/App.svelte`, `web/src/lib/types.ts`, `web/src/lib/api.ts`, `web/src/lib/live.svelte.ts`, `web/src/components/TopBar.svelte`, `web/src/components/ChatDock.svelte`, `web/src/components/Toast.svelte`, `web/src/components/ChatDock.test.ts`, `web/src/test-setup.ts`
- Modify: `package.json`, `server.mjs` (serve `dist/` instead of `public/`; when `dist/index.html` is missing respond 503 with `Idea board is not built yet. Run: npm install && npm run build`), `test/server.test.mjs`, `.gitignore`

**Interfaces:**
- Install: `npm install -D svelte vite @sveltejs/vite-plugin-svelte typescript svelte-check tailwindcss @tailwindcss/vite eslint @eslint/js typescript-eslint eslint-plugin-svelte globals vitest jsdom @testing-library/svelte @testing-library/jest-dom`.
- `package.json` scripts: `start: node server.mjs`, `build: vite build`, `dev: vite`, `check: svelte-check --tsconfig ./tsconfig.json`, `lint: eslint .`, `test:server: node --test test/*.test.mjs`, `test:web: vitest run`, `test: npm run test:server && npm run test:web`.
- `vite.config.ts`: `root: 'web'`, `build.outDir: '../dist'`, `emptyOutDir: true`, alias `$lib` → `web/src/lib`; dev proxy for `/api`, `/assets`, `/mcp` to `http://127.0.0.1:4777` with `changeOrigin: true` and the `origin` request header removed (`configure: (p) => p.on('proxyReq', (r) => r.removeHeader('origin'))`); `test: { environment: 'jsdom', include: ['src/**/*.test.ts'], setupFiles: ['src/test-setup.ts'] }`; plugins `svelte()`, `tailwindcss()`, and `svelteTesting()` from `@testing-library/svelte/vite`.
- `types.ts`: the shared board shape above, plus `type Op = { type: string; [key: string]: unknown }`, `HistoryRow`, `VersionMeta`, and `objectLabel(o: BObject): string` (same rules as the server's).
- `api.ts`: `op(o: Op): Promise<unknown>` (throws `Error(message)` on non-2xx), `undo()`, `redo()`, `undoTurn(turn)`, `history(limit?, before?)`, `versions()`, `saveVersion(name)`, `readVersion(id)`, `restoreVersion(id)`, `uploadPicture(blob: Blob): Promise<string>`, `ingestUrl(url): Promise<string>`, `exportDoc(): Promise<string>`, `boardInfo()`.
- `live.svelte.ts` exports a single `live` object with `$state` fields: `board: Board | null`, `agent: 'idle'|'working'|'off'`, `presence: boolean`, `saving: number`, `saveFailed: boolean`, `pointing: Pointer | null`, `flash: Set<string>`, `view: 'brief'|'brainstorm'|'flowchart'` (persisted in localStorage key `idea-board-tab`), `notices: {at,text}[]`, `historyTick: number` (incremented on `{ type: 'history' }` events); and `connect(): void` (EventSource `/api/events`, flashes `changed` ids for 1600 ms when `author === 'claude'`), `send(o: Op): Promise<unknown|null>` (wraps `api.op`, maintains `saving`/`saveFailed`, toasts errors).
- `App.svelte` layout: TopBar (board title input, tab switcher, save status text, `↶ Undo`, `↷`, `★ Save version`, `⋯` menu with `Export design doc`), main area (active view + right panel slot), ChatDock along the bottom. Views are placeholders in this task.
- `ChatDock.svelte`: message list (You / Claude bubbles, notices), agent status line, the `Talking about: <label>` chip with `×` (clears `live.pointing`) shown when `live.pointing` is set, input (Enter sends, Shift+Enter newline) sending `{ type: 'chat', text, context: live.pointing ? [live.pointing] : undefined }`.

- [ ] **Step 1: Write the failing tests**

```ts
// web/src/components/ChatDock.test.ts
test('the pointing chip shows and its context is sent with the message', async () => {
  // live.board = board with empty chat; live.pointing = { kind: 'object', id: 'g_1', label: 'Wizards' }
  // render ChatDock; expect getByText('Talking about:') and 'Wizards'; type 'expand this' + Enter
  // expect the mocked api.op called with { type: 'chat', text: 'expand this', context: [{ kind: 'object', id: 'g_1', label: 'Wizards' }] }
});
```

```js
// test/server.test.mjs
test('the server explains how to build when dist is missing', async () => {
  // createServer with distDir pointing at an empty temp dir → GET / → 503 and body includes 'npm run build'
});
```

- [ ] **Step 2:** Run `npm test`. Expected: FAIL.
- [ ] **Step 3:** Implement the shell (`createServer` gains an optional `distDir` for the test).
- [ ] **Step 4:** Run `npm run build && npm run check && npm run lint && npm test`. Expected: build writes `dist/index.html`; zero check/lint errors; tests PASS.
- [ ] **Step 5:** Commit: `feat: Svelte app shell`.

---

### Task 11: Brief view

**Files:**
- Create: `web/src/views/BriefView.svelte`, `web/src/views/BriefView.test.ts`

**Interfaces:**
- Consumes: `live`, `live.send`.
- Behaviour (port of v1 `renderBriefPanel` to a full-width centred column, max width 760 px): one box per section with a heading input, auto-growing textarea, ↑ ↓ ×, `Last edit: You|Claude · <ago>`; `+ Add text box`; debounced saves (title 400 ms, text 500 ms, flush on blur); remove confirms when non-empty; clicking a box sets `live.pointing = { kind: 'section', id, label: title }`. Incoming updates never replace the value of the field that has focus.

- [ ] **Step 1: Write the failing test:** `editing a section sends updateSection and an incoming update does not clobber the focused field` (render with a section; type into its textarea; set `live.board` to a copy whose section text differs; the textarea still shows the typed text; after 600 ms `api.op` was called with `{ type: 'updateSection', id, text: <typed> }`).
- [ ] **Step 2:** Run `npx vitest run web/src/views/BriefView.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm test && npm run check`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat: brief tab`.

---

### Task 12: Flowchart view (port of v1)

**Files:**
- Create: `web/src/lib/geometry.ts`, `web/src/lib/geometry.test.ts`, `web/src/components/Canvas.svelte`, `web/src/views/FlowchartView.svelte`, `web/src/flow/NodeCard.svelte`, `web/src/flow/Edges.svelte`, `web/src/flow/NodePanel.svelte`, `web/src/flow/EdgePanel.svelte`
- Delete: `public/` (v1 page), after this task's manual check passes

**Interfaces:**
- `geometry.ts`: `type View = { x: number; y: number; k: number }`, `type Rect = { x: number; y: number; w: number; h: number }`; `toWorld(view, sx, sy) → {x,y}`; `zoomAt(view, sx, sy, deltaY) → View` (k clamped 0.2–2.5, factor `Math.exp(-deltaY * 0.0015)`); `fitView(rects, width, height, pad = 60) → View` (k ≤ 1.25); `flowAnchors(a: Rect, b: Rect)` and `curve(s, t, sd, td) → { d, mid }` (same maths as v1 `public/app.js` `anchors`/`curve`); `linkPath(a: Rect, b: Rect) → { d, mid }` (border-to-border quadratic curve as in the mockup's `drawLinks`).
- `Canvas.svelte`: props `view: View` (bindable), `onBackgroundClick`, `onBackgroundDblClick(world: {x,y})`, children snippet; handles drag-to-pan, wheel zoom, dotted background that follows pan/zoom, view persisted per tab in localStorage (`idea-board-view-<tab>`).
- `FlowchartView.svelte`: everything v1 did (cards with checkbox, author badge, props/notes counts, drag move, handle-drag connect, edge select/label, Tidy, Fit/F key, Hide rejected, Delete key, flash) with `NodePanel` replacing the right panel when a card or arrow is selected (Memory panel otherwise). The panel's `Rejected` button prompts `Why not?` and sends `ruleOut { target: { kind: 'node', id } , reason }`; selecting a rejected card shows `Bring back`, which sends `bringBack` for its record. Selecting a card sets `live.pointing = { kind: 'node', id, label: title }`.

- [ ] **Step 1: Write the failing tests** (`geometry.test.ts`): `zoomAt keeps the point under the cursor fixed` (world point under (300,200) is the same before and after); `fitView fits two rects with padding`; `flowAnchors picks left/right sides for wide gaps and top/bottom for tall ones`; `linkPath starts and ends on the rect borders` (start point lies on rect a's border within 1 px).
- [ ] **Step 2:** Run `npx vitest run web/src/lib/geometry.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement geometry, Canvas and the Flowchart view.
- [ ] **Step 4:** Run `npm test && npm run check && npm run lint && npm run build`. Then start `node server.mjs /tmp/ib-check/board.json` and, in a browser, check: add a card by double-click, drag it, connect two cards, tick a checkbox, reject a card with a reason (it appears in Memory → Ruled out once Task 14 lands; for now in the board JSON `ruledOut`), Tidy, Fit. Expected: all work; no console errors.
- [ ] **Step 5:** Delete `public/`, run `npm test`, commit: `feat: flowchart tab in Svelte`.

---

### Task 13: Brainstorm canvas

**Files:**
- Create: `web/src/views/BrainstormView.svelte`, `web/src/brainstorm/Palette.svelte`, `web/src/brainstorm/GroupBox.svelte`, `web/src/brainstorm/EntryRow.svelte`, `web/src/brainstorm/NoteBox.svelte`, `web/src/brainstorm/PictureBox.svelte`, `web/src/brainstorm/TopicBubble.svelte`, `web/src/brainstorm/Links.svelte`, `web/src/brainstorm/ClaudeMark.svelte`, `web/src/lib/actions.ts`, `web/src/lib/pictures.ts`, `web/src/brainstorm/GroupBox.test.ts`, `web/src/lib/pictures.test.ts`

**Interfaces:**
- Consumes: `Canvas`, `linkPath`, `live`, `api.uploadPicture`, `api.ingestUrl`.
- `actions.ts`: `drag(node, { getStart: () => {x,y}, scale: () => number, onMove(x, y), onEnd(x, y) })` (ignores pointerdown on inputs, textareas, buttons, `[contenteditable]`); `resize(node, { min: { w, h }, scale, onEnd(w, h) })` on a bottom-right grip. Mins: group 220×80, note 160×80, picture 120×80.
- `pictures.ts`: `previewSize(w, h, maxEdge = 1568) → { w, h }` (unchanged when both ≤ maxEdge, else scaled so the long edge = maxEdge, rounded); `makePreview(blob) → Promise<Blob>` (canvas → `image/jpeg` quality 0.85); `pastedImage(e: ClipboardEvent) → File | null`; `pastedUrl(e) → string | null` (http/https text only).
- Objects render as in the approved mockup: group (coloured header with title, `⋯` menu with colour swatches and Delete, entries list, `+ add item`, folded `<N> ruled out` details listing struck labels with `Bring back`), note (sticky, free multi-line text), picture (image from `/assets/<asset>`, editable caption), topic (dark pill), links (curved, labelled, dashed option). Positions/sizes from the board; drag on title bar/grip sends `moveObject` on pointerup; resize grip sends `moveObject { w, h }`; boxes use `min-height: h` and grow with content (no inner scrollbars). Pan/zoom via `Canvas`.
- `EntryRow.svelte`: checkbox cycle via a small control: `none` (bullet) → `open` → `done` → `none` through the row's menu (`Add checkbox` / `Remove checkbox`) and the checkbox itself toggles `open`↔`done`; label (bold) and text editable in place (debounced `updateEntry`); drag handle to reorder within the group or drop onto another group (`moveEntry`); row menu `Rule out…` (prompts `Why not?`, sends `ruleOut` entry target); clicking a row sets `live.pointing = { kind: 'entry', id, groupId, label }`.
- `ClaudeMark.svelte`: dashed orange frame with `Claude added`, `Keep` (sends `keep`) and `Dismiss…` (prompts `Why not?`, then `ruleOut`). Used for Claude-added objects and entries.
- `Palette.svelte`: `▤ Group`, `✎ Note`, `● Topic`, `▣ Picture` (file picker), `↗ Link` (click two objects). New objects land at the viewport centre; new groups start with title `New group` focused.
- Pictures: paste an image (anywhere on the Brainstorm tab outside text fields) → upload → `addObject picture` at the viewport centre; drop image files at the drop point; paste an image URL → `api.ingestUrl` → add; then `makePreview` → upload → `setPicturePreview`. Any picture without `preview` gets one made once when it first renders. Errors show in the toast with the server's message.
- Clicking an object sets `live.pointing = { kind: 'object', id, label: objectLabel(object) }` (from `$lib/types`); clicking empty canvas clears it.

- [ ] **Step 1: Write the failing tests**

```ts
// GroupBox.test.ts
test('a focused entry keeps what you are typing when Claude updates the group', async () => {
  // render GroupBox with entry "Magic: shields"; focus its text field and type " and wards";
  // rerender with the group's title changed by Claude and the same entry text unchanged on the server;
  // expect the field to show "shields and wards" and the new title to render
});
test('Keep and Dismiss send keep and ruleOut', async () => {
  // Claude-added entry; click Keep → api.op({ type: 'keep', id: group.id, entryId });
  // Dismiss… with window.prompt mocked to return 'too violent' → api.op({ type: 'ruleOut', target: { kind: 'entry', groupId, entryId }, reason: 'too violent' })
});
test('ruled-out entries fold into "1 ruled out"', () => { /* one ruledOut entry → getByText('1 ruled out'); not in the main list */ });
```

```ts
// pictures.test.ts
test('previewSize keeps small pictures and scales big ones to 1568 on the long edge', () => {
  expect(previewSize(800, 600)).toEqual({ w: 800, h: 600 });
  expect(previewSize(4000, 3000)).toEqual({ w: 1568, h: 1176 });
  expect(previewSize(1000, 5000)).toEqual({ w: 314, h: 1568 });
});
```

- [ ] **Step 2:** Run `npx vitest run web/src/brainstorm web/src/lib/pictures.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm test && npm run check && npm run lint && npm run build`; then in a browser recreate the mockup by hand (Wizards and Trolls groups with checkbox and bullet entries, a note, a pasted picture, a topic, labelled and dashed links), drag and resize each kind, move an entry between groups, rule one out. Expected: matches the mockup; no inner scrollbars; no console errors.
- [ ] **Step 5:** Commit: `feat: brainstorm tab`.

---

### Task 14: Memory panel, undo/redo, versions, export

**Files:**
- Create: `web/src/memory/MemoryPanel.svelte`, `web/src/memory/RuledOutList.svelte`, `web/src/memory/HistoryList.svelte`, `web/src/memory/VersionPreview.svelte`, `web/src/memory/HistoryList.test.ts`
- Modify: `web/src/App.svelte`, `web/src/components/TopBar.svelte`, `web/src/views/BrainstormView.svelte`, `web/src/views/FlowchartView.svelte` (accept a read-only `board` override for Preview)

**Interfaces:**
- `MemoryPanel`: header `Memory`, tabs `Ruled out (<n>)` | `History`.
- `RuledOutList`: newest first; each card shows the struck text, the reason in quotes, `You|Claude · <date> · <source label>`, and `Bring back` (sends `bringBack`). Hint line: `Claude checks this list before suggesting anything, and won't bring these back unless you do.`
- `HistoryList`: loads `api.history(50)` and refetches on `live.historyTick`; consecutive entries with the same Claude `turn` render as one group headed `Claude` with their summaries and one `Undo this reply` button (`api.undoTurn(turn)`; a toast reports skipped items: `Kept <n> item(s) you changed since.`); user entries render singly; undone entries are greyed with `(undone)`; versions from `api.versions()` are interleaved by time as highlighted rows `★ Version: “<name>”` with `<date> · <groups> groups, <entries> entries, <pictures> pictures` and `Preview` / `Restore` (Restore asks for confirmation). `Load more` pages with `before`.
- Preview: `VersionPreview` shows a banner `Previewing “<name>”` with `Restore` and `Close`, and renders the current tab's view from the version's content in read-only mode (no drag, no edits, no chat sending).
- Top bar: `↶ Undo` / `↷` call `api.undo()` / `api.redo()`; Ctrl+Z, Ctrl+Shift+Z and Ctrl+Y do the same when focus is not in an input, textarea or `[contenteditable]`; `★ Save version` prompts for a name (default `Version <YYYY-MM-DD HH:MM>`); `⋯ → Export design doc` calls `api.exportDoc()` and toasts `Saved <path>`.
- The right panel shows `MemoryPanel` on Brainstorm and Brief, and on Flowchart whenever no card or arrow is selected.

- [ ] **Step 1: Write the failing test** (`HistoryList.test.ts`): `a Claude reply groups into one row with Undo this reply` (mock `api.history` with three Claude entries sharing `turn: 't_1'` and one user entry; expect one `Undo this reply` button; clicking it calls `api.undoTurn('t_1')`).
- [ ] **Step 2:** Run it. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm test && npm run check && npm run lint && npm run build`; in a browser: Ctrl+Z after adding a group removes it, ↷ brings it back; save a version, change things, Preview shows the old state read-only, Restore brings it back and Undo reverses the restore; Export writes `<base>.design.md`.
- [ ] **Step 5:** Commit: `feat: memory panel, undo, versions and export`.

---

### Task 15: End-to-end check, docs, cleanup

**Files:**
- Modify: `README.md` (v2 usage: install and build steps, tabs, Brainstorm controls, memory, history, versions, pictures, export, MCP tool list, dev workflow `npm run dev` + server on 4777), `server.mjs` startup banner (adds `Build: npm run build` hint when `dist/` is missing)

- [ ] **Step 1:** Run `npm install && npm run build && npm test && npm run check && npm run lint`. Expected: all green.
- [ ] **Step 2:** Start `node server.mjs /tmp/ib-e2e/board.json`. In the browser, on Brainstorm, create group `Wizards` with entries `Familiars` (ticked) and `Fireballs`; rule out `Fireballs` with reason `not damage dealers`; select the group and send `What else could they do?`. Expected: background Claude adds at least one Claude-added entry or object; nothing it adds resembles fireballs, or its reply says fireballs were ruled out; the chat reply names what it changed; History shows one Claude group with `Undo this reply`, and using it removes exactly what that reply added.
- [ ] **Step 3:** Paste a picture, then ask in chat `What do you think of this picture?` with it selected. Expected: the reply refers to what is in the image.
- [ ] **Step 4:** Load a copy of the v1 sample board (`/tmp/idea-board-demo/idea-board.json`, if present) with `node server.mjs <copy>`. Expected: the Flowchart tab shows its cards and arrows; the Brief tab shows its sections; chat history is intact.
- [ ] **Step 5:** Update README, commit: `docs: v2 README`.
