# Agent Colab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** From the Collaborate tab, pick OpenRouter models, give each a role, and have them take turns designing on the board, with roles and shared rules editable globally and per board.

**Architecture:** The board server gains a run controller (`lib/colab/`) that plays turns against OpenRouter's chat API, using the board's existing MCP tool layer with a per-agent author. Agents are authors of their own (`agent:<id>`), named from a roster saved in the board; any non-`user` author is "an AI" for markers, flash, turns and chat handling. The page gets an Agents panel and a role editor in the Collaborate tab; run status reaches it over the existing server-sent events.

**Tech Stack:** Node ≥18 server with no runtime dependencies, `node:test`; Svelte 5 (runes), TypeScript, Tailwind 4, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-10-23-agent-colab-design.md`. The reference implementation of the turn loop, prompts and default roles is `~/Dev/games/ninjas/colab.mjs` (read it before Task 4).

## Global Constraints

- No runtime dependencies on the server; use global `fetch`.
- The OpenRouter key is read on the server only, from `OPENROUTER_API_KEY` or `~/.config/openrouter/key`; no response, event or board field ever contains it. The page only gets `hasKey: boolean`.
- OpenRouter: `POST https://openrouter.ai/api/v1/chat/completions` with `usage: { include: true }`; models from `GET https://openrouter.ai/api/v1/models`, keeping those whose `supported_parameters` includes `"tools"`.
- A dropped connection retries twice, after 2 s then 8 s.
- Turn rules: at most 15 tool calls per turn; tools hidden from agents: `wait_for_chat`, `reply`, `undo_reply`, `restore_version`; chat transcript = last 40 messages, the user shown as "Host".
- Defaults: rounds 5, budget $5. Budget is checked before each turn.
- Default shared rules: the user's text, verbatim from the spec section "Default shared rules". Default roles: `creative`, `qa`, `foreman`, `systems`, names and job texts verbatim from `ROLES` in `~/Dev/games/ninjas/colab.mjs`.
- Global library file: `<config dir>/idea-board/colab.json`; config dir is `$XDG_CONFIG_HOME` or `~/.config` on Linux, `~/Library/Application Support` on macOS, `%APPDATA%` on Windows.
- With no agents in the line-up, everything behaves exactly as before (existing tests keep passing unchanged).
- Copy: chat posts are labelled "Model · Role" (e.g. "GPT 6.1 Sol · Foreman"); the status line reads "Round 2 of 5 · Gemini 4 Argon's turn"; a waiting run reads "Waiting for your first message".

## Review Focus

1. **OpenRouter refuses the call** (HTTP 402 out of credits, 401 bad key, an HTML error page instead of JSON) → the turn fails with a readable reason; 401 and 402 end the run (every later turn would fail the same way) with a chat note saying why. Test in Task 3 and Task 4.
2. **A model sends malformed tool arguments or calls a tool that doesn't exist** → the tool result tells it the error and the turn continues. Test in Task 4.
3. **The line-up is edited while a run is active** (a second tab, or a stale page) → the server rejects it (`409`) and the run is unaffected. Test in Task 5.
4. **Start pressed twice** (double click, two tabs) → one run; the second request gets `409`. Test in Task 5.
5. **The model list can't be fetched** (offline) → the panel says so, saved agent cards still show their model ids, and Start still works with them. Test in Task 7.

---

### Task 1: Agents as authors

Make `agent:<id>` a valid author, named from a roster in the board, and treat every non-user author as an AI everywhere the server says "Claude".

**Files:**
- Create: `lib/authors.mjs`
- Modify: `lib/board.mjs` (AUTHORS check, `emptyBoard`, `migrateBoard`, `case 'chat'`), `lib/brainstorm.mjs:145,242` (`claudeAdded`), `lib/store.mjs` (every `author === 'claude'`), `lib/export.mjs:75`
- Test: `test/authors.test.mjs`

**Interfaces:**
- Produces:
  - `isAi(author: string): boolean`: true for `'claude'` and `agent:*`.
  - `agentId(model: string, roleId: string): string`: `'agent:' + model + '=' + roleId`, the identity rule from the spec (model + role pair).
  - `authorName(board, author): string`: `'You'`, `'Claude'`, or the roster entry's `name` (`'Model · Role'`); an unknown agent id falls back to the text after `agent:`.
  - `board.colab = { roster: RosterEntry[], lineup: { agents: LineupAgent[], rounds: number, budget: number }, extras: { rules: string, roles: Record<roleId, string> }, run: null | { round: number, spent: number } }`
  - `RosterEntry = { id: string, model: string, roleId: string, name: string, modelName: string, color: string }` (`name` is "Model · Role", `modelName` just "Model"); `LineupAgent = { model: string, roleId: string, settings: object }`.
  - `applyOp` accepts an author that is `'user'`, `'claude'`, or an `agent:` id present in `board.colab.roster`; others throw `OpError('unknown author')`.

