# Final audit, /audit and editable pass texts: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a run reaches the end of its last round, the Foreman audits the board read-only and
posts a report. `/audit` does the same on demand. The audit and prune instructions can be edited in
the Roles dialog.

**Architecture:**
- The two pass texts live in the role library (`colab.json`) under `passes`, stored only when edited.
  Their defaults stay in code.
- An audit is a fresh session with read-only board tools:
  - Claude runs it through the binary at `/mcp?audit=1`, which serves a read-only runner;
  - a card runs it as a one-off OpenRouter go with read tools only.
- ColabRun picks the auditor, runs it at the end of a run, and serves `/audit` through the Room.

**Tech stack:** Node 18+ ESM with `node --test` (server); Svelte 5 with vitest, run from the repo root (page).

**Spec:** `docs/superpowers/specs/2026-10-26-audit-and-pass-texts-design.md`

## Global constraints

- No new runtime dependencies. Match the surrounding style: short comments, plain-English user strings.
- Pass texts can be at most 20,000 characters (`MAX_TEXT` in `lib/colab/library.mjs`). An empty or
  whitespace-only text means "use the default" and isn't stored.
- **Exact strings:**
  - host line: `Audit the board.` / `Audit the board: <text>`;
  - refusal during a run: `The run ends with an audit.`;
  - Settings checkbox label: `Audit at the end of a run`.
- The audit must never change the board. Read-only is enforced by the server, not by the prompt.
- Never spend the user's Claude plan or OpenRouter key in automated checks. All tests use fakes.
- **Commits:**
  - one per task;
  - messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Checks before each commit:**
  - `npm test` (server);
  - `npx vitest run` from the repo root (page);
  - `npm run lint` and `npm run check`;
  - `npm run build` after page changes.

## Review focus

1. **Stop during an end-of-run audit.** It must abort the audit, post `(stopped partway through my
   turn)` (the existing cut text), and leave the run idle with no hang. Tests: Task 3.
2. **A batch carrying a write inside an audit.** The read-only runner must refuse each write inside
   `batch`, not only top-level calls. Tests: Task 2.
3. **A library file with no `passes` key, from before this change.** It loads with the defaults, and
   saving roles keeps any stored `passes`. Tests: Task 1.
4. **`/audit` while a prune pass is pending or running.** The audit waits for the pass, then runs; it
   never runs during it. Tests: Task 3.
5. **The Foreman is a card that is over budget or has no model.** The audit falls back to Claude's
   binary, or is refused or skipped with a reason. It never hangs. Tests: Task 3.

---

### Task 1: Pass texts in the library, and the prune pass uses them

**Files:**
- Create: `lib/audit.mjs`
- Modify:
  - `lib/colab/library.mjs`: `validate`, `DEFAULT_LIBRARY` stays without `passes`;
  - `lib/prune.mjs`: `Pruner` constructor and `run`;
  - `server.mjs`: GET `/api/colab` at about line 100, PUT `/api/colab/library` at about line 110, `new Pruner` at about line 302.
- Test: `test/colab-library.test.mjs`, `test/prune.test.mjs`, `test/server.test.mjs`

**Interfaces:**
- Produces from `lib/audit.mjs`:
  - `DEFAULT_AUDIT_TEXT: string`;
  - `AUDIT_FRAME: string`;
  - `AUDIT_TOOLS: Set<string>`, which is `view_board`, `view_picture`, `get_node`, `get_history` and `list_versions`;
  - `auditSystemPrompt(text: string): string`, which returns `${AUDIT_FRAME}\n\n${text}`;
  - `auditPrompt({ focus = '', snapshot = null }): string`.
- Produces from `lib/colab/library.mjs`:
  - `PASS_DEFAULTS: { audit: string, prune: string }`;
  - `passText(library, name: 'audit'|'prune'): string`, which returns the stored text when non-blank, else the default.
- Produces: `Pruner` constructor `{ store, agent, library }`, where `library` is optional. Without it, the pass uses `PRUNE_SYSTEM_PROMPT`.
- Produces: GET `/api/colab` adds `passDefaults: { audit, prune }`. PUT `/api/colab/library` accepts and returns `passes`.

