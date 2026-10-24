# Connections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One chat to every connected agent. Claude (via binary or MCP) is connection 1 and OpenRouter cards are 2…N. Slash commands (`/chat N`, `/c N`, `/start`, `/stop`) replace the Start button, and one persistent budget covers all OpenRouter spend.

**Architecture:** A new server-side `Room` (`lib/room.mjs`) owns the chat flow. It parses a user's message, works out which connections owe an answer, posts the message with that list (`owed`), and hands work out. Claude goes to the existing `Agent`, extended to report how it is connected and to take run turns. OpenRouter answers and `/start` runs go to `ColabRun`, which is reworked to answer plain messages in parallel and to include Claude in the round robin. The page gets a Connections sidebar in place of the Agents panel, and the chat input sends everything through the Room.

**Tech Stack:** Node 18+ ESM with no runtime dependencies (`node --test`), and a Svelte 5 + Vite page (`vitest`, `@testing-library/svelte`).

**Spec:** `docs/superpowers/specs/2026-10-24-connections-design.md`. Read it with this plan.

## Global Constraints

- Server runs on Node 18+ and has no runtime dependencies.
- The OpenRouter key never reaches the page or the board file.
- An invalid slash command is never sent to agents. The page keeps the text in the input box.
- The binary and an MCP session never both answer the same message.
- One budget covers plain answers, `/chat` answers and `/start` runs. Spent is saved in the board and goes back to $0.00 only through **Reset**.
- Claude (binary or MCP) is never counted against the budget.
- `--no-agent` is removed.
- Connection numbering: Claude is always 1. OpenRouter cards follow from 2, in sidebar order at the moment of sending.
- Board files from before this change load. `handled: true` becomes `owed: []`, `handled: false` becomes `owed: ['claude']`, and Claude's role defaults to `foreman` if that role is in the library, otherwise to the first role.
- Run all tests with `npm test`, and also run `npm run check` and `npm run lint`. All three must pass at the end of every task.

## Review Focus

1. **The binary and MCP race.** An MCP session attaches and replies while a binary `claude -p` is already answering the same message. Only one answer should land. The binary drops its result if none of its messages is still owed by `claude`. *(Test in Task 3.)*
2. **Two plain messages close together.** When the second arrives while agents are still answering the first, each connection answers each message exactly once, and the second is answered in a single follow-up call. *(Test in Task 5.)*
3. **Budget crossed during parallel answers.** Once spent reaches the budget, no new OpenRouter call starts. An answer cut off this way posts "(stopped: budget reached)", and the chat gets exactly one "budget reached" note. *(Test in Task 5.)*
4. **Restart while answers are in flight.** After a server restart, OpenRouter connections no longer owe anything, so there is no burst of paid calls. Claude's owed messages are kept, as unanswered messages are today. *(Test in Task 6.)*
5. **Text that starts with `/` but isn't a command,** such as `/home/frosty/x is the path`. It is refused with the hint "Unknown command /home… Start with // to send a message that begins with /". `//rest` sends `/rest` as a plain message. *(This is my call; tests in Tasks 2 and 6.)*

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `lib/board.mjs` | modify | Chat message fields `owed`, `to` and `start`; `lineup.claudeRoleId`; `colab.spent`, `colab.claudeName`; new ops; migration |
| `lib/authors.mjs` | modify | `cardIds()`, which gives stable ids to duplicate cards; Claude's display name |
| `lib/store.mjs` | modify | An undo turn per AI author; `addColabSpend`, `setColabSpent` |
| `lib/commands.mjs` | **create** | `parseCommand(text)`, a pure parser |
| `lib/agent.mjs` | modify | `findOnPath`, `via()`, the role in the prompt, answering `owed`, `takeTurn()`, dropping stale results |
| `lib/mcp.mjs`, `lib/mcp-tools.mjs` | modify | Deliver only messages owed by Claude; run-turn offers through `wait_for_chat`/`reply`; `your_role` |
| `lib/colab/prompts.mjs` | modify | Answer-mode prompts; addressed messages in updates |
| `lib/colab/run.mjs` | modify | Parallel answers, activity per connection, persistent conversations and spend, a run that includes Claude |
| `lib/room.mjs` | **create** | Validation, `owed`, dispatch, status, restart cleanup |
| `server.mjs` | modify | Route chat through the Room; remove `--no-agent`; startup warning; reset-spent route; remove the start route |
| `web/src/lib/{types,api,live.svelte,authors}.ts` | modify | New status shape, `live.chat()`, Claude's name |
| `web/src/colab/ConnectionsPanel.svelte` (+ `.test.ts`) | **rename** from `AgentsPanel` | The new sidebar |
| `web/src/components/Chat.svelte` (+ test) | modify | Header and Stop, command hint, inline errors, target tags, a working line per connection |
| `README.md` | modify | Docs |

---

### Task 1: Board data model, migration and per-author undo turns

**Files:**
- Modify: `lib/board.mjs`, `lib/authors.mjs`, `lib/store.mjs`
- Test: `test/board.test.mjs`, `test/store.test.mjs`, `test/authors.test.mjs`