- [ ] **Step 1: Write the failing tests** in `test/authors.test.mjs`:
  - `isAi`: `isAi('claude')`, `isAi('agent:openai/gpt=qa')` true; `isAi('user')` false.
  - `migrateBoard({})` and `emptyBoard()` both have `colab` deep-equal to `{ roster: [], lineup: { agents: [], rounds: 5, budget: 5 }, extras: { rules: '', roles: {} }, run: null }`.
  - On a `BoardStore` with a roster entry `{ id: 'agent:x/y=qa', model: 'x/y', roleId: 'qa', name: 'Y · QA', modelName: 'Y', color: 'amber' }`: `store.apply({ type: 'addObject', kind: 'group', title: 'G' }, 'agent:x/y=qa')` gives an object with `claudeAdded: true` and `author: 'agent:x/y=qa'`; the history row has a `turn` that is not `u<seq>`; an `agent:` id not in the roster throws `unknown author`.
  - An agent `chat` op marks earlier user messages `handled: true` and ends the turn: two agent changes before its chat share a turn; a change after it has a new one.
  - `authorName(board, 'agent:x/y=qa') === 'Y · QA'`, `authorName(board, 'user') === 'You'`.
  - Export: a ruled-out record `by: 'agent:x/y=qa'` renders "Y · QA" in the design doc.

- [ ] **Step 2: Run** `node --test test/authors.test.mjs`. Expected: FAIL (module not found).

- [ ] **Step 3: Implement.** `lib/authors.mjs` with the three functions. In `board.mjs`, replace `AUTHORS.includes(author)` with a check that also accepts roster ids; `emptyBoard` adds `colab`; `migrateBoard` fills a missing or partial `colab` from the empty one. In `case 'chat'` and every `author === 'claude'` in `store.mjs`, `brainstorm.mjs` and `export.mjs`, use `isAi(author)`; `export.mjs` names authors with `authorName`. The `answers` list stays Claude-only behaviour as today, generalised to `isAi`.

- [ ] **Step 4: Run** `npm run test:server`. Expected: all pass, including the new file.

- [ ] **Step 5: Commit** `feat: agents can author board changes under their own names`.

### Task 2: Tool runner per author

**Files:**
- Modify: `lib/mcp-tools.mjs:592-614` (`createToolRunner`), and the hard-coded `'claude'` in `save_version` (line ~508)
- Test: `test/mcp.test.mjs`

**Interfaces:**
- Consumes: Task 1's agent authors.
- Produces: `createToolRunner(store, presence, { author = 'claude' } = {})` → `{ call(name, args) }`; every op it applies, and `save_version`, use `author`. The MCP endpoint keeps calling it with no options.

