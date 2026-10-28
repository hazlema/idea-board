# Defaults File Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `defaults.json` ships every starting text; the user's `colab.json` is filled from it wherever it has nothing, the app edits every prompt, and Reset puts back the file's text.

**Architecture:** `lib/defaults.mjs` reads and validates `defaults.json` once (startup fails loudly if it's bad). `Library.get()` fills anything missing from it and writes the file back. Every agent prompt reads the user's library at the moment it's built; the code keeps only "how the machine works" lines. The page's Roles box gains a Prompts section and Reset buttons that use the defaults sent by `/api/colab`.

**Tech Stack:** Node 18+ ESM, no runtime deps, `node --test`; Svelte 5 + vitest.

**Spec:** `docs/superpowers/specs/2026-10-27-defaults-file-design.md`

## Global Constraints

- No runtime dependencies. Node 18+.
- `defaults.json` at the repo root; keys exactly `shared`, `roles`, `chat`, `turn`, `answer`, `audit`, `prune`; `roles` is an object of role name → job.
- Limits: role names ≤ 80 chars, every text ≤ 20,000, 1–20 roles, unique ids.
- Role id = first word of the name, lower case, a-z0-9 only (≤ 40 chars); a clash gets `-2`, `-3`…; no word → `role`.
- `colab.json` shape: `{ rules, roles: [{id, name, job, pictures?}], prompts: { chat, turn, answer, audit, prune } }`. Prompt names, in this order everywhere: `chat`, `turn`, `answer`, `audit`, `prune`.
- The OpenRouter key never reaches the page or a board file. No Claude or OpenRouter calls in tests.
- `npm test`, `npm run lint`, `npm run check` pass after every task. Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **The host's real `colab.json`** (old rules, `passes: { audit }`, an Art Director with id `new-role` and `pictures: true`): after one read, rules, roles and the audit text are kept, `chat`/`turn`/`answer`/`prune` are filled, `passes` is gone, and the file on disk says so. → Task 2 test "an old library file is filled and keeps what it had".
2. **The host clears a prompt box in the app**: the save comes back with the default in it, so no agent ever gets an empty prompt. → Task 2 test "a blank prompt is refilled".
3. **A hand-edited `colab.json` with a non-string or unknown prompt**: reading it doesn't crash; a bad value is replaced with the default, an unknown key dropped. → Task 2 test "bad prompt values are replaced".
4. **A BOM at the start of `defaults.json`, and two roles with the same first word**: it loads; ids stay distinct. → Task 1 tests.
5. **Reset when there's nothing to reset**: disabled while the text equals the default; absent for a role that isn't in `defaults.json`. → Task 4 tests.

---

### Task 1: `defaults.json` and its loader; the server refuses a bad one

**Files:**
- Create: `defaults.json` — today's texts **unchanged** (Task 5 rewrites them): `shared` = `DEFAULT_LIBRARY.rules`; `roles` = the four default roles, name → job, today's order; `chat` = `SYSTEM_PROMPT` (lib/agent.mjs) without its file-reading rule and without "Your final message is posted to the board chat, so do not call reply yourself." (both become mechanics in Task 3); `turn` = `TURN_RULES` without the sentence "Your final reply, as plain text with no tool call, is posted to the chat under your name; there is no chat tool, so do not look for one."; `answer` = `ANSWER_RULES` without its last bullet (the same sentence); `audit` = `DEFAULT_AUDIT_TEXT`; `prune` = `PRUNE_SYSTEM_PROMPT`.
- Create: `lib/defaults.mjs`
- Modify: `server.mjs` (`main()` calls `defaults()` after the usage checks; on error `console.error(error.message)`, `process.exit(1)`)
- Test: `test/defaults.test.mjs`, `test/server.test.mjs`

**Interfaces:**
- Produces:
  - `PROMPT_NAMES = ['chat', 'turn', 'answer', 'audit', 'prune']`
  - `DEFAULTS_FILE: string` — the repo's `defaults.json`, from `import.meta.url`.
  - `roleId(name: string, taken: Set<string>): string`
  - `readDefaults(file: string): Defaults` — strips a leading BOM, parses, validates; errors are `Error`s whose message starts with the file path.
  - `defaults(): Defaults` — `readDefaults(process.env.IDEA_BOARD_DEFAULTS || DEFAULTS_FILE)`, cached after the first success.
  - `Defaults = { shared: string, roles: Array<{id, name, job}>, prompts: { chat, turn, answer, audit, prune: string } }`

- [ ] **Step 1: Write the failing tests** (`test/defaults.test.mjs`; fixtures in `mkdtemp`):
  - `the shipped file loads`: `readDefaults(DEFAULTS_FILE)` → role ids `['creative', 'qa', 'foreman', 'systems']`; every prompt and `shared` non-blank; `Object.keys(prompts)` deep-equals `PROMPT_NAMES`.
  - `roleId takes the first word`: `'Creative Director & Lore'`→`'creative'`, `'QA & Playtester'`→`'qa'`, `'Foreman'`→`'foreman'`; taken `{'art'}`: `'Art Lead'`→`'art-2'`; taken `{'art','art-2'}`→`'art-3'`; `'& !'`→`'role'`.
  - `a BOM is ignored`: `'﻿' + JSON` loads.
  - `readDefaults names the file and the problem` (`assert.throws`, each message also includes the fixture path): missing → `/can't read it/`; `{` → `/not valid JSON/`; no `turn` → `/turn is missing/`; extra `turns` → `/unknown key "turns"/`; `chat: '  '` → `/chat must not be empty/`; `roles: {}` → `/roles must list 1 to 20 roles/`; an 81-char name → `/longer than 80/`; a 20,001-char `audit` → `/longer than 20000/`.
  - server.test `the server won't start with a broken defaults file`: spawn `process.execPath server.mjs <tmp board> --port 4999 --no-open` with env `IDEA_BOARD_DEFAULTS` = a temp file holding `{`; exits with code 1 within 5 s; stderr includes the path and `not valid JSON`.

- [ ] **Step 2: Run to verify they fail** — `node --test test/defaults.test.mjs test/server.test.mjs` → FAIL (module not found; the spawned server starts).

- [ ] **Step 3: Implement.** Validation order: object → unknown keys → `shared` and each prompt present, string, non-blank, ≤ 20000 → `roles` a non-array object with 1–20 entries, each name non-blank ≤ 80, job a non-blank string ≤ 20000. Messages: `${file}: ${key} is missing`, `… must not be empty`, `… is longer than 20000 characters`, `${file}: unknown key "${k}"`, `${file}: roles must list 1 to 20 roles`, `${file}: role "${name}": name is longer than 80 characters`, `${file}: can't read it (${err.message})`, `${file}: not valid JSON (${err.message})`.

- [ ] **Step 4: Verify** — same command → PASS; `npm run lint`.

- [ ] **Step 5: Commit** — `feat: defaults.json and its loader; the server refuses a bad one`

---

### Task 2: The library fills itself from the defaults; audit and prune read it

**Files:**
- Modify: `lib/colab/library.mjs` (drop `DEFAULT_LIBRARY`, `PASS_DEFAULTS`, `passText`, `validatePasses`, the audit/prune imports), `lib/audit.mjs` (drop `DEFAULT_AUDIT_TEXT`), `lib/prune.mjs` (drop `PRUNE_SYSTEM_PROMPT`), `lib/colab/run.mjs` (the two audit paths), `server.mjs` (`/api/colab` sends `defaults: defaults()` instead of `passDefaults`; `PUT /api/colab/library` passes `prompts` instead of `passes`)
- Test: `test/colab-library.test.mjs`, `test/prune.test.mjs`, `test/server.test.mjs`, `test/colab-run.test.mjs`, `test/pictures.test.mjs`, `test/mcp.test.mjs` (`DEFAULT_LIBRARY` → `defaultLibrary()`)

**Interfaces:**
- Consumes: `defaults()`, `PROMPT_NAMES` (Task 1).
- Produces (`lib/colab/library.mjs`):
  - `defaultLibrary(): Library` — `{ rules: shared, roles, prompts }` from `defaults()`, a fresh copy.
  - `fillLibrary(raw: object): { library: Library, changed: boolean }` — `rules` if not a string → `shared`; `roles` if not a non-empty array → default roles; `prompts[name]` taken from `raw.prompts[name]`, else `raw.passes[name]` (audit/prune), and if not a non-blank string → the default; unknown prompt keys and `passes` dropped. `changed` is true when the result differs from `raw` (compare JSON).
  - `Library.get()` — read (missing file = `{}`), `fillLibrary`, write back when `changed`, return.
  - `Library.save(input)` — validates `rules`/`roles` as now, and `prompts` if present (an object; only `PROMPT_NAMES` keys; strings ≤ 20000), then `fillLibrary`, writes, returns the filled library.
  - `Pruner` uses `this.library?.get().prompts.prune ?? defaults().prompts.prune`; audits use `library.get().prompts.audit`.

- [ ] **Step 1: Write the failing tests** (colab-library unless noted):
  - `a missing library file is created from the defaults`: `get()` deep-equals `defaultLibrary()` and the file on disk equals it; ids `['creative','qa','foreman','systems']`.
  - `an old library file is filled and keeps what it had`: file `{ rules: 'Old.', roles: [{ id: 'new-role', name: 'Art Director', job: 'Draw.', pictures: true }], passes: { audit: 'Mine.' } }` → `get()` gives `rules: 'Old.'`, those roles, `prompts.audit === 'Mine.'`, `prompts.chat/turn/answer/prune` equal `defaults().prompts`'s, no `passes`; the file on disk equals the result.
  - `a full library file is left byte-for-byte alone`: write `defaultLibrary()` with a custom `turn`, record bytes; `get()` twice; bytes unchanged.
  - `a blank prompt is refilled`: `save({ ...defaultLibrary(), prompts: { ...p, turn: '  ' } }).prompts.turn === defaults().prompts.turn`.
  - `bad prompt values are replaced`: file with `prompts: { chat: 5, other: 'x' }` → `get().prompts.chat` is the default, no `other`.
  - `save checks prompts`: `prompts: { other: 'x' }` → OpError; `prompts: { turn: 'x'.repeat(20001) }` → OpError; `prompts: 'x'` → OpError. (Replaces the old `passes` test and the `passText` test.)
  - prune.test: library stub `prompts: { prune: 'Cut hard.' }`; the `PRUNE_SYSTEM_PROMPT` assertions use `defaults().prompts.prune`.
  - server.test: `info.defaults` deep-equals `defaults()`; no `passDefaults`.

- [ ] **Step 2: Run to verify they fail** — `npm run test:server` → FAIL on the new assertions.

- [ ] **Step 3: Implement** per the interfaces.

- [ ] **Step 4: Verify** — `npm run test:server` → PASS; `npm run lint`.

- [ ] **Step 5: Commit** — `feat: the library fills itself from defaults.json, prompts included`

---

### Task 3: Every agent prompt reads the library; only mechanics stay in code

**Files:**
- Modify: `lib/colab/prompts.mjs`, `lib/agent.mjs`, `lib/colab/run.mjs`, `lib/mcp.mjs`, `lib/mcp-tools.mjs`, `lib/room.mjs`, `server.mjs`
- Test: `test/colab-library.test.mjs`, `test/agent.test.mjs`, `test/colab-run.test.mjs`, `test/mcp.test.mjs`, `test/room.test.mjs`

**Interfaces:**
- Consumes: `Library.get().prompts` (Task 2), `defaults()` (Task 1).
- Produces (mechanics, exact copy):
  - prompts.mjs: `REPLY_RULE = 'Your final reply, as plain text with no tool call, is posted to the chat under your name; there is no chat tool, so do not look for one.'`; `systemPrompt({ me, others, job, rules, guide, mode })` = identity paragraph (as today) + `Your role: ${job}` + `rules` + `guide` + `REPLY_RULE`, blank-line separated; no Brief/Brainstorm/Flowchart sentence. `run.mjs` passes `guide: library.prompts[mode === 'answer' ? 'answer' : 'turn']`.
  - agent.mjs: `CHAT_MECHANICS = "You can read files in the project folder (Read, Glob, Grep), for example the code being built from this board. You can't change them. Your final message is posted to the board chat, so do not call reply yourself."`; `agent.prompts` getter (default `() => defaults().prompts`); `#invoke`'s default system prompt = `${prompts().chat}\n\n${CHAT_MECHANICS}` + `\n\nYour role on this board:\n${role}` when there is one.
  - run.mjs: `BINARY_TURN_END = 'Your final reply is posted to the chat under your name, as your message to the others.'`; the binary turn sends `${prompt}\n\n${library.get().prompts.turn}\n\n${BINARY_TURN_END}`.
  - mcp.mjs: `MCP_MECHANICS = 'A shared idea board you and the user both edit. Every change is visible and undoable. Use batch to make several changes in one call. Use wait_for_chat to listen to the board chat; it also reports what the user changed on the board since you last looked. Answer the user with reply.'`; `mcpInstructions(chat: string): string` = `${MCP_MECHANICS}\n\n${chat}`; `createMcpHandler(tools, { listTools, instructions = () => MCP_MECHANICS })`; `Presence.prompts` getter (default `() => defaults().prompts`).
  - mcp-tools.mjs: `turnNext(turn: string): string` = `` `It is your turn in the agents' run.\n\n${turn}\n\nWhen you are done, call reply with your message to the others, then call wait_for_chat again.` ``; `wait_for_chat` on a turn returns `next: turnNext(presence.prompts().turn)`.
  - room.mjs constructor: `const prompts = () => this.library.get().prompts;` set on `presence.prompts` and `agent.prompts` (beside `role`). server.mjs: the main MCP handler gets `instructions: () => mcpInstructions(library.get().prompts.chat)`.

- [ ] **Step 1: Write the failing tests**
  - colab-library `systemPrompt …`: with `guide: 'Play well.'` includes the names, `Your role: Find the holes.`, `Rule one.`, `Play well.`, `REPLY_RULE`; not `The board has a Brief`. Replace the `TURN_RULES` `/no tool call/` test with `REPLY_RULE`.
  - colab-run: a card's system prompt in a run turn includes the library's `prompts.turn` (save a library with `turn: 'TURN-X'` first); answering, `prompts.answer`. Claude's binary run turn prompt includes `TURN-X`, ends with `BINARY_TURN_END`, and has no `3 to 5 sentences`.
  - agent.test (fake binary echoing `--append-system-prompt`, ~line 140): with `agent.prompts = () => ({ ...defaults().prompts, chat: 'CHAT-X' })`, the system prompt starts with `CHAT-X`, includes `CHAT_MECHANICS` and the role.
  - mcp.test line 30: `instructions === MCP_MECHANICS` for a handler without the option; a test with `instructions: () => mcpInstructions('CHAT-X')` ends with `CHAT-X`. The turn `wait_for_chat` test: `next === turnNext(presence.prompts().turn)` and includes it.
  - room.test: after `library.save({ ...defaultLibrary(), prompts: { ...p, turn: 'TURN-Y' } })`, `room.agent.prompts().turn === 'TURN-Y'` and `presence.prompts().turn === 'TURN-Y'`.

- [ ] **Step 2: Run to verify they fail** — `npm run test:server` → FAIL on the new assertions.

- [ ] **Step 3: Implement** per the interfaces. Data labels and wrap-up asks stay as they are.

- [ ] **Step 4: Verify** — `npm run test:server && npm run lint` → PASS.

- [ ] **Step 5: Commit** — `feat: every agent prompt comes from the library; only mechanics stay in code`

---

### Task 4: The page edits every prompt, with Reset to default

**Files:**
- Modify: `web/src/lib/types.ts` (`Passes` → `Prompts`; `Library.prompts?: Prompts`; new `Defaults`), `web/src/lib/api.ts` (`colab()` info: `defaults: Defaults` replaces `passDefaults`), `web/src/colab/colab.svelte.ts` (`defaults` replaces `passDefaults`), `web/src/colab/RoleEditor.svelte`, `web/src/colab/RolePane.svelte`
- Rename: `web/src/colab/PassPane.svelte` → `web/src/colab/PromptPane.svelte`
- Test: `web/src/colab/RoleEditor.test.ts`, `web/src/colab/ConnectionsPanel.test.ts` (fixtures: `defaults` instead of `passDefaults`)

**Interfaces:**
- Consumes: `/api/colab` `defaults` (Task 2): `{ shared: string; roles: Role[]; prompts: Prompts }`.
- Produces: `interface Prompts { chat: string; turn: string; answer: string; audit: string; prune: string }`; `interface Defaults { shared: string; roles: Role[]; prompts: Prompts }`; `PromptPane` props `{ name: keyof Prompts; save: (library: Library) => Promise<boolean> }`.

Behaviour: the nav's "Passes" heading becomes "Prompts" with, in order, **Chat (Claude)**, **Turn**, **Answer**, **Final audit**, **Prune** (selected values `prompt:<name>`). `PromptPane` shows `library.prompts?.[name] ?? defaults.prompts[name]`, saves the whole `prompts` object with that key changed, and has **Reset to default**, which saves the default text and is disabled while the text equals it. Help line under the box: chat "What Claude is told when you chat with it."; turn "What every agent is told when it takes a turn in a run."; answer "What an agent is told when it answers you."; audit/prune keep "Shared by every board. Focus a single run with /audit <text>." (or /prune). `RolePane` gets **Reset to default** on Shared rules (rules ← `defaults.shared`) and on a role whose id is in `defaults.roles` (job ← that role's job); disabled while equal; no button for other roles.