**Interfaces:**
- Produces:
  - **User chat op:** `{ type: 'chat', text, context?, to?: string[], owed?: string[], start?: true }`. Every id in `to` and `owed` must be `'claude'` or a roster id, otherwise `OpError`. The stored user message has `owed: string[]` (default `[]`), plus `to` and `start` only when given.
  - **AI chat op `answers`:** removes the author from `owed` on the listed messages. Without `answers`, it removes the author from `owed` on every earlier user message. `handled` is no longer written.
  - **`setColabLineup`:** also takes `claudeRoleId` (a string of 200 characters at most, required). The lineup is `{ agents, rounds, budget, turnLimit, claudeRoleId }`.
  - **New op `setClaudeName`** `{ name }` (system op): sets `board.colab.claudeName`.
  - **New op `resetColabSpent`** `{}` (system op): sets `board.colab.spent = 0`.
  - **`emptyColab()`:** adds `spent: 0`, `claudeName: 'Claude'` and `lineup.claudeRoleId: 'foreman'`.
  - **`migrateBoard`:** fills in all of the above. For each user message, `owed` comes from `handled` (`true` → `[]`, `false` → `['claude']`), and `handled` is then deleted.
  - **`authors.mjs`:** `cardIds(agents: {model, roleId}[]): string[]`. The first card with a given model and role gets `agentId(model, roleId)`; the n-th duplicate gets `` `${agentId(model, roleId)}#${n}` ``. `authorName(board, 'claude')` returns `board.colab?.claudeName ?? 'Claude'`.
  - **`store.mjs`:** `turnOf(author): string | undefined` gives each AI author its own current turn id, renewed after that author's chat message. It replaces every `this.claudeTurn` use. `addColabSpend(cost: number)` adds to `board.colab.spent` and saves (no history entry, no event). `setColabSpent(n)` is the same but sets the value.

- [ ] **Step 1: Write the failing tests**
  - `board.test.mjs` "user chat stores owed/to/start": apply `{type:'chat', text:'hi', owed:['claude'], to:['claude'], start:true}` as `user`, then assert the message has `owed: ['claude']`, `to: ['claude']`, `start: true`, and that `'handled' in message === false`.
  - "unknown ids in owed are refused": `owed: ['agent:nobody']` throws `/unknown connection/`.
  - "an AI answer clears only its own owed": a user message with `owed: ['claude', 'agent:a=b']` (roster seeded with `agent:a=b`). Apply `{type:'chat', text:'x', answers:[id]}` as `claude`, then assert `owed` deep-equals `['agent:a=b']`.
  - "migration turns handled into owed": `migrateBoard` of a board whose chat has `{role:'user', handled:false}` and `{role:'user', handled:true}` gives `owed` of `['claude']` and `[]`, with no `handled` key. It also gives `colab.spent === 0` and `lineup.claudeRoleId === 'foreman'`.
  - "resetColabSpent and setClaudeName": they change the fields and add no history entry.
  - `authors.test.mjs` "cardIds suffixes duplicates": `[{model:'m',roleId:'r'},{model:'m',roleId:'r'},{model:'n',roleId:'r'}]` gives `['agent:m=r','agent:m=r#2','agent:n=r']`.
  - `store.test.mjs` "each AI author gets its own undo turn": interleave note adds by `claude` and by roster agent `agent:a=b`, then assert the two history groups have different `turn` values. `undoTurn` on Claude's turn removes only Claude's note.

- [ ] **Step 2:** Run `node --test test/board.test.mjs test/store.test.mjs test/authors.test.mjs`. Expected: the new tests FAIL.
- [ ] **Step 3:** Implement the changes above. Then update the existing callers of `handled`: `lib/agent.mjs:49,66` (temporarily switch to `m.owed?.includes('claude')`) and `unansweredChat` in `lib/mcp-tools.mjs:34` (same filter). Fix any existing tests that assert on `handled`.
- [ ] **Step 4:** Run `npm run test:server`. Expected: all PASS.
- [ ] **Step 5:** Commit: `feat: chat messages record who owes an answer; budget spend and Claude's role live on the board`.

---

### Task 2: Slash command parser

**Files:**
- Create: `lib/commands.mjs`
- Test: `test/commands.test.mjs`

**Interfaces:**
- Produces: `parseCommand(text: string): { kind: 'say', text } | { kind: 'chat', n: number, text } | { kind: 'start', text } | { kind: 'stop' } | { kind: 'error', error: string }`
  - Leading whitespace is ignored. Command words are case-insensitive. `/c` is an alias for `/chat`.
  - `//rest` returns `{ kind: 'say', text: '/rest' }`.
  - Exact error copy:
    - unknown word: `Unknown command /<word>. Commands: /chat N (or /c N), /start, /stop. Start with // to send a message that begins with /.`
    - `/chat` with no number or a bad one: `Use /chat N <message>, where N is a connection's number.`
    - `/chat N` with nothing after the number: `Add a message after /chat N.`
    - `/start` with no text: `Add a kickoff message after /start.`
    - `/stop` followed by text: `/stop takes no message.`
  - Exported constant `COMMANDS_HINT = '/chat N (or /c N) · /start · /stop'`.