- [ ] **Step 1: Failing test** in `test/mcp.test.mjs`: a runner made with `{ author: 'agent:x/y=qa' }` (roster entry added first) calling `add_group` produces an object whose `author` is `'agent:x/y=qa'`; a default runner still produces `'claude'`.
- [ ] **Step 2: Run** `node --test test/mcp.test.mjs`. Expected: the new test FAILS.
- [ ] **Step 3: Implement** the option; `context.apply` and `save_version` use it.
- [ ] **Step 4: Run** `npm run test:server`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: the board tools can act as any author`.

### Task 3: Global library, prompts and the OpenRouter client

Pure modules the run controller needs. Folded together because none is useful alone and each is small.

**Files:**
- Create: `lib/colab/library.mjs`, `lib/colab/prompts.mjs`, `lib/colab/openrouter.mjs`
- Test: `test/colab-library.test.mjs`, `test/colab-openrouter.test.mjs`

**Interfaces:**
- Produces:
  - `configDir(platform = process.platform, env = process.env, home = os.homedir()): string` per Global Constraints.
  - `DEFAULT_LIBRARY = { rules: string, roles: Role[] }` with `Role = { id: string, name: string, job: string }`; ids `creative`, `qa`, `foreman`, `systems`.
  - `class Library { constructor(file); get(): {rules, roles}; save({ rules, roles }): {rules, roles} }`: `get` creates the file with `DEFAULT_LIBRARY` when missing; `save` validates (rules string ≤ 20 000 chars; roles 1–20, unique non-empty ids matching `/^[a-z0-9-]{1,40}$/`, name ≤ 80, job ≤ 20 000) and writes atomically. Throws `OpError` on bad input.
  - `systemPrompt({ me: RosterEntry, others: RosterEntry[], job: string, rules: string }): string`: identity line, "Your role: …", rules, then the fixed `TURN_RULES` (the "How to play your turn" list from the reference script, minus anything game-specific).
  - `turnMessage(board, me: RosterEntry): string`: "The chat so far:\n\n" + last 40 messages (user → `Host: text`, others → `Name: text` via `authorName`) + "\n\nIt is your turn, <name>."
  - `stripSelfTag(text: string, name: string): string`: drops a leading `**Name…:**` tag naming this agent (reference script's regex).
  - `readKey(env = process.env, home = os.homedir()): string | null`.
  - `class OpenRouterError extends Error { status: number }`.
  - `class OpenRouter { constructor({ key, fetch = globalThis.fetch, sleep }); models(): Promise<Model[]>; complete({ model, messages, tools, settings }): Promise<{ message, cost: number }> }` where `Model = { id, name, promptPrice, completionPrice, context }` (prices per million tokens). `models()` caches for 1 hour. `complete` retries network errors per Global Constraints; HTTP errors throw `OpenRouterError` with `status` and a readable `message` (from the JSON `error.message`, else `HTTP <status>`); `settings` is spread into the request body.

- [ ] **Step 1: Failing tests.**
  - `configDir('linux', { XDG_CONFIG_HOME: '/x' }, '/h') === '/x'`; `('linux', {}, '/h') === '/h/.config'`; `('darwin', {}, '/h') === '/h/Library/Application Support'`; `('win32', { APPDATA: 'C:\\A' }, ...) === 'C:\\A'`.
  - `new Library(tmpFile).get()` writes and returns `DEFAULT_LIBRARY`; `foreman.job` contains "score from 1 to 10"; `rules` starts with "Every turn must contribute at least one meaningful creative idea."
  - `save` round-trips; `save({ rules: '', roles: [] })` and duplicate ids throw `OpError`.
  - `systemPrompt` contains the agent's name, each other name, the job and the rules; `turnMessage` shows a user message as `Host: …` and an agent's as `Y · QA: …`.
  - `stripSelfTag('**Y · QA:** Hi', 'Y · QA') === 'Hi'`; `stripSelfTag('Idea: hi', 'Y · QA') === 'Idea: hi'`.
  - OpenRouter with a fake `fetch`: `complete` returns `{ message, cost: 0.012 }` from a body with `usage.cost`; two `TypeError('fetch failed')` then success → succeeds after sleeps of 2000 and 8000 ms (fake `sleep`); three failures → throws; a 402 JSON body `{ error: { message: 'Insufficient credits' } }` → `OpenRouterError` with `status 402` and that message, no retry; an HTML 502 body → `OpenRouterError` "HTTP 502".
  - `models()` keeps only tool-capable entries, converts prices to per-million, and calls `fetch` once across two calls.
- [ ] **Step 2: Run** `node --test test/colab-library.test.mjs test/colab-openrouter.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement** the three modules.
- [ ] **Step 4: Run** `npm run test:server`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: role library, agent prompts and an OpenRouter client`.

### Task 4: The run controller

**Files:**
- Create: `lib/colab/run.mjs`
- Modify: `lib/store.mjs` (add `setColabRun(run)`: sets `board.colab.run`, saves, no history, emits nothing), `lib/agent.mjs` (`nudge` returns early when an injected `quiet()` is true)
- Test: `test/colab-run.test.mjs`

**Interfaces:**
- Consumes: Tasks 1–3 (`agentId`, `createToolRunner(…, { author })`, `TOOLS`, `Library`, `systemPrompt`, `turnMessage`, `stripSelfTag`, `OpenRouter`).
- Produces:
  - `class ColabRun { constructor({ store, presence, library, openrouter }); get status(): RunStatus; start(): void; stop(): void; onUserMessage(): void; recoverAfterRestart(): void }`
  - `RunStatus = { state: 'idle' | 'waiting' | 'running' | 'stopping', round: number, rounds: number, current: string | null /* roster id */, spent: number, budget: number }`
  - Emits `store.emit({ type: 'colab', status })` on every status change.
  - `Agent` constructor option `quiet: () => boolean` (default `() => false`).

Behaviour (spec "Running"; reference `takeTurn` and `main`):
- `start()` throws `OpError` if not idle, if the line-up is empty, or if a line-up role id is missing from the library. It adds roster entries for line-up agents not yet in the roster (`modelName` as in the reference `nameOf`, `name` `"<modelName> · <role name>"`; colours cycle through `['amber', 'sky', 'green', 'violet', 'rose']`), goes to `waiting`.
- `onUserMessage()` while `waiting` starts round 1 (only messages posted after `start()` count, per the spec).
- Each turn: re-read library and board extras (edits apply next turn); tools = `TOOLS` minus the hidden ones, as OpenAI function definitions; a fresh `createToolRunner(store, presence, { author: entry.id })`; loop up to 15 tool calls (malformed JSON arguments or an unknown tool → the tool message is `Error: <message>`); out of calls → ask for the closing message without tools; post `stripSelfTag(text)` (or `(said nothing)`) with `store.apply({ type: 'chat', text }, entry.id)`. `setColabRun({ round, spent })` after every turn.
- Before each turn: stop if `stop()` was called or `spent >= budget` (post a chat note authored `'claude'`: "Agent run stopped: budget of $5 reached ($5.12 spent)."). A failed turn posts `(my turn failed: <reason>)` under the agent and continues, except `OpenRouterError` 401/402, which ends the run with a note naming the reason.
- At the end (any reason): `setColabRun(null)`, state `idle`.
- `recoverAfterRestart()`: if `board.colab.run` is set, post "The agent run stopped when the server restarted, after round N; $X spent." (author `'claude'`) and `setColabRun(null)`.

- [ ] **Step 1: Failing tests** in `test/colab-run.test.mjs`, using a real `BoardStore` on a temp file, a `Library` on a temp file, and a fake `openrouter` whose `complete` returns scripted messages and `cost: 0.1`:
  - `start()` → status `waiting`; no `complete` call until `onUserMessage()` after a new user chat message; a user message posted before `start()` does not start it.
  - Two agents, 2 rounds, each scripted to call `add_note` once then answer "done": four chat posts in order A, B, A, B, labelled by roster names; notes authored by each agent; status `idle` at the end; `board.colab.run === null`.
  - Malformed tool arguments (`'{nope'`) and an unknown tool name each produce a tool message starting `Error:` and the turn still completes.
  - Budget 0.25 with cost 0.1 per call → stops before the turn that would start at ≥ 0.25 and posts the budget note.
  - `stop()` during a turn → state `stopping`, the turn finishes, no further turn.
  - A turn whose `complete` throws `new Error('boom')` posts "(my turn failed: boom)" and the next agent still plays; an `OpenRouterError` with status 402 ends the run with a note containing its message.
  - `start()` twice throws; `start()` with an empty line-up throws.
  - After a run, `Agent.nudge()` with `quiet: () => run.status.state !== 'idle'` does nothing during a run, and there are no unhandled user messages after it ends.
  - `recoverAfterRestart()` on a board with `colab.run = { round: 2, spent: 0.61 }` posts "after round 2; $0.61 spent" and clears it.
- [ ] **Step 2: Run** `node --test test/colab-run.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement** `ColabRun`, `setColabRun`, and the `quiet` option.
- [ ] **Step 4: Run** `npm run test:server`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: agents take turns on the board`.

### Task 5: Server routes and board ops

**Files:**
- Modify: `server.mjs` (`createServer` takes `colab`; routes; `main()` wires `Library`, `OpenRouter`, `ColabRun`, `Agent({ quiet })`, calls `recoverAfterRestart()`; chat ops also call `colab?.onUserMessage()`), `lib/board.mjs` (ops `setColabLineup`, `setColabExtras`), `lib/store.mjs` (both ops in `SYSTEM_OPS`), `test/helpers.mjs` (`withServer` accepts a `colab` option)
- Test: `test/server.test.mjs`

**Interfaces:**
- Consumes: Task 4's `ColabRun`.
- Produces (all JSON):
  - `GET /api/colab` → `{ status: RunStatus, hasKey: boolean, library: { rules, roles } }`
  - `GET /api/colab/models` → `{ models: Model[] }`; on failure `502 { error }`.
  - `PUT /api/colab/library` body `{ rules, roles }` → `{ library }`; bad input `400`.
  - `POST /api/colab/start` → `{ status }`; `409 { error }` if a run is active; `400` for an empty line-up or missing role; `400 { error: 'No OpenRouter key…' }` without a key.
  - `POST /api/colab/stop` → `{ status }`.
  - Op `{ type: 'setColabLineup', agents: LineupAgent[], rounds: 1–50, budget: 0.1–100 }` (max 8 agents; model ≤ 200 chars; settings an object or omitted) and `{ type: 'setColabExtras', rules?: string, roles?: Record<string, string> }`. `setColabLineup` throws `OpError('a run is in progress')` while the run is not idle, mapped to `409` by `/api/op` (add an `OpError` subclass `ConflictError` with `status = 409`). Neither op is recorded in history.
  - SSE: the `colab` events from Task 4 pass through the existing `/api/events` stream unchanged.

- [ ] **Step 1: Failing tests** in `test/server.test.mjs` with a fake `colab` object where useful and a real `ColabRun` with a fake OpenRouter for start/stop:
  - `GET /api/colab` never includes the key string (set a key via env in the test and assert the response text does not contain it); `hasKey` reflects it.
  - `setColabLineup` saves and is not in `/api/history`; out-of-range rounds → `400`.
  - With a run waiting: `setColabLineup` → `409`; a second `POST /api/colab/start` → `409`.
  - `PUT /api/colab/library` round-trips and rejects duplicate role ids with `400`.
  - A user chat op while waiting starts round 1 (the fake `complete` is called).
- [ ] **Step 2: Run** `node --test test/server.test.mjs`. Expected: new tests FAIL.
- [ ] **Step 3: Implement** the routes, ops and wiring.
- [ ] **Step 4: Run** `npm test` (server and web). Expected: PASS.
- [ ] **Step 5: Commit** `feat: the server runs agent colabs from the page`.

### Task 6: Names and colours on the page

**Files:**
- Create: `web/src/lib/authors.ts`
- Modify: `web/src/lib/types.ts` (`Author = 'user' | 'claude' | \`agent:${string}\``; `Board.colab`; `RunStatus`, `Role`, `Model`, `LineupAgent`, `RosterEntry`), `web/src/lib/format.ts` (remove `whoName`, callers use `authorName`), `web/src/lib/live.svelte.ts` (flash for `isAi`; `colab` event → `live.colab: RunStatus | null`), `web/src/components/Chat.svelte`, `web/src/brainstorm/ClaudeMark.svelte` (prop `by: string`), `web/src/views/BrainstormView.svelte`, `web/src/brainstorm/EntryRow.svelte`, `web/src/memory/HistoryList.svelte`, `web/src/memory/RuledOutList.svelte`, `web/src/brief/SectionBox.svelte`, `web/src/flow/NodeCard.svelte`, `web/src/test-board.ts` (empty `colab`)
- Test: `web/src/lib/authors.test.ts`, `web/src/components/Chat.test.ts`