- [ ] **Step 1: Write the failing tests** (RoleEditor.test; replace the three pass tests):
  - `Turn shows the stored text, and editing saves prompts.turn`: library with `prompts: P` (all five set); open **Turn**; input `Play well.`; after 600 ms `saveLibrary` last called with `{ ...library(), prompts: { ...P, turn: 'Play well.' } }`.
  - `Reset on a prompt puts back the default and is disabled when equal`: `colabState.defaults.prompts.answer = 'Default answer.'`, stored `Mine.`; open **Answer**; click Reset → saved `prompts.answer === 'Default answer.'`; with stored equal to default, the button is disabled.
  - `Final audit and Prune still name their command`: open **Prune** → text `/prune` is shown.
  - `Reset on the Foreman puts back the default job; a role not in the defaults has none`: defaults roles `[{ id: 'foreman', name: 'Foreman', job: 'Default build.' }]`; open **Foreman**, Reset → saved foreman job `Default build.`; open **Creative** → no `Reset to default` button.
  - `Reset on Shared rules puts back the default rules`: `defaults.shared = 'Default rules.'`; open **Shared rules**, Reset → saved `rules: 'Default rules.'`.

- [ ] **Step 2: Run to verify they fail** — `npx vitest run web/src/colab` → FAIL.

- [ ] **Step 3: Implement** per the behaviour above.