- [ ] **Step 1: Write the failing tests** (`test/commands.test.mjs`), as a table of input → expected:
  - `'Do you like it?'` → `{kind:'say', text:'Do you like it?'}`
  - `'/chat 2 hi there'` → `{kind:'chat', n:2, text:'hi there'}`
  - `'  /C 3 yo'` → `{kind:'chat', n:3, text:'yo'}`
  - `'/start ok guys'` → `{kind:'start', text:'ok guys'}`
  - `'/stop'` → `{kind:'stop'}`
  - `'//home'` → `{kind:'say', text:'/home'}`
  - errors: `'/home/x'`, `'/chat2 hi'`, `'/chat x hi'`, `'/chat 2'`, `'/start'` and `'/stop now'`. Assert each gives `kind:'error'` with the copy above (for `/home/x`, the word is `home/x`).
  - A multi-line message keeps its newlines: `'/chat 2 a\nb'` → `text:'a\nb'`.
- [ ] **Step 2:** `node --test test/commands.test.mjs`. Expected: FAIL (module missing).
- [ ] **Step 3:** Implement `parseCommand`.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5:** Commit: `feat: parse chat slash commands`.

---

### Task 3: Claude connection, binary side

**Files:**
- Modify: `lib/agent.mjs`
- Test: `test/agent.test.mjs`