**Copy fixed by the spec:**

`AUDIT_FRAME`:
> You are auditing a shared idea board for its host. You can only read it: your tools can't change anything, so don't try. Your final reply is posted to the chat as your audit report. The host reads it and decides what, if anything, to do.

`DEFAULT_AUDIT_TEXT`:
> Please audit the board and report any problems or inconsistencies: contradictions, duplicates, gaps, stale items, and anything in the Brief that is out of step with the rest of the board. One line per problem, saying where on the board it is. If you find none, say so.

`auditPrompt` returns:
- `Audit the board now.`;
- plus `\n\nThe host's focus for this audit: <focus>` when `focus.trim()` is non-empty;
- plus `\n\nThe board right now (what view_board returns):\n<snapshot>` when a snapshot is given.

- [ ] **Step 1: Write failing tests**
  - In `colab-library.test.mjs`:
    - `passes are optional, saved only when non-blank, and checked`:
      - saving `{rules, roles, passes: {audit: 'Check X', prune: '   '}}` stores `passes: {audit: 'Check X'}`;
      - `passes: {other: 'x'}` throws `OpError`;
      - a 20,001-character audit text throws;
      - a library without `passes` round-trips with no `passes` key.
    - `passText falls back to the default`:
      - `passText({rules:'',roles:[]}, 'audit') === DEFAULT_AUDIT_TEXT`;
      - with `passes.prune: 'Mine'` it returns `'Mine'`.
  - In `prune.test.mjs`: `a pass uses the library's prune text`. A fake agent records `systemPrompt`; with a library whose `get()` returns `passes.prune: 'Cut hard.'`, it equals `'Cut hard.'`. Without a library it equals `PRUNE_SYSTEM_PROMPT`.
  - In `server.test.mjs`: GET `/api/colab` has `passDefaults.audit === DEFAULT_AUDIT_TEXT`, and PUT with `passes: {audit: 'A'}` returns it.
- [ ] **Step 2: Run `npm test`.** The new tests fail.
- [ ] **Step 3: Implement.**
  - `validate` accepts `passes`: undefined, or an object whose only keys are `audit` and `prune`, with string values of at most `MAX_TEXT`. It drops blank values, and omits `passes` when nothing is left.
  - `PASS_DEFAULTS` imports `DEFAULT_AUDIT_TEXT` and `PRUNE_SYSTEM_PROMPT`. Check that `prune.mjs` doesn't import `library.mjs`, so there is no cycle.
  - `Pruner.run` uses `systemPrompt: this.library ? passText(this.library.get(), 'prune') : PRUNE_SYSTEM_PROMPT`.
  - In the server, the PUT passes `passes: body.passes`, and `connect()` passes `library` to `new Pruner`.
- [ ] **Step 4: Run `npm test`.** All pass.
- [ ] **Step 5: Commit** `feat: audit and prune texts live in the role library`.

### Task 2: A read-only runner, the audit MCP endpoint and `agent.audit()`

**Files:**
- Modify:
  - `lib/mcp-tools.mjs`: `permit`, `createToolRunner`;
  - `lib/mcp.mjs`, if it re-exports;
  - `server.mjs`: MCP routing at about lines 131–148;
  - `lib/agent.mjs`: the new `audit()`, and generalise `#pruneTurn`.
- Test: `test/mcp.test.mjs`, `test/agent.test.mjs`, `test/server.test.mjs`