- [ ] **Step 4: Verify** — `npm test && npm run lint && npm run check` → PASS. `npm run build`.

- [ ] **Step 5: Commit** — `feat: edit every prompt in the Roles box, with Reset to default`

---

### Task 5: The new texts, and the README

**Files:**
- Modify: `defaults.json`, `README.md`
- Test: `test/defaults.test.mjs`

- [ ] **Step 1: Write the failing test** `the shipped texts follow the host's shared rules`:
  - `defaults().shared` equals the spec's "shared (the host's, verbatim)" block exactly (a constant in the test; `\n` line breaks; no trailing newline).
  - `turn`, `answer`, `chat` and every role job: none matches `/3 to 5 sentences|3 to 6/`.
  - `turn` includes `PASS`; the Foreman job includes `ask_agents` and `1 to 10`.
  - Role names still `Creative Director & Lore`, `QA & Playtester`, `Foreman`, `Systems Designer`.

- [ ] **Step 2: Run to verify it fails** — `node --test test/defaults.test.mjs` → FAIL.

- [ ] **Step 3: Rewrite `defaults.json`** per the spec's "What the reworded texts must do". `audit` and `prune` unchanged.

- [ ] **Step 4: README** — where it describes roles, passes or `colab.json`: the starting texts live in `defaults.json` at the repo root; on first run (and whenever something is missing) they fill `~/.config/idea-board/colab.json`; every prompt is edited under Edit roles… and used on the next turn; Reset to default puts back the file's text; a broken `defaults.json` stops the server with a message.

- [ ] **Step 5: Verify** — `npm test && npm run lint && npm run check` → PASS.

- [ ] **Step 6: Commit** — `feat: default texts written for the overview; README on defaults.json`