**Interfaces:**
- Produces: `isAi(author)`, `authorName(board, author)` (same rules as Task 1), `authorColor(board, author): string` (a CSS colour: Claude keeps `var(--color-claude)`, the user `var(--color-accent)`, agents a fixed hex per roster `color`).

- [ ] **Step 1: Failing tests:** `authorName` cases as in Task 1; a Chat test where a message with `role: 'agent:x/y=qa'` (roster name "Y · QA") shows "Y · QA" as its label; the status line shows "Round 2 of 5 · Y's turn" (the roster `modelName`) when `live.colab = { state: 'running', round: 2, rounds: 5, current: 'agent:x/y=qa', … }` and "Waiting for your first message" when `state: 'waiting'`; a brainstorm object authored by that agent shows "Y · QA added".
- [ ] **Step 2: Run** `npx vitest run web/src/lib/authors.test.ts web/src/components/Chat.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**, replacing every `=== 'claude'` display check in the listed files with `isAi`/`authorName`/`authorColor`.
- [ ] **Step 4: Run** `npm run test:web && npm run check && npm run lint`. Expected: PASS, 0 errors.
- [ ] **Step 5: Commit** `feat: the page shows which agent did what`.

### Task 7: The Agents panel

**Files:**
- Create: `web/src/colab/AgentsPanel.svelte`, `web/src/colab/ModelPicker.svelte`, `web/src/colab/colab.svelte.ts` (page-side state: library, models, hasKey; loads `GET /api/colab` and the models once)
- Modify: `web/src/lib/api.ts` (`colab()`, `colabModels()`, `saveLibrary()`, `startColab()`, `stopColab()`), `web/src/views/CollaborateView.svelte` (chat left, panel right, as in the mockup)
- Test: `web/src/colab/AgentsPanel.test.ts`

**Interfaces:**
- Consumes: Task 5 routes; `live.colab`; `board.colab.lineup`.
- Produces: `AgentsPanel` (no props); `ModelPicker` props `{ value: string, models: Model[] | null, onchange: (id: string) => void }`; `colabState` exported from `colab.svelte.ts` with `library`, `models`, `modelsError`, `hasKey`, `load()`.

Behaviour (spec "Setting up", mockup): cards in line-up order with number, model picker (type to filter by id or name; shows price per M in/out), role select, ✕; drag a card to reorder; "+ Add agent" adds `{ model: '', roleId: 'creative' }`; rounds and budget inputs; "$0.42 of $5" while running; Start (disabled without a key, with an empty line-up, with a card missing a model, or a role missing from the library, saying which) / Stop ("Stopping…" while stopping); the active card highlighted; "Edit roles…" opens Task 8's editor. Every line-up edit sends `setColabLineup`; inputs disabled unless `live.colab.state === 'idle'`. No key → the panel shows the key file path and the command from the README.

- [ ] **Step 1: Failing tests** (mock `$lib/api`):
  - Adding two agents and choosing models and roles sends `setColabLineup` with them in order.
  - Start is disabled with no key (message mentions `~/.config/openrouter/key`), and with a card with no model.
  - While `live.colab.state === 'running'`: inputs are disabled, the current card has `aria-current="true"`, Stop calls `stopColab`, and the spend shows "$0.42 of $5".
  - `colabModels` rejecting → the panel shows "Couldn't load the model list" and a card with model `openai/gpt-6.1-sol` still shows that id, and Start is enabled.
- [ ] **Step 2: Run** `npx vitest run web/src/colab/AgentsPanel.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run test:web && npm run check && npm run lint`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: pick agents and run them from the Collaborate tab`.

