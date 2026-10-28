# Defaults File Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every behaviour text an agent is given lives in one `defaults.json` shipped with the app; the host edits that file and the next agent turn uses it.

**Architecture:** A small `lib/defaults.mjs` reads, validates and caches `defaults.json` (re-reading when the file changes, keeping the last good copy if an edit breaks it). The library, audit, prune, card prompts, Claude's binary prompts and the MCP session texts all ask it for their text; the code keeps only the short "how the machine works" lines.

**Tech Stack:** Node 18+ ESM, no runtime deps; `node --test`; Svelte page unchanged.

**Spec:** `docs/superpowers/specs/2026-10-27-defaults-file-design.md`

## Global Constraints

- No runtime dependencies; Node 18+ (`node:fs`, `node:path` only).
- `defaults.json` lives at the repo root next to `server.mjs`; keys exactly `shared`, `roles`, `chat`, `turn`, `answer`, `audit`, `prune`. `roles` is an object of role name → job.
- Limits as the library's: role names ≤ 80 chars, every text ≤ 20,000, 1–20 roles, unique ids.
- Role id = first word of the name, lower case, a-z0-9 only (≤ 40 chars); a clash gets `-2`, `-3`…; no word at all → `role`.
- The user's `colab.json` keeps its shape (`rules`, `roles` array of `{id, name, job, pictures?}`, `passes`); an existing one is never rewritten by this change.
- The OpenRouter key never reaches the page or a board file. Don't call Claude or OpenRouter in tests.
- `npm test`, `npm run lint` and `npm run check` pass after every task. Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A save that breaks the file while the server runs** (half-typed JSON): agents keep the last good texts and the log gets one line per broken version, not one per turn. → Task 1 test "a broken edit keeps the last good copy and logs once".
2. **Editors that save by rename** (new inode, same path): the change is still picked up. → Task 1 test "an edit saved by rename is picked up".
3. **A UTF-8 BOM** (Windows editors) at the start of the file: it still loads. → Task 1 test "a BOM is ignored".
4. **Two roles with the same first word** ("Art Director", "Art Lead") or a name with no letters: distinct, valid ids. → Task 1 `roleId` test.
5. **An existing `colab.json`** (the host's, with old rules and an `Art Director` with id `new-role`): untouched on startup and on read. → Task 2 test "an existing library file is left alone".

---

### Task 1: The defaults file and its loader

**Files:**
- Create: `defaults.json` — today's texts moved over **unchanged** (Task 4 rewrites them): `shared` = `DEFAULT_LIBRARY.rules`; `roles` = the four default roles as name → job, in today's order; `chat` = `SYSTEM_PROMPT` (lib/agent.mjs) minus its last two rules (the file-reading line and "Finish with … do not call reply yourself" — mechanics, see Task 3) but keeping "Finish with a short chat reply (one to three sentences) saying what you changed."; `turn` = `TURN_RULES` minus its last bullet's mechanics sentence ("Your final reply, as plain text … do not look for one."); `answer` = `ANSWER_RULES` minus its last bullet; `audit` = `DEFAULT_AUDIT_TEXT`; `prune` = `PRUNE_SYSTEM_PROMPT`.
- Create: `lib/defaults.mjs`
- Test: `test/defaults.test.mjs`

**Interfaces:**
- Produces:
  - `defaultsFile(): string` — `process.env.IDEA_BOARD_DEFAULTS` if set, else the repo's `defaults.json` (resolved from `import.meta.url`). Read on every call so tests can point it at a fixture.
  - `roleId(name: string, taken: Set<string>): string`
  - `readDefaults(file: string): Texts` — reads, strips a leading BOM, parses, validates; throws `Error` whose message starts with the file path, e.g. `/x/defaults.json: unknown key "turns"`.
  - `texts(file = defaultsFile(), { log = console.error } = {}): Texts` — cached per file by `mtimeMs` + `size` (via `fs.statSync`); re-reads when either changes. If a re-read fails and a good copy exists: return the good copy and `log(error.message)` once per broken mtime+size. If no good copy exists: throw.
  - `Texts = { shared: string, roles: Array<{id, name, job}>, chat, turn, answer, audit, prune: string }` (roles in file order, ids from `roleId`).

- [ ] **Step 1: Write the failing tests** in `test/defaults.test.mjs` (fixtures in a `mkdtemp` dir; a helper `write(dir, obj)` writes JSON and returns the path):
  - `the shipped file loads`: `readDefaults(defaultsFile())` → roles ids `['creative', 'qa', 'foreman', 'systems']`; every text key non-empty.
  - `roleId takes the first word`: `'Creative Director & Lore'`→`'creative'`, `'QA & Playtester'`→`'qa'`, `'Foreman'`→`'foreman'`; with `taken = new Set(['art'])`, `'Art Lead'`→`'art-2'`; with `taken = new Set(['art', 'art-2'])` → `'art-3'`; `'& !'`→`'role'`.
  - `readDefaults names the file and the problem`, each `assert.throws(..., re)`: missing file → `/defaults\.json: can't read it/`; `{` → `/not valid JSON/`; no `turn` → `/turn is missing/`; `turns` extra → `/unknown key "turns"/`; `chat: '  '` → `/chat must not be empty/`; `roles: {}` → `/roles must list 1 to 20 roles/`; a 81-char role name → `/longer than 80/`; `audit` of 20,001 chars → `/longer than 20000/`.
  - `a BOM is ignored`: file content `'﻿' + JSON` loads.
  - `texts sees an edit`: write with `turn: 'A'`, `texts(file).turn === 'A'`; rewrite with `turn: 'B'` and bump mtime (`fs.utimesSync(file, now, now + 2s)`) → `'B'`.
  - `an edit saved by rename is picked up`: write `turn: 'C'` to `file + '.tmp'`, `fs.renameSync` over the file, bump mtime → `'C'`.
  - `a broken edit keeps the last good copy and logs once`: good load, then write `{` and bump mtime; two calls with a `log` spy both return the good texts; spy called exactly once, with a message containing the file path.
  - `texts throws when there is no good copy`: fresh path holding `{` → throws `/not valid JSON/`.

- [ ] **Step 2: Run to verify they fail**
  Run: `node --test test/defaults.test.mjs`
  Expected: FAIL — `Cannot find module '../lib/defaults.mjs'`.

- [ ] **Step 3: Create `defaults.json` and implement `lib/defaults.mjs`** with the interfaces above. Validation order: object → no unknown keys → each of the six text keys present, a string, non-blank, ≤ 20000 → `roles` a non-array object with 1–20 entries, each name non-blank ≤ 80 and job a non-blank string ≤ 20000. Messages: `${file}: ${key} is missing`, `${file}: ${key} must not be empty`, `${file}: ${key} is longer than 20000 characters`, `${file}: unknown key "${k}"`, `${file}: roles must list 1 to 20 roles`, `${file}: role "${name}": name is longer than 80 characters`, `${file}: can't read it (${err.message})`, `${file}: not valid JSON (${err.message})`.

- [ ] **Step 4: Run to verify they pass**
  Run: `node --test test/defaults.test.mjs` → all PASS. Then `npm run lint`.

- [ ] **Step 5: Commit** — `git add defaults.json lib/defaults.mjs test/defaults.test.mjs && git commit -m "feat: defaults.json and its loader"`

---

### Task 2: Library, audit and prune take their defaults from the file

**Files:**
- Modify: `lib/colab/library.mjs` (drop `DEFAULT_LIBRARY`, `PASS_DEFAULTS`, the audit/prune imports), `lib/audit.mjs` (drop `DEFAULT_AUDIT_TEXT`; `AUDIT_FRAME` stays), `lib/prune.mjs` (drop `PRUNE_SYSTEM_PROMPT`; `Pruner` uses `passText`), `server.mjs` (`passDefaults()` in `/api/colab`; fail loudly at startup)
- Test: `test/colab-library.test.mjs`, `test/prune.test.mjs`, `test/server.test.mjs`, `test/pictures.test.mjs`, `test/colab-run.test.mjs`, `test/mcp.test.mjs` (replace `DEFAULT_LIBRARY` with `defaultLibrary()`)

**Interfaces:**
- Consumes: `texts()` from Task 1.
- Produces (in `lib/colab/library.mjs`):
  - `defaultLibrary(): { rules: string, roles: Array<{id, name, job}> }` — `{ rules: texts().shared, roles: texts().roles }`, a fresh copy each call.
  - `passDefaults(): { audit: string, prune: string }` — from `texts()`.
  - `passText(library, name)` — unchanged signature; falls back to `passDefaults()[name]`.
  - Pass names allowed in `validatePasses` stay exactly `audit` and `prune`.

- [ ] **Step 1: Update/write the failing tests**
  - colab-library `a missing library file is created from the defaults`: `deepEqual(lib, defaultLibrary())` and the file on disk equals it; ids `['creative', 'qa', 'foreman', 'systems']`; `lib.rules === texts().shared`.
  - colab-library new `an existing library file is left alone`: write `{ rules: 'Old.', roles: [{ id: 'new-role', name: 'Art Director', job: 'Draw.', pictures: true }], passes: { audit: 'Mine.' } }` to the file, record its bytes; `new Library(file).get()` returns it and the bytes are unchanged.
  - colab-library `passText` falls back to `texts().audit` (was `DEFAULT_AUDIT_TEXT`).
  - prune.test: the three `assert.match`es and the `deepEqual(seen, …)` use `texts().prune`.
  - server.test: `info.passDefaults.audit === texts().audit` and `info.passDefaults.prune === texts().prune`.
  - server.test new `the server won't start with a broken defaults file`: spawn `process.execPath server.mjs <tmp board> --port 4999 --no-open` with `IDEA_BOARD_DEFAULTS` = a temp file holding `{`; it exits with code 1 within 5 s and stderr includes that path and `not valid JSON`.

- [ ] **Step 2: Run to verify they fail**
  Run: `node --test test/colab-library.test.mjs test/prune.test.mjs test/server.test.mjs`
  Expected: FAIL — `defaultLibrary`/`passDefaults` not exported; the spawn test starts the server instead of exiting.

- [ ] **Step 3: Implement.** `Library.get()` writes `defaultLibrary()` when the file is missing. `Pruner.run` uses `passText(this.library?.get() ?? {}, 'prune')` (library.mjs no longer imports prune.mjs, so the cycle is gone; delete the "Same fallback as passText" comment). `run.mjs` audit paths keep `auditSystemPrompt(passText(...))`. In `server.mjs` `main()`, call `texts()` right after the help/usage checks; on error `console.error(error.message)` and `process.exit(1)`. It must exit before it listens.

- [ ] **Step 4: Run to verify they pass**
  Run: `npm run test:server` → all PASS. `npm run lint`.

- [ ] **Step 5: Commit** — `git commit -am "feat: the role library, audit and prune defaults come from defaults.json"` (add new files if any).

---

### Task 3: Every agent prompt reads the file; only mechanics stay in code

**Files:**
- Modify: `lib/colab/prompts.mjs` (drop `TURN_RULES`, `ANSWER_RULES`, the Brief/Brainstorm/Flowchart sentence), `lib/agent.mjs` (drop `SYSTEM_PROMPT`), `lib/colab/run.mjs` (`BINARY_TURN_END`), `lib/mcp-tools.mjs` (`TURN_NEXT`), `lib/mcp.mjs` (`INSTRUCTIONS`)
- Test: `test/colab-library.test.mjs`, `test/agent.test.mjs`, `test/colab-run.test.mjs`, `test/mcp.test.mjs`

**Interfaces:**
- Consumes: `texts()` from Task 1.
- Produces (mechanics constants, exact copy):
  - `lib/colab/prompts.mjs`: `export const REPLY_RULE = 'Your final reply, as plain text with no tool call, is posted to the chat under your name; there is no chat tool, so do not look for one.'`
  - `lib/agent.mjs`: `export const CHAT_MECHANICS = "You can read files in the project folder (Read, Glob, Grep), for example the code being built from this board. You can't change them. Your final message is posted to the board chat, so do not call reply yourself."`
  - `lib/colab/run.mjs`: `BINARY_TURN_END = 'Your final reply is posted to the chat under your name, as your message to the others.'`
  - `lib/mcp.mjs`: `export const MCP_MECHANICS = 'A shared idea board you and the user both edit. Every change is visible and undoable. Use batch to make several changes in one call. Use wait_for_chat to listen to the board chat; it also reports what the user changed on the board since you last looked. Answer the user with reply.'` and `mcpInstructions(): string` = `${MCP_MECHANICS}\n\n${texts().chat}`.
  - `lib/mcp-tools.mjs`: `turnNext(): string` = `` `It is your turn in the agents' run.\n\n${texts().turn}\n\nWhen you are done, call reply with your message to the others, then call wait_for_chat again.` ``

The prompts each agent gets (all texts read at the moment the prompt is built):

| Who | Built as |
|---|---|
| Card, `systemPrompt({me, others, job, rules, mode})` | `You are …` identity paragraph (unchanged) + `Your role: ${job}` + `${rules}` + (`answer` or `turn` text) + `REPLY_RULE`, joined by blank lines |
| Claude binary, any call (`#invoke`) | `${texts().chat}\n\n${CHAT_MECHANICS}`, then `\n\nYour role on this board:\n${role}` when there is one |
| Claude binary, run turn (`run.mjs` `binaryTurn`) | user prompt `${prompt}\n\n${texts().turn}\n\n${BINARY_TURN_END}` |
| Claude MCP session | `initialize` → `instructions: mcpInstructions()`; a turn's `wait_for_chat` result → `next: turnNext()` |

- [ ] **Step 1: Write the failing tests**
  - colab-library `systemPrompt names the agent, the others, the job and the rules`: parts now `['Y · QA', 'X · Creative', 'Your role: Find the holes.', 'Rule one.', texts().turn, REPLY_RULE]`; with `mode: 'answer'` it includes `texts().answer` and not `texts().turn`; neither includes `'The board has a Brief'`. Replace the `TURN_RULES` `/no tool call/` test with `REPLY_RULE` matching it.
  - colab-library new `a prompt uses the file as it is now`: set `process.env.IDEA_BOARD_DEFAULTS` to a fixture copy of `defaults.json` with `turn: 'TURN-A'`; `systemPrompt(...)` includes `TURN-A`; rewrite with `turn: 'TURN-B'`, bump mtime; next `systemPrompt(...)` includes `TURN-B`. Restore the env var in a `finally`.
  - agent.test (the fake binary at line ~140 echoes `--append-system-prompt`): the system prompt starts with `texts().chat`, includes `CHAT_MECHANICS`, and includes the role text when there is one.
  - colab-run: Claude's binary run turn — the fake `claude.takeTurn` sees a prompt that includes `texts().turn` and ends with `BINARY_TURN_END`, and doesn't include `3 to 5 sentences`.
  - mcp.test line 30: `init.result.instructions === mcpInstructions()` and it starts with `MCP_MECHANICS`. The turn `wait_for_chat` test asserts `next === turnNext()` and that it includes `texts().turn`.

- [ ] **Step 2: Run to verify they fail**
  Run: `npm run test:server`
  Expected: FAIL on the new assertions (missing exports; prompts still hard-coded).

- [ ] **Step 3: Implement** per the table. No behaviour text stays in these files; the data labels ("The chat so far:", "Since your last turn:", "It is your turn, X.", the wrap-up asks, prune settings) stay as they are.

- [ ] **Step 4: Run to verify they pass**
  Run: `npm test && npm run lint && npm run check` → all PASS.

- [ ] **Step 5: Commit** — `git commit -am "feat: every agent prompt reads defaults.json; only mechanics stay in code"`

---

### Task 4: The new texts, and the README

**Files:**
- Modify: `defaults.json`, `README.md`
- Test: `test/defaults.test.mjs`

**Interfaces:**
- Consumes: the file format from Task 1; the mechanics lines from Task 3 (the texts must not repeat or contradict them).

- [ ] **Step 1: Write the failing tests** in `test/defaults.test.mjs`, `the shipped texts follow the host's shared rules`:
  - `texts().shared` equals the spec's "shared (the host's, verbatim)" block exactly (copy it into the test as a constant; `\n` line breaks, no trailing newline).
  - No text in `turn`, `answer`, `chat` or any role job matches `/3 to 5 sentences|3 to 6/`.
  - `turn` mentions `PASS`; the Foreman job mentions `ask_agents` and `1 to 10`.
  - Role names are still `Creative Director & Lore`, `QA & Playtester`, `Foreman`, `Systems Designer` (ids unchanged).

- [ ] **Step 2: Run to verify they fail**
  Run: `node --test test/defaults.test.mjs` → FAIL on `shared` and the sentence counts.

- [ ] **Step 3: Rewrite the texts in `defaults.json`** per the spec's "What the reworded texts must do": `shared` verbatim; `turn`, `answer`, `chat` and the four jobs reworded to agree with it (overview level: scenes and what the player does, not pixels; 3 sentences max in chat; `PASS` is a good turn; no praise). `chat` must also say that in a run turn the turn rules in the message apply. `audit` and `prune` unchanged.

- [ ] **Step 4: Update `README.md`**: where it describes roles, passes or `colab.json`, say the starting texts and every agent prompt live in `defaults.json` at the repo root; `shared` and `roles` are copied into `~/.config/idea-board/colab.json` on first run and edited in the app (Edit roles…); `chat`, `turn` and `answer` are edited in the file and used on the next turn; a broken edit keeps the last good copy and is logged. Mention `IDEA_BOARD_DEFAULTS` for pointing at another file.

- [ ] **Step 5: Run everything** — `npm test && npm run lint && npm run check` → all PASS.

- [ ] **Step 6: Commit** — `git commit -am "feat: default texts written for the overview; README on defaults.json"`