**Interfaces:**
- Consumes: `AUDIT_TOOLS` from Task 1.
- Produces: `createToolRunner(store, presence, { …, readOnly: true })`. Any tool not in `AUDIT_TOOLS` throws `OpError('<tool> isn't allowed during an audit')`, at top level and in `batch`. `batch` itself is allowed, and each call is checked.
- Produces: `/mcp?audit=1` is served by `createToolRunner(store, null, { readOnly: true })`, with `listTools` limited to `AUDIT_TOOLS`.
- Produces: `agent.audit(prompt: string, { systemPrompt, timeoutMs, signal }) → Promise<{ ok: true, text } | { ok: false, error }>`. It takes the same binary lock as `prune`, with only Stop cutting the wait, and a fresh session that's never saved as `claudeSessionId`.
  - The MCP URL is `${mcpUrl}?audit=1`.
  - `--tools` is `FILE_TOOLS`.
  - `--disallowedTools` is `KEY_RULE` plus `mcp__board__<name>` for every tool in `TOOLS` that isn't in `AUDIT_TOOLS`.
  - `--append-system-prompt` is `systemPrompt`.
  - It emits `agent` working and idle like a prune.

- [ ] **Step 1: Write failing tests**
  - In `mcp.test.mjs`:
    - `a read-only runner reads but can't change the board`:
      - `view_board` works;
      - `add_group` throws `/isn't allowed during an audit/`;
      - `batch` with `[{tool:'view_board'},{tool:'add_group',args:{title:'x'}}]` returns `failed.index === 1`;
      - the board's group count is unchanged.
  - In `agent.test.mjs`, modelled on the existing prune test at about line 371:
    - `audit runs a fresh read-only session with file tools`. Check:
      - the URL ends with `?audit=1`;
      - `--tools` is `Read,Glob,Grep`;
      - `--disallowedTools` contains `mcp__board__add_group` and `Read(~/.config/openrouter/**)` but not `mcp__board__view_board`;
      - the system prompt is the given one;
      - `--session-id` is used, not `--resume`;
      - `store.board.claudeSessionId` is unchanged.
  - In `server.test.mjs`: a `tools/list` on `/mcp?audit=1` returns exactly the `AUDIT_TOOLS` names, and a `tools/call` of `add_group` there returns an error.
- [ ] **Step 2: Run `npm test`.** The new tests fail.
- [ ] **Step 3: Implement.**
  - `permit` gains `if (ctx.readOnly && !AUDIT_TOOLS.has(tool) && tool !== 'batch') throw …`.
  - `#pruneTurn` becomes a shared `#freshTurn(prompt, { systemPrompt, timeoutMs, signal, onStart, mcpUrl, tools, disallow })`, used by both `prune` and `audit`.
  - `#invoke` takes `tools` explicitly rather than inferring it from `disallow`.
- [ ] **Step 4: Run `npm test`.** All pass, including the existing prune tests.
- [ ] **Step 5: Commit** `feat: read-only audit runner and agent.audit()`.

### Task 3: ColabRun runs audits, at the end of a run and on request

**Files:**
- Modify:
  - `lib/colab/run.mjs`;
  - `lib/board.mjs`: lineup `auditAtEnd`, in the default at about line 37, the migration at about lines 64–66, and `setColabLineup` at about lines 391–395.
- Test: `test/colab-run.test.mjs`, `test/board.test.mjs`, and `test/server.test.mjs` line 292, whose expected lineup gains `auditAtEnd: true`.

**Interfaces:**
- Consumes:
  - `auditSystemPrompt` and `auditPrompt` (Task 1);
  - `passText` (Task 1);
  - `agent.audit` (Task 2), reached as `this.claude.audit`;
  - `createToolRunner(..., { readOnly: true })` (Task 2).
- Produces:
  - `colab.audit({ focus = '' }) → { ok: true, by: string } | { error: string }`. It is synchronous; the work runs in the background.
  - `status.auditing: boolean`.
  - `stop()` also aborts an audit.
  - `startError()` returns `'Wait for the audit to finish.'` while one runs.
  - The lineup gains `auditAtEnd: boolean`, default `true`. `setColabLineup` accepts an optional boolean (anything else throws `OpError('auditAtEnd must be true or false')`) and keeps the old value when it is omitted.

**Behaviour:**
- **`#auditor()`** returns, in order:
  1. Claude, if `lineup.claudeRoleId === 'foreman'` and `this.claude.found`;
  2. the first card whose `roleId === 'foreman'` and for which `canAnswer(id).ok`;
  3. Claude, if `this.claude.found`;
  4. otherwise `null`.

  Claude audits only through the binary, since an attached MCP session can't start fresh.