### Task 8: The role editor

**Files:**
- Create: `web/src/colab/RoleEditor.svelte`
- Modify: `web/src/colab/AgentsPanel.svelte` (opens it)
- Test: `web/src/colab/RoleEditor.test.ts`

**Interfaces:**
- Consumes: `colabState.library`, `saveLibrary()`, op `setColabExtras`, `Draft` from `$lib/draft.svelte` for each text field.
- Produces: `RoleEditor` props `{ onclose: () => void }`.

Behaviour (spec "The role editor", mockup): a panel over the tab, closed by ✕ or Escape. Left list: "Shared rules", the roles, "+ New role" (creates `{ id: slug of "New role" made unique, name: 'New role', job: '' }`). Right: name (roles only), "Job, every board" / "Rules, every board" (saved to the library), "Extra for this board" (saved with `setColabExtras`). Delete role (not for the last one) with a confirm. Saves follow the existing Draft pattern (after a pause and on blur). A line-up card whose role no longer exists shows "Role missing".

- [ ] **Step 1: Failing tests:** editing the Foreman's job saves the library with the new text (after the Draft delay); editing "Extra for this board" sends `setColabExtras` with `roles: { foreman: '…' }`; editing shared rules extra sends `rules`; "+ New role" adds a role and selects it; deleting a role used by a card makes that card show "Role missing".
- [ ] **Step 2: Run** `npx vitest run web/src/colab/RoleEditor.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run test:web && npm run check && npm run lint`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: edit agent roles and shared rules`.

### Task 9: Docs and a real run

**Files:**
- Modify: `README.md` (Collaborate section: agents, roles, key setup with the one-line command, cost note, Stop)

- [ ] **Step 1:** Update the README.
- [ ] **Step 2:** `npm run build`; start `node server.mjs <tmp board> --no-agent --no-open`; in a browser add two cheap agents (e.g. `anthropic/claude-haiku-5.5` creative, `openai/gpt-6-luna` qa), 1 round, budget $0.50; Start; post a kickoff. Expected: "Waiting for your first message", then each card lights up in turn, chat posts labelled "Model · Role", board objects marked "<name> added", History rows named by agent, and status back to idle with spend shown. Then restart the server mid-run and confirm the restart note.
- [ ] **Step 3:** `npm test && npm run check && npm run lint`. Expected: all pass.
- [ ] **Step 4: Commit** `docs: agent colab in the README`.