**Interfaces:**
- Consumes: `owed` from Task 1.
- Produces:
  - `findOnPath(bin: string, env = process.env): boolean`. True if `bin` contains a path separator and is an executable file, or if `<dir>/<bin>` is executable in some `PATH` directory (on Windows also try the `PATHEXT` endings). Uses `fs.accessSync(path, fs.constants.X_OK)` and never throws.
  - The `Agent` constructor gets new options: `found = findOnPath(claudeBin)` and `role = () => ''`. `role` returns the extra system text (the role's job plus the shared rules) that is appended after `SYSTEM_PROMPT` under a `Your role on this board:` heading when non-empty.
  - `agent.via(): 'mcp' | 'binary' | 'none'`. Returns `presence.attached()` → `'mcp'`, otherwise `found` → `'binary'`, otherwise `'none'`.
  - `nudge()`: does nothing when `!found`. Pending messages are the user messages whose `owed` includes `'claude'`.
  - `#run()`: once `claude -p` finishes, if no message in `pending` is still owed by `claude` (an MCP session answered it meanwhile), it **drops the result** and logs `idea-board agent: dropped a reply already answered by a session`.
  - `takeTurn(prompt: string, { timeoutMs, signal }): Promise<{ ok: true, text } | { ok: false, error }>` runs one `claude -p` in the board's session (the same `#invoke` with the prompt). It does not post anything. While it runs, `running` is true and an `agent` `working`/`idle` event is emitted. `signal` aborting kills the child process with SIGTERM.

- [ ] **Step 1: Write the failing tests**
  - "findOnPath finds an executable in PATH and not a missing one": make a temp dir with an executable `claude`, then check `findOnPath('claude', {PATH: dir})` is `true`, `findOnPath('nope', {PATH: dir})` is `false`, and `findOnPath(path.join(dir,'claude'), {})` is `true`.
  - "nudge does nothing when the binary is missing": an Agent with `found:false` and a user message owing `claude`; after 200 ms, no `agent` event has been emitted.
  - "a reply already answered by a session is dropped": use `FAKE_CLAUDE` (it waits 150 ms). While it runs, apply `{type:'chat', text:'session answer'}` as `claude` with no `answers`. After the run goes idle, the chat has exactly one `claude` message, `'session answer'`.
  - "the role text is appended to the system prompt": a fake binary that echoes the `--append-system-prompt` argument as its result; with `role: () => 'Be the Foreman.'`, the posted text contains `Your role on this board:` and `Be the Foreman.`.
  - "takeTurn returns the text and posts nothing": the fake binary returns `answered: <prompt>`; `await agent.takeTurn('your turn', {timeoutMs: 5000})` deep-equals `{ok:true, text:'answered: your turn'}`, and the chat length is unchanged.
- [ ] **Step 2:** `node --test test/agent.test.mjs`. Expected: the new tests FAIL.
- [ ] **Step 3:** Implement. Pass `signal` through to `#invoke` so that aborting kills the child; `timeoutMs` replaces `RUN_TIMEOUT_MS` for turns.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5:** Commit: `feat: the binary Claude knows whether it exists, takes a role, takes run turns and never double-answers`.

---

### Task 4: Claude connection, MCP side

**Files:**
- Modify: `lib/mcp.mjs` (Presence), `lib/mcp-tools.mjs` (`reply`, `wait_for_chat`, `unansweredChat`)
- Test: `test/mcp.test.mjs`

**Interfaces:**
- Consumes: `owed` from Task 1.
- Produces:
  - `unansweredChat(board)`: the user messages whose `owed` includes `'claude'` (unchanged output shape).
  - `presence.role: () => string`, set by the Room. Its text is returned as `your_role` in every `wait_for_chat` result when non-empty.
  - `presence.offerTurn(prompt: string, { timeoutMs, signal }): Promise<boolean>`. Queues a turn. The next or current `wait_for_chat` returns at once with `{ messages: [], turn: { prompt }, board_changes, next: "It is your turn in the agents' run. Work on the board, then call reply with a short message to the others (3 to 5 sentences). Then call wait_for_chat again." }`. Resolves `true` when the session calls `reply` while the turn is pending, or `false` on timeout or abort; the pending turn is then cleared and a later `reply` is an ordinary reply.
  - `reply` during a pending turn posts with `answers: []`, so a turn post never clears owed messages. In that case its result is `{ posted: true, turn: 'done' }`.
  - The `waitForChat` subscription also wakes on a new user message only when that message's `owed` includes `'claude'`. Steering messages during a run (owed `[]`) don't wake it.

- [ ] **Step 1: Write the failing tests** (in `test/mcp.test.mjs`, using `withServer` and its `call`):
  - "wait_for_chat skips messages not owed by Claude": `userOp` posts two chat ops directly: `{type:'chat', text:'not you', owed:[]}` and `{type:'chat', text:'you', owed:['claude']}`. `call('wait_for_chat', {timeout_seconds:1})` returns `messages` with only `'you'`.
  - "a run turn is offered through wait_for_chat and finished by reply": start `presence.offerTurn('Round 1: your turn', {timeoutMs: 2000})`. `wait_for_chat` returns `turn.prompt === 'Round 1: your turn'`. `call('reply', {text:'did it'})` returns `turn: 'done'`. The offer resolves `true`, and the last chat message is `{role:'claude', text:'did it'}`.
  - "an unanswered turn times out": `offerTurn('x', {timeoutMs: 100})` resolves `false`, and a following `reply` returns no `turn` key.
  - "your_role appears when set": with `presence.role = () => 'Foreman job'`, `wait_for_chat` gives `your_role: 'Foreman job'`.
- [ ] **Step 2:** `node --test test/mcp.test.mjs`. Expected: the new tests FAIL.
- [ ] **Step 3:** Implement. Update the `wait_for_chat` description with one sentence: "During an agents' run it may return a turn instead of messages: do the turn, then reply."
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5:** Commit: `feat: an MCP session gets only messages meant for Claude and takes run turns`.

---

### Task 5: OpenRouter answers in parallel, persistent spend, runs that include Claude

**Files:**
- Modify: `lib/colab/run.mjs`, `lib/colab/prompts.mjs`
- Test: `test/colab-run.test.mjs`

**Interfaces:**
- Consumes: `cardIds`, `addColabSpend`, `turnOf` and `owed`/`to` (Task 1).
- Produces (`ColabRun`):
  - The constructor additionally takes `claude: { via(): string, takeTurn(prompt, opts) }` and `presence` (it already has `presence`). Turns go to `claude.takeTurn` when `via()==='binary'`, and to `presence.offerTurn` when `via()==='mcp'`.
  - `ensureRoster(): void` adds a roster entry for every lineup card (ids from `cardIds`), using today's naming and colour rules. It replaces the roster code in `start()`.
  - `canAnswer(id): { ok: true } | { ok: false, why: 'no-key' | 'over-budget' | 'no-model' | 'no-role' }` for an OpenRouter card id.
  - `overBudget(): boolean` is `board.colab.spent >= lineup.budget`.
  - `answer(id: string): void` answers, in one call, every user message whose `owed` includes `id`. If this id is already answering, it is queued and runs again afterwards (as `Agent.nudge`). Answers for different ids run concurrently. Each has its own `AbortController`, the turn timeout and its own `stats`. It posts with `answers: <the ids it answered>`.
  - `start(kickoffId: string): void` begins the run at once (the `'waiting'` state is gone). The order is `['claude' if claude.via() !== 'none', ...cardIds(lineup.agents)]`. It refuses (`OpError`) when that order is empty or a run is going.
  - `stop()`: unchanged for runs. It does not cut parallel answers.
  - `status: { state: 'idle'|'running'|'stopping', round, rounds, current: string|null, spent, budget, claude: 'binary'|'mcp'|'none', connections: Record<string, { state: 'waiting'|'thinking'|'over-budget', activity: string|null, done: string[] }> }`. Here `spent` and `budget` are the board's total and the lineup's budget. A `colab` event is emitted on every change.
  - **Spend:** every OpenRouter call's cost goes to `store.addColabSpend(cost)`. The run's own tally is kept only for its notes and `setColabRun`.
  - **Budget rules:**
    - `#ask` refuses to start a call when `overBudget()`. The answer or turn then ends and posts `(stopped: budget reached)`.
    - The run loop ends with today's note when over budget before a turn.
    - Over budget during answers posts one note per crossing: `OpenRouter agents stopped: budget of $<budget> reached ($<spent> spent). Raise the budget or press Reset to go on.` The flag `budgetNoted` is cleared by `budgetChanged()`, which the Room calls.
  - **Conversations:** no longer cleared in `start()`. Each card keeps one conversation across answers and turns. A Claude turn's "since last time" marker `{seq, chat}` is kept in the same map under `'claude'`.
  - **Claude's turn prompt:** `turnMessage`/`updateMessage` with `me = { name: board.colab.claudeName }` and the list of others. The result:
    - binary: if `ok`, posted as `claude` with `answers: []`; otherwise posted `(my turn failed: <error>)`.
    - MCP: `offerTurn` returning `false` posts `(out of time after <n> min)` as `claude`.
- Produces (`prompts.mjs`):
  - `ANSWER_RULES`: plain text telling the agent it is answering the host's message in its role, in 2 to 6 sentences; that the other agents answer independently and it won't see their answers first; that it may change the board if that helps and should then say what it changed; and that the final plain-text reply is posted to the chat.
  - `systemPrompt({ me, others, job, rules, mode: 'turn' | 'answer' })` uses `TURN_RULES` or `ANSWER_RULES`.
  - `answerMessage(board, me, { changes, messages })` is like `updateMessage` but ends `Answer the host, <me.name>.`.
  - `said()` shows addressed messages as `Host (to <name>): …`.

- [ ] **Step 1: Write the failing tests** (`test/colab-run.test.mjs`; adapt `setup()` to pass a fake `claude` `{ via: () => 'none', takeTurn }`. Update today's tests that call `start()` and then `onUserMessage()` so they call `start(id)` right after posting the kickoff):
  - "a plain message is answered once by each card, in parallel": two cards, each `complete` takes 50 ms. Post a user message with `owed: [idA, idB]`, then call `answer(idA)` and `answer(idB)`. Both posts exist, each with `owed` cleared, and the total time is under 100 ms (they overlap).
  - "a second message while answering is answered in one follow-up call": card A, `complete` 50 ms. Post m1 owed A, call `answer(A)`, after 10 ms post m2 owed A and call `answer(A)` again. Wait for idle. A posted exactly 2 messages, and the second call's last user content contains m2's text and not m1's.
  - "spend persists on the board across answers and runs": after one answer of cost 0.1, `store.board.colab.spent ≈ 0.1`. After a 1-round run with one card (cost 0.1 per call, 2 calls), it is ≈ 0.3.
  - "no call starts once over budget": budget 0.15 and two cards, each turn needing 2 calls of 0.1. Answer both at once. At most 2 calls happen after spent ≥ 0.15, at least one post is `(stopped: budget reached)`, and there is exactly one chat note starting `OpenRouter agents stopped: budget`.
  - "Claude takes its turn first in a run": `via: () => 'binary'`, `takeTurn` resolves `{ok:true, text:'claude turn'}`, rounds 1, one card. The posts are in the order `claude`, then the card. `takeTurn`'s prompt contains the kickoff text.
  - "an MCP Claude turn that times out says so": `via: () => 'mcp'`, presence `offerTurn` resolves `false`. Claude's post starts `(out of time after`.
  - "a /chat to a card during a run reaches only that card's next turn as addressed": during a run, post `{text:'just you', to:[idB], owed:[]}`. B's next request contains `Host (to <B name>): just you`. A's next request contains it too, with the same `(to …)` prefix.
  - "conversations survive between an answer and a later run": after an answer by A, a run turn by A sends a request whose `messages` start with the answer's messages (the same first user content).
- [ ] **Step 2:** `node --test test/colab-run.test.mjs`. Expected: the new tests FAIL.
- [ ] **Step 3:** Implement. Make `#takeTurn(me, { mode, messageIds })` shared by `answer` and the run loop. Replace the single `#stopTurn`, `activity` and `done` with per-id maps. Remove `onUserMessage` and the `'waiting'` state.
- [ ] **Step 4:** Run `npm run test:server`. Expected: PASS. (Server tests that use `/api/colab/start` are fixed in Task 6; mark them `test.skip` with a `// Task 6` comment if they block, and un-skip them there.)
- [ ] **Step 5:** Commit: `feat: OpenRouter agents answer chat in parallel, spend is kept on the board, and Claude takes run turns`.

---

### Task 6: The Room and server wiring

**Files:**
- Create: `lib/room.mjs`
- Modify: `server.mjs`
- Test: `test/room.test.mjs`, `test/server.test.mjs`, `test/helpers.mjs`

**Interfaces:**
- Consumes: `parseCommand` (Task 2); `agent.via()`, `nudge()`, `found` (Task 3); `presence.role` (Task 4); `ColabRun.{ensureRoster, canAnswer, overBudget, answer, start, stop, status, budgetChanged}` (Task 5).
- Produces: `class Room({ store, agent, presence, colab, library })`
  - `connections(): Array<{ n: number, id: string, kind: 'direct'|'openrouter', available: boolean, why?: string }>`. Claude is n=1 and is available when `agent.via() !== 'none'` (`why: 'not-connected'` otherwise). Cards are n=2… with `available = colab.canAnswer(id).ok` (`why` from it).
  - `userChat({ text, context }): { message } | { stopped: true }` throws `OpError(400)` with copy as follows:
    - parse error → its `error`.
    - `/chat N` with no connection N → `No connection ${N}. Connections are numbered 1 to ${max} in the sidebar.`
    - `/chat N` to an unavailable connection → `${name} can't answer right now (${reason}).`. The reasons are `not connected`, `over budget`, `no OpenRouter key`, `no model` and `role missing`.
    - `/start` during a run → `A run is already going. Use /stop first.`
    - `/start` with no available connection → `No one is connected to start a run.`
    - `/stop` with no run → `No run is going.`
  - Posting rules:
    - Outside a run, `owed` is the available target ids: all of them for `say`, `[id]` for `chat`, `[]` for `start`.
    - During a run, `owed = []` and `to` is kept for `chat`.
    - `start` posts the kickoff with `start: true` and calls `colab.start(message.id)`.
    - `stop` posts nothing and calls `colab.stop()`.
    - After posting, it nudges `agent` if `owed` includes `claude` and Claude is connected via the binary, and calls `colab.answer(id)` for each owed card.
    - A `say` that nobody can answer is still posted, followed by the note (as `claude`, `answers: []`): `No one is connected to answer. Connect Claude (see the sidebar) or add an OpenRouter connection.`
  - `lineupChanged()`: calls `colab.ensureRoster()`; sets `claudeName` to `Claude · <role name>` through the `setClaudeName` op (only when changed); calls `colab.budgetChanged()`.
  - `resetSpent()`: applies `resetColabSpent` as `user` and calls `colab.budgetChanged()`.
  - `recover()`: calls `colab.recoverAfterRestart()`, removes every non-`claude` id from every message's `owed` (one save, no history entry, using a new `store.pruneOwed(keep: string)` method), runs `lineupChanged()`, and fills `claudeRoleId` from the library when the stored id is missing from it (`foreman`, otherwise the first role).
  - It sets `presence.role` and the agent's `role` option to `roleText()`: the job of Claude's role, plus that role's board extra, plus the library's rules and the board's extra rules (`joinLayers`, as in run.mjs).
- Server:
  - `POST /api/op` with `op.type === 'chat'` calls `room.userChat(op)` and returns its result. `setColabLineup` is still refused during a run, and calls `room.lineupChanged()` after it is applied.
  - `POST /api/colab/start` is removed. `POST /api/colab/stop` stays. New `POST /api/colab/reset-spent` → `{ status }`.
  - `GET /api/board` returns `{ board, presence, agent: 'idle'|'working', claude: agent.via() }`.
  - `GET /api/colab` adds `connections: room.connections()`.
  - `--no-agent` is removed from `parseArgs` and the usage text. The `Agent` is always created.
  - Startup: if `!agent.found`, print `Claude: the "claude" command was not found. To connect Claude from your own session run:\n  claude mcp add --transport http idea-board <mcpUrl>\nthen ask Claude to "listen to the board chat".`
  - Every `presence` and `agent` event also re-emits the `colab` status, so the sidebar's `claude` field follows MCP attach and detach.
- `test/helpers.mjs`: `withServer` builds a real `Room`. The fake agent gains `via: () => 'binary'` and `found: true` (overridable through an `agent` option).

- [ ] **Step 1: Write the failing tests**
  - `room.test.mjs` (a store, a fake agent with `via`/`nudge`, a fake colab recording calls, and a Library in a temp dir; two cards seeded):
    - "a plain message is owed by every available connection": `userChat({text:'hi'})` gives a message with `owed` deep-equal to `['claude', idA, idB]`. The agent was nudged once, and `answer` was called with A and with B.
    - "/chat 2 goes to the first card only": `owed: [idA]`, `to: [idA]`, and the agent is not nudged.
    - "/chat 1 when Claude is not connected is refused": `via: () => 'none'`. It throws `/Claude.*can't answer right now \(not connected\)/`, and the chat is unchanged.
    - "/chat 9 is refused": throws `/No connection 9/`.
    - "unknown command is refused and nothing is posted": `'/home/x'` throws `/Unknown command/`, and the chat length is unchanged.
    - "//home sends a plain message": the stored text is `'/home'`.
    - "during a run, messages are owed by no one": colab status `running`. A `say` has `owed: []`. `/chat 2 x` has `owed: []` and `to: [idA]`. `answer` is not called and the agent is not nudged.
    - "/start posts the kickoff and starts": the message has `start: true` and `owed: []`, and `colab.start` was called with its id.
    - "nobody connected still posts with a note": `via: 'none'` and no cards. `say` posts the message and then the note text.
    - "recover drops OpenRouter debts and keeps Claude's": a message with `owed: ['claude', idA]` becomes `['claude']` after `recover()`.
    - "lineupChanged names Claude by role": `claudeRoleId: 'foreman'` gives `board.colab.claudeName === 'Claude · Foreman'`.
  - `server.test.mjs`:
    - "a bad slash command returns 400 and posts nothing": `userOp({type:'chat', text:'/nope'})` returns 400 with the `Unknown command` copy.
    - "POST /api/colab/reset-spent zeroes spent": set `board.colab.spent = 2` through `store.setColabSpent(2)`, POST, then `status.spent === 0`.
    - "the start route is gone": `POST /api/colab/start` returns 404.
    - "--no-agent is no longer an option": `parseArgs(['--no-agent'])` has no `agent` key. (Export `parseArgs` if it isn't exported.)
- [ ] **Step 2:** `node --test test/room.test.mjs test/server.test.mjs`. Expected: the new tests FAIL.
- [ ] **Step 3:** Implement the Room and the server changes. Un-skip anything skipped in Task 5.
- [ ] **Step 4:** `npm run test:server`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat: a chat room routes each message to the right connections; --no-agent is gone`.

---

### Task 7: Page state and the Connections sidebar

**Files:**
- Modify: `web/src/lib/types.ts`, `web/src/lib/api.ts`, `web/src/lib/live.svelte.ts`, `web/src/lib/authors.ts`, `web/src/colab/colab.svelte.ts`, `web/src/views/CollaborateView.svelte`, `web/src/colab/AddAgentDialog.svelte` (title copy only)
- Rename and rewrite: `web/src/colab/AgentsPanel.svelte` → `ConnectionsPanel.svelte`, and `AgentsPanel.test.ts` → `ConnectionsPanel.test.ts` (use `git mv`)
- Test: `web/src/colab/ConnectionsPanel.test.ts`, `web/src/lib/authors.test.ts`

**Interfaces:**
- Consumes: the server shapes from Tasks 1, 5 and 6.
- Produces:
  - `types.ts`:
    - `ChatMessage` loses `handled` and gains `owed?: string[]`, `to?: string[]` and `start?: boolean`.
    - `Colab` gains `spent: number` and `claudeName: string`, and `lineup` gains `claudeRoleId: string`.
    - `RunStatus` becomes the Task 5 status shape (`ConnectionStatus = { state: 'waiting'|'thinking'|'over-budget'; activity: string|null; done: string[] }`).
    - New `ConnectionInfo = { n: number; id: string; kind: 'direct'|'openrouter'; available: boolean; why?: string }`.
    - `BoardInfo` gains `claude: 'binary'|'mcp'|'none'`, and `AgentState` drops `'off'`.
  - `api.ts`: `startColab` is removed. Adds `resetSpent(): Promise<RunStatus>` (`POST /api/colab/reset-spent`) and `chat(op): Promise<unknown>` (the same as `op`). `ColabInfo` gains `connections`.
  - `live.svelte.ts`: `async chat(text: string, context?: Pointer[]): Promise<{ ok: true } | { error: string }>` posts the chat op without a toast and returns the server's error message.
  - `authors.ts`: `authorName(board, 'claude')` returns `board?.colab?.claudeName ?? 'Claude'`. New `cardIds(agents)` mirrors the server version.
  - `ConnectionsPanel.svelte`, laid out as the approved mockup (`.superpowers/brainstorm/91156-1792867660/content/sidebar.html`, state A/B/C):
    - **"Direct connection" section:** `1. Claude (via binary|via MCP|not connected)`, a Role `<select>` (it writes `claudeRoleId` through `setColabLineup`; disabled during a run), and `Activity:`. The activity is `Thinking…` when `live.agent === 'working'` or `status.current === 'claude'`, otherwise `Waiting`. When `status.claude === 'none'`, show the warning box: `The claude command wasn't found. To connect Claude from your own session, run this in your project, then ask Claude to "listen to the board chat":` followed by a `<pre class="select-all">` with `claude mcp add --transport http idea-board ${location.origin}/mcp`.
    - **"OpenRouter connections" section:** today's cards (grip, number `i + 2`, ModelPicker, ✕, Role select), plus `Activity:` from `status.connections[cardIds(agents)[i]]`: `Waiting`, `<activity>…`, or `Over budget`. The current card is highlighted as today. Show "None yet." when there are no cards. Keep the key-missing box here. The button label is `+ Add connection`.
    - **Footer:** Rounds, Budget ($), Turn timeout (min) (the old "Turn limit"), `Spent $<spent> of $<budget>` with a `Reset` button (it runs `confirm('Reset spent to $0.00?')`, then `api.resetSpent()`), and `Edit roles…`.
    - No Start or Stop button in the panel.

- [ ] **Step 1: Write the failing tests** (`ConnectionsPanel.test.ts`; port the surviving AgentsPanel tests and delete the Start/Stop ones):
  - "shows Claude as connection 1 via binary with Waiting": `live.colab` has `claude: 'binary'`. The text `1. Claude` and `(via binary)` are visible, along with `Waiting`.
  - "shows the MCP warning when Claude is not connected": `claude: 'none'` gives the text `claude command wasn't found`, and the `<pre>` contains `claude mcp add --transport http idea-board`.
  - "OpenRouter cards are numbered from 2": with two lineup agents, `2 ·` and `3 ·` are present.
  - "changing Claude's role saves claudeRoleId": changing the Direct-section role select calls `api.op` with `expect.objectContaining({ type: 'setColabLineup', claudeRoleId: 'qa' })`.
  - "a card shows its activity": `connections[cardId] = {state:'thinking', activity:'adding note', done:[]}` gives `adding note…` in that card.
  - "spent and Reset": `spent: 0.42, budget: 5` gives `Spent $0.42 of $5`. Clicking Reset with `confirm` stubbed to true calls `api.resetSpent`.
  - "no Start button": `queryByRole('button', {name: 'Start'})` is null.
  - `authors.test.ts`: "Claude's name comes from the board": with `colab.claudeName = 'Claude · Foreman'`, `authorName(board, 'claude')` is that name.
- [ ] **Step 2:** `npx vitest run web/src/colab web/src/lib/authors.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. Update `web/src/test-board.ts` (`emptyBoard`) with the new fields.
- [ ] **Step 4:** `npm run test:web && npm run check`. Expected: PASS. (Chat tests may still fail on removed `RunStatus` fields; fix only their type fixtures here and leave behaviour to Task 8.)
- [ ] **Step 5:** Commit: `feat: Connections sidebar with Claude as connection 1, live activity, and spend with Reset`.

---

### Task 8: Chat input, header and messages

**Files:**
- Modify: `web/src/components/Chat.svelte`
- Test: `web/src/components/Chat.test.ts`

**Interfaces:**
- Consumes: `live.chat` and the status shape (Task 7); `COMMANDS_HINT` copy (Task 2, duplicated as a page constant `'/chat N (or /c N) · /start · /stop'`).
- Produces:
  - `submit()` uses `live.chat`. On `{error}` it puts the text back in the draft and shows the error in a `role="alert"` line under the textarea, cleared on the next input.
  - While the draft starts with `/` (after trimming leading spaces), a hint line shows `Commands: /chat N (or /c N) · /start · /stop`.
  - The placeholder is `Message everyone, or /chat N to ask one… (Enter to send, Shift+Enter for a new line)`.
  - **Header:**
    - During a run: `Round 2 of 5 · <name>'s turn`. The name is `modelName` from the roster, or `claudeName` for Claude. The old `Turn x of y ·` prefix goes, and so does the spend.
    - During a run, a `Stop` button (it becomes `Stopping…` and is disabled while stopping) that calls `api.stopColab()`.
    - Outside a run, the header shows `A Claude session is listening` when `status.claude === 'mcp'`, and an empty string otherwise.
  - **Message tags:**
    - A user message with `to` shows a small `→ <n>. <name>` tag after the author. The number is the current connection number when the target is still connected; for a removed card it shows `→ <name>`.
    - A message with `start` shows `▶ run started`.
  - **Working lines:** one line per connection that is thinking (each card in `status.connections` with `state==='thinking'`), plus Claude when `live.agent === 'working'` or `status.current === 'claude'`.
  - The empty-state copy becomes `Talk to everyone connected. They can read and change the board.`

- [ ] **Step 1: Write the failing tests** (`Chat.test.ts`, with `live.chat` mocked through `api.op`):
  - "a refused command keeps the draft and shows the error": `api.op` rejects with `Error('Unknown command /nope. …')`. After pressing Enter on `/nope`, the textarea value is `/nope` and `getByRole('alert')` has the text `Unknown command /nope`.
  - "typing / shows the command hint": with the draft `/`, the text `Commands: /chat N (or /c N) · /start · /stop` is visible.
  - "a targeted message shows its target": a chat message `{role:'user', text:'hi', to:[idA]}` with A as the first card gives the text `→ 2. <A name>`.
  - "run header with Stop": `state:'running', round:2, rounds:5, current:idA` gives `Round 2 of 5 · <A modelName>'s turn`. Clicking `Stop` calls `api.stopColab`.
  - "two thinking agents show two working lines": two connections thinking give `getAllByRole('status', {name:'Working'})` with length 2.
- [ ] **Step 2:** `npx vitest run web/src/components/Chat.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npm test && npm run check && npm run lint`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat: chat sends to everyone, takes slash commands and shows whose turn it is with Stop`.

---

### Task 9: README and a manual check

**Files:**
- Modify: `README.md`

- [ ] **Step 1:** Rewrite the README:
  - "Collaborate → Agents" becomes "Collaborate → Connections". Cover the sidebar sections, numbering, the slash-command table (from the spec), the one budget with Spent and Reset, turn timeout, and Claude taking part in runs.
  - "Claude in the chat": remove `--no-agent` and describe the not-connected warning.
  - "Options": remove `--no-agent`.
  - "Development": change `node server.mjs --no-agent --no-open` to `IDEA_BOARD_CLAUDE=/nonexistent node server.mjs --no-open` (no background Claude).
  - Keep the key-setup command block as it is.
- [ ] **Step 2: Manual check.** Run `npm run build`, then `node server.mjs /tmp/conn-check.json --port 4790`. In the browser:
  - Claude shows `via binary`, and a plain message gets Claude's answer.
  - `/nope` stays in the box with the error.
  - `IDEA_BOARD_CLAUDE=/nonexistent` shows the warning in the sidebar and in the console.
  - With an OpenRouter key and one card, a plain message gets two answers, Spent goes up, and Reset zeroes it.
  - `/start` takes turns Claude → card, and `/stop` ends the run.
- [ ] **Step 3:** Commit: `docs: connections, slash commands and the single budget`.