- **`audit()`:**
  - During a run (`state !== 'idle'`), it returns `{ error: 'The run ends with an audit.' }`.
  - If one is already going, it returns `{ error: 'An audit is already going.' }`.
  - With no auditor, it returns `{ error: 'No one can audit: give a connection the Foreman role, or install the claude command.' }`.
  - Otherwise it starts `#runAudit(id, focus)` after any prune pass pending or running: wait on `#pass?.done` and `#pruning`.
- **`#runAudit(id, focus, signal)`:**
  - Sets `#busy` with mode `'audit'` and activity `'auditing the board'`, and emits.
  - **Claude:** calls `this.claude.audit(auditPrompt({ focus }), { systemPrompt: auditSystemPrompt(passText(lib, 'audit')), timeoutMs: this.turnLimit, signal })`. On `ok` it posts the text as `'claude'`. Otherwise it posts `(stopped partway through my turn)` if stopped, or `(my turn failed: <error>)`.
  - **A card:** `#takeTurn(me, { mode: 'audit', focus, signal })`. The audit branch:
    - builds `messages` fresh: system = `auditSystemPrompt(...)`, user = `auditPrompt({ focus, snapshot })` where `snapshot` is `view_board` text;
    - never touches `this.conversations`;
    - offers only the `AUDIT_TOOLS` tools;
    - uses a `readOnly` runner;
    - counts spending as an answer does (`mode !== 'turn'`);
    - posts with `answers: []`;
    - is aborted by the given signal.
  - Posting uses `answers: []`, so the report never marks host messages answered.
- **End of a run:** in `#loop`, after the last round's `#roundPass()`, if `state === 'running'` and `lineup.auditAtEnd !== false`:
  - With an auditor, note `The run is over; <name> is auditing the board.` and await the audit (the run's state stays `running`, so Stop works).
  - Without one, note `Skipped the final audit: no one can audit.`
  - Then `#end()`.
  - The early returns (Stop, budget, `'end'`) never audit.

- [ ] **Step 1: Write failing tests** in `colab-run.test.mjs`, using `fakePruner` and a `claude` fake with `{ via, found: true, audit: async (p, o) => { calls.push({ p, o }); return { ok: true, text: 'All good.' }; } }`.
  - `a run that reaches its last round ends with the Foreman's audit`: Claude's role is the foreman. After `run.finished`:
    - the chat holds the note `The run is over; Claude is auditing the board.` and then `All good.` from `claude`;
    - the `systemPrompt` starts with `AUDIT_FRAME`.
  - `a stopped run gets no audit`: stop during round 1, and there are no audit calls.
  - `Stop during the final audit cuts it short`: the audit fake waits on `o.signal`. After `run.stop()`, `run.finished` resolves, the state is `idle`, and the chat ends with `(stopped partway through my turn)`.
  - `auditAtEnd false skips the final audit`.
  - `a card that holds the Foreman role audits read-only in a fresh conversation`:
    - `complete` records `tools`, and their names are exactly `AUDIT_TOOLS`;
    - `run.conversations.has(cardId)` is false afterwards;
    - the posted report is the card's text.
  - `/audit waits for a pending prune`: call `prune({})` then `audit({})`. The order is `prune` then `audit`.
  - `audit is refused during a run, while one is going, and with no auditor`, using the three exact error strings.
  - `the Foreman card over budget falls back to Claude`.
  - In `board.test.mjs`, `auditAtEnd defaults to true, survives migration and is validated`.
- [ ] **Step 2: Run `npm test`.** The new tests fail.
- [ ] **Step 3: Implement the behaviour above.**
- [ ] **Step 4: Run `npm test`.** All pass.
- [ ] **Step 5: Commit** `feat: the Foreman audits the board at the end of a run`.

### Task 4: `/audit` in the chat

**Files:**
- Modify: `lib/commands.mjs`, `lib/room.mjs`, `README.md`.
- Test: `test/commands.test.mjs`, `test/room.test.mjs`, `test/server.test.mjs`.

**Interfaces:**
- Consumes: `colab.audit` and `status.auditing` (Task 3).
- Produces: `parseCommand('/audit x') → { kind: 'audit', text: 'x' }`.
- Produces: `COMMANDS_HINT` becomes `'/chat N (or /c N) · /start · /stop · /prune · /audit'`, and the unknown-command help lists `/audit`. The page's own hint in `Chat.svelte` gets `/audit` too.

- [ ] **Step 1: Write failing tests**
  - Parsing, with and without text.
  - Room: `/audit` calls `colab.audit({ focus })`.
    - On `{ error }` it throws `OpError` and posts nothing.
    - On success it posts `Audit the board.` or `Audit the board: <text>` as `user` with `owed: []`.
  - `/stop` is accepted while `status.auditing`.
- [ ] **Step 2: Run `npm test`.** The new tests fail.
- [ ] **Step 3: Implement**, mirroring the `prune` branch in `Room.userChat`.
- [ ] **Step 4: README.**
  - Add an `/audit` row to the commands table.
  - Write a short "Final audit" paragraph: who audits, read-only, the Settings switch, and the editable texts under Edit roles… → Passes.
- [ ] **Step 5: Run `npm test`.** All pass.
- [ ] **Step 6: Commit** `feat: /audit command`.

### Task 5: The page: Passes in the Roles dialog, the Settings switch, Stop while auditing

**Files:**
- Create: `web/src/colab/PassPane.svelte`
- Modify:
  - `web/src/colab/RoleEditor.svelte`;
  - `web/src/colab/colab.svelte.ts`;
  - `web/src/lib/api.ts`;
  - `web/src/lib/types.ts`: lineup `auditAtEnd`, status `auditing`;
  - `web/src/components/SettingsDialog.svelte`;
  - `web/src/components/Chat.svelte`.
- Test: `web/src/colab/RoleEditor.test.ts` (create if absent), `web/src/components/SettingsDialog.test.ts`, `web/src/components/Chat.test.ts`.

**Interfaces:**
- Consumes: GET `passDefaults` and PUT `passes` (Task 1); lineup `auditAtEnd` (Task 3); status `auditing` (Task 3).
- Produces: `colabState.library: { rules; roles; passes?: { audit?: string; prune?: string } }` and `colabState.passDefaults: { audit: string; prune: string }`.

**Behaviour:**
- **The RoleEditor nav:** after "+ New role", a small muted `Passes` heading, then `Final audit` and `Prune` items. The selection type widens to role id | null | `'pass:audit'` | `'pass:prune'`.
- **PassPane `{ name }`:**
  - one textarea labelled `Instructions, every board`, using a `Draft` whose server value is `passes?.[name] || passDefaults[name]`. Saving sends the whole library with `passes[name]` set.
  - a muted line: `Shared by every board. Focus a single run with /audit <text> or /prune <text>.`, using `/prune` for the prune pane.
  - a `Reset to default` button, disabled when nothing is stored, that saves with `passes[name]` removed.
  - no name field, no delete, no "Extra for this board".
- **SettingsDialog:** a checkbox `Audit at the end of a run`, bound to `lineup.auditAtEnd ?? true`. It is sent with `setColabLineup` the way `setPrune` sends its fields, and is disabled with the same "Agents are running" rule.
- **Chat:** the Stop button condition gains `live.colab?.auditing`.

- [ ] **Step 1: Write failing tests**
  - Selecting `Final audit` shows the default text.
  - Editing saves `passes.audit`, and Reset removes it (mock `api.saveLibrary`).
  - The Settings checkbox sends `auditAtEnd: false`.
  - Chat shows Stop when `auditing` is true.
- [ ] **Step 2: Run `npx vitest run`.** The new tests fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `npx vitest run && npm run lint && npm run check && npm run build`.** All pass.
- [ ] **Step 5: Commit** `feat: edit the audit and prune texts, and switch off the final audit`.
