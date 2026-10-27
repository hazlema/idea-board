# Foreman Requests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Outside a run, whoever holds the Foreman role can ask other agents for work as a chain of steps. The host approves the whole chain once in a modal, and the steps then go out in order, each after the answer before it.

**Architecture:**
- A new `ForemanRequests` class (`lib/requests.mjs`) holds the one request. It is kept on the board (`board.colab.request`), so a reload shows it and a restart can tell it was cut short. It checks requests, plays chains out and cancels them.
- Each step is posted as a host message to its agent, marked with `request: { by, step, of }`. The existing owed/answer machinery then does the delivery: `Room.dispatch` nudges the binary or calls `colab.answer`, and an MCP session picks it up in `wait_for_chat`.
- The foreman asks with a new `ask_agents` tool. The page shows a `RequestDialog` while `board.colab.request.state === 'waiting'` and answers through `POST /api/colab/request`.

**Tech Stack:**
- Server: Node 18+ ESM, no runtime dependencies. Avoid `toReversed()`.
- Page: Svelte 5 + Vite + Tailwind.
- Tests: `npm run test:server` (node --test) and `npm run test:web` (vitest).
- Also run `npm run lint` and `npm run check`.

**Spec:** `docs/superpowers/specs/2026-10-27-foreman-requests-design.md`

## Global Constraints

- Only whoever holds the Foreman role may ask. That is Claude when `lineup.claudeRoleId === 'foreman'`, or a card whose roster `roleId === 'foreman'`. Every holder may ask.
- Refused during a run (`colab.status.state !== 'idle'`). The answer says to use the chat instead.
- Refused during an audit and during a prune pass.
- One request at a time, waiting or playing.
- Nothing reaches an agent before Yes.
- A chain is checked before the modal opens. Every step's agent must be:
  - exactly one connection;
  - not the asker;
  - able to answer right now.
- No has no reason field. It posts "The host declined the request." from the host and sends nothing.
- `/start` is refused while a request is waiting or playing.
- Stop cancels the rest of the chain.
- A server restart drops a waiting or playing request, with a chat note.
- The OpenRouter key must never reach the page or the board file. Don't call real models in tests.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **An agent's step fails without clearing its debt.** If Claude through the `claude` binary fails, the message stays owed and only an `agent` `error` event is sent. The chain must stop on that event and not wait forever. (Task 2 test: "a step that fails stops the chain".)
2. **Two tabs answer the same request.** The second answer gets a 409 and changes nothing. (Task 3 server test.)
3. **The host chats to the step's agent while a step is under way.** The step finishes when *its* message is no longer owed, not when any later message is answered. (Task 2 test: "a step waits for its own message".)
4. **An agent named by part of a name that fits two cards** (two QA cards, say) is refused before the modal opens, with both names in the error. (Task 2 test.)
5. **The lineup changes while a request waits,** so a named card is gone or can't answer by the time the host says Yes. The step is checked again when it comes up and the chain stops with a note. (Task 2 test: "a step that can't run".)

---

### Task 1: The board carries a request and request-marked messages

**Files:**
- Modify: `lib/board.mjs`:
  - `emptyColab()` (line 37) gets `request: null`;
  - the `case 'chat'` user branch (around line 345) accepts `op.request`.
- Modify: `lib/store.mjs`: add `setColabRequest(request)` next to `setColabRun` (line 285).
- Test: `test/board.test.mjs`, `test/store.test.mjs`

**Interfaces:**
- Produces:
  - `board.colab.request`: `null | { id: string, by: string, at: string, state: 'waiting' | 'playing', step: number, steps: { to: string, name: string, text: string }[] }`. `step` is the 0-based step under way while playing (0 while waiting).
  - A chat op from `'user'` may carry `request: { by: string, step: number, of: number }`:
    - `by` must be `'claude'` or a roster id;
    - `step` is 1-based;
    - `step` and `of` are whole numbers with 1 ≤ step ≤ of ≤ 10.
    - It is stored on the message as `message.request`.
    - Ignored for AI authors.
  - `store.setColabRequest(request | null)`: saves, adds no history, and emits `{ type: 'board', board, op: 'setColabRequest', author: 'user', changed: [] }` (as `pruneOwed` does at store.mjs:319).

- [ ] **Step 1: Write the failing tests**

```js
// test/board.test.mjs
test('a host message can say it is a step of a foreman request', () => {
  const board = emptyBoard();
  const { message } = applyOp(board, { type: 'chat', text: 'rework saves', to: ['claude'], owed: ['claude'], request: { by: 'claude', step: 1, of: 2 } }, 'user');
  assert.deepEqual(message.request, { by: 'claude', step: 1, of: 2 });
  assert.throws(() => applyOp(board, { type: 'chat', text: 'x', request: { by: 'nobody', step: 1, of: 1 } }, 'user'), /unknown connection nobody/);
  assert.throws(() => applyOp(board, { type: 'chat', text: 'x', request: { by: 'claude', step: 3, of: 2 } }, 'user'), /request/);
  assert.equal(emptyBoard().colab.request, null);
});

// test/store.test.mjs
test('setColabRequest saves the request and tells the page, with no history', () => {
  // withStore-style temp store; subscribe and collect events
  store.setColabRequest({ id: 'r_1', by: 'claude', at: 'now', state: 'waiting', step: 0, steps: [] });
  assert.equal(store.board.colab.request.id, 'r_1');
  assert.equal(events.at(-1).op, 'setColabRequest');
  assert.equal(store.history({ limit: 5 }).entries.length, 0);
  // and it survives a reload of the file
});
```

- [ ] **Step 2: Run them and check they fail.** Run `npm run test:server`. Expected: the two new tests FAIL.
- [ ] **Step 3: Implement it.** Validate `request` with `connectionIds(board, [op.request.by], 'request.by')` and `Number.isInteger` checks; error `request must be { by, step, of } with 1 ≤ step ≤ of ≤ 10`. `migrateBoard` already fills `request` from `emptyColab()`.
- [ ] **Step 4: Run them and check they pass.** Run `npm run test:server`. Expected: all PASS.
- [ ] **Step 5: Commit.** `feat: the board can hold a foreman request`

---

### Task 2: `ForemanRequests`: ask, decline, play a chain, cancel, recover

**Files:**
- Create: `lib/requests.mjs`
- Modify: `lib/room.mjs`:
  - export `REASONS`;
  - pull lines 107–108 out into `dispatch(message)`.
- Modify: `lib/colab/run.mjs`: add `cutAnswer(id)`.
- Test: `test/requests.test.mjs` (new)

**Interfaces:**
- Consumes: `store.setColabRequest` and the chat op's `request` field (Task 1).
- Produces:
  - `export class ForemanRequests`, built as `new ForemanRequests({ store, room, colab })`. `room` gives `connections()` and `dispatch(message)`; `colab` gives `status` and `cutAnswer(id)`.
  - `ask(author: string, steps: { agent: string, request: string }[]): { waiting: true, id: string }`. Throws `OpError`.
  - `answer(id: string, yes: boolean): { ok: true }`. Throws `ConflictError` (409) when `id` isn't the waiting request.
  - `cancel(): boolean`: true if there was something to cancel.
  - `get busy(): boolean`: a request is waiting or playing.
  - `settled(): Promise<void>`: resolves when no chain is playing (for tests and Room).
  - `recoverAfterRestart(): void`
  - `export function holdsForeman(board, author): boolean`
- `Room.dispatch(message)`: `if (message.owed.includes('claude') && this.agent.via() === 'binary') this.agent.nudge(); for (const id of message.owed) if (id !== 'claude') this.colab.answer(id);`
- `ColabRun.cutAnswer(id)`: aborts `#busy.get(id)` with `new TurnCut('stop')` when its `mode === 'answer'`.

Exact texts:
- Not the foreman: `Only the Foreman can ask other agents for work.`
- In a run: `A run is going: say it in the chat instead, and the next agent will pick it up.`
- During an audit: `An audit is going; ask when it has finished.`
- One at a time: `A request is already waiting for the host or under way.`
- Bad steps:
  - `steps must list 1 to 10 requests`;
  - `No agent called "<q>".`;
  - `"<q>" could mean <A> or <B>; use the id.`;
  - `<Name> can't answer right now (<reason>).` (reason from `REASONS`);
  - `You can't ask yourself.`
- Request text: `text(request, 'request', { required: true, max: 4000 })`.
- Posted by the asker when it asks (`answers: []`): `Asking the host to approve:\n1. <Name>: <text>\n2. …`
- On No, posted by `'user'` with `owed: []`: `The host declined the request.`
- Notes, posted as `'claude'` with `answers: []` (the colab note style):
  - `The foreman's request stopped at step <n> (<Name>): <why>.`, where why is a `REASONS` text, `the answer failed` or `stopped`;
  - `The foreman's request was dropped when the server restarted.`

Agent matching, in this order:
1. an exact connection id;
2. otherwise a case-insensitive substring of `authorName(board, id)` among `room.connections()`.

The asker is checked after matching, so naming yourself gives "You can't ask yourself."

A playing chain, step by step:
1. Check the step's agent with `room.connections()`. If it is unavailable, post the note and finish.
2. Set `request.step`, then `store.apply({ type: 'chat', text, to: [to], owed: [to], request: { by, step: n, of } }, 'user')`.
3. `room.dispatch(message)`.
4. Wait, through `store.subscribe`, until one of these happens:
   - the message's `owed` no longer has `to`. The step failed if the newest message by `to` after it matches `/^\((my turn failed|stopped|out of time)/`.
   - `to === 'claude'` and an `{ type: 'agent', state: 'error' }` event arrives while the message is still owed. The step failed.
   - the chain is cancelled.
5. Clear the request (`setColabRequest(null)`) when the chain finishes, fails or is cancelled.

`cancel()`, while playing:
- calls `colab.cutAnswer(to)` for a card;
- leaves a running Claude answer to finish (the binary has no way to cut a chat answer);
- posts the "stopped" note.

While waiting, `cancel()` just clears the request with the same note at step 1.

- [ ] **Step 1: Write the failing tests** in `test/requests.test.mjs`.

  The harness is a temp `BoardStore` with a two-card roster, built like `setup()` in `test/room.test.mjs`, plus a fake room:
  - `connections()` returns Claude plus the cards, with availability you can set;
  - `dispatch(m)` records `m`;
  - fake `colab = { status: { state: 'idle' }, cutAnswer: (id) => cut.push(id) }`.

  An agent "answers" when the test applies `{ type: 'chat', text, answers: [m.id] }` as that card. Tests:
  - `only the foreman can ask, and every foreman may`. `claudeRoleId = 'qa'` with card A as `roleId: 'foreman'`: Claude is refused with the text above, and A can ask. Then with `claudeRoleId = 'foreman'`, both can ask, one after the other.
  - `asking posts the chain from the foreman and sends nothing`. Afterwards:
    - `store.board.colab.request.state === 'waiting'`;
    - `steps[i].to` are the resolved ids;
    - the last chat message is from the asker, starting `Asking the host to approve:\n1. `;
    - `dispatched.length === 0`.
  - `a chain is checked before the host sees it`. Unknown name, ambiguous name (two cards whose names both contain "QA"), self, unavailable card, 0 steps and 11 steps all throw. After each one, `colab.request === null` and no chat message has been added.
  - `refused in a run and during an audit`. Use `colab.status = { state: 'running' }`, then `{ state: 'idle', auditing: true }`.
  - `one request at a time`.
  - `No posts the line and sends nothing`. `answer(id, false)`: the last message is from `'user'` and reads `The host declined the request.`; the request is `null`; nothing was dispatched.
  - `a stale answer is refused`. `answer('r_other', true)` throws a `ConflictError`.
  - `Yes plays the steps in order, each after the answer before it`. Two steps (A then B):
    - after `answer(id, true)`, exactly one message is dispatched, to A, with `request: { by, step: 1, of: 2 }` and `to: [A]`;
    - when A answers, the step-2 message goes to B;
    - when B answers, `await requests.settled()` and the request is `null`.
  - `a step waits for its own message`. While step 1 waits on A, the host sends A another message and A answers only that one: step 2 hasn't gone out yet.
  - `a step that fails stops the chain`:
    - A card posts `(my turn failed: boom)` answering step 1. The note `The foreman's request stopped at step 1 (<A name>): the answer failed.` is posted, the request is `null`, and step 2 is never dispatched.
    - A step to Claude ends the same way when `store.emit({ type: 'agent', state: 'error', message: 'x' })` arrives while the message is still owed.
  - `a step that can't run`. B becomes unavailable (`over-budget`) before step 2: the note names step 2 and `over budget`.
  - `cancel stops the rest of the chain`. A cancel during step 1 calls `cutAnswer(A)`, posts the `stopped` note, sends no step 2, and returns `true`. A cancel with nothing going returns `false`.
  - `a restart drops the request with a note`. Set `board.colab.request` to a playing request, then call `recoverAfterRestart()`.

- [ ] **Step 2: Run them and check they fail.** Run `npm run test:server`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement `lib/requests.mjs`, `Room.dispatch` and `ColabRun.cutAnswer`** as specified above. `userChat` calls `this.dispatch(message)` in place of lines 107–108.
- [ ] **Step 4: Run them and check they pass.** Run `npm run test:server`. Expected: all PASS, with `test/room.test.mjs` unchanged and green.
- [ ] **Step 5: Commit.** `feat: foreman requests: ask, approve, play out in order`

---

### Task 3: Wiring: the tool, `/start`, Stop, the route, restart

**Files:**
- Modify: `lib/room.mjs`:
  - constructor: `this.requests = new ForemanRequests({ store, room: this, colab })` and `colab.requests = this.requests`;
  - `userChat`: `/start` and `/stop`;
  - `recover()`: calls `this.requests.recoverAfterRestart()`.
- Modify: `lib/mcp-tools.mjs`:
  - an `ask_agents` definition;
  - a `requests` runner option, put on `context`;
  - add `ask_agents` to `PRUNE_DENIED` and `NOT_IN_BATCH`. Leave it out of `LEAVES_BOARD` and `AUDIT_TOOLS`.
- Modify: `lib/colab/run.mjs`:
  - the constructor accepts nothing new, since `requests` is set by the Room;
  - `#takeTurn` passes `requests: this.requests` to `createToolRunner`;
  - `offered` leaves out `ask_agents` unless `mode === 'answer' && me.roleId === 'foreman'`.
- Modify: `server.mjs`:
  - the main runner gets `requests: room.requests`;
  - `listTools` leaves out `ask_agents` when `store.board.colab.lineup.claudeRoleId !== 'foreman'`;
  - `colabRoute` adds `POST /api/colab/request`;
  - `/api/colab/stop` also calls `room.requests.cancel()`.
- Test: `test/mcp.test.mjs`, `test/room.test.mjs`, `test/server.test.mjs`, `test/colab-run.test.mjs`

**Interfaces:**
- Consumes: `ForemanRequests` (Task 2).
- Produces:
  - Tool `ask_agents`, input `{ steps: [{ agent: string, request: string }] }` (both required), returning `{ waiting: true, id, next: 'The host has been asked to approve this. Their answer and the agents\' answers will appear in the chat; carry on.' }`.
    - Description: `Foreman only, and only when no run is going: ask other agents for work. steps run in order; each goes out after the agent before it has answered, so later steps can build on earlier ones. The host sees the whole list and approves or declines it first. In a run, say it in the chat instead.`
    - Run: `ctx.requests.ask(ctx.author, args.steps)`. With no `requests`: `OpError('Requests are not available here.')`.
  - `POST /api/colab/request` with body `{ id: string, yes: boolean }`:
    - returns 200 `{ ok: true }`;
    - 400 if the body is malformed;
    - 409 if the id is stale (from `ConflictError`).
  - `/start` while `requests.busy`: `OpError("Answer the foreman's request, or let it finish, first.")`.
  - `/stop`:
    - if `requests.busy`, it calls `requests.cancel()` (and `colab.stop()` too if anything else is going) and returns `{ stopped: true }`;
    - the "No run is going." error only when nothing at all is going.

- [ ] **Step 1: Write the failing tests:**
  - `mcp.test.mjs`:
    - `ask_agents reaches the requests object as the caller`: a runner with a fake `requests` records `(author, steps)`.
    - `ask_agents is refused in audits, prunes and batches`: `readOnly` throws; `prune` throws; `batch` with it inside throws.
  - `colab-run.test.mjs`: `only a foreman card answering the host is offered ask_agents`. Check the tool names the fake OpenRouter receives:
    - answer mode with `roleId: 'foreman'` includes it;
    - a turn, or a non-foreman card, doesn't.
  - `room.test.mjs`:
    - `/start is refused while a request waits`: `room.requests.ask('claude', …)` with `claudeRoleId` set to `'foreman'`;
    - `/stop cancels a waiting request`;
    - `recover drops a request`.
  - `server.test.mjs`:
    - `POST /api/colab/request answers once`: Yes returns 200, then the same id returns 409;
    - `a malformed body is a 400`;
    - `the tool list hides ask_agents unless Claude is the foreman`.
- [ ] **Step 2: Run them and check they fail.** Run `npm run test:server`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement the wiring** as listed in Interfaces.
- [ ] **Step 4: Run them and check they pass.** Run `npm run test:server && npm run lint`. Expected: all PASS, lint clean.
- [ ] **Step 5: Commit.** `feat: ask_agents tool, /start and Stop know about requests`

---

### Task 4: What agents are told about a request step

**Files:**
- Modify: `lib/colab/prompts.mjs`: `said()`.
- Modify: `lib/mcp-tools.mjs`: `chatLine()` adds `request_from`; `unansweredChat()` adds `request_from` too.
- Modify: `lib/agent.mjs`: `buildPrompt(messages, board)`, and its call site at line 131.
- Modify: `lib/colab/library.mjs`: the built-in Foreman role's job.
- Modify: `README.md`: the commands/roles sections.
- Test: `test/colab-run.test.mjs` (or wherever `said`/`turnMessage` is tested), `test/read-tools.test.mjs`, `test/agent.test.mjs`

**Interfaces:**
- Consumes: `message.request` (Task 1).
- Produces these texts, where `<F>` is `authorName(board, m.request.by)` and `<to>` names the `to` list as `said()` already does:
  - `said()`: `Host (to <to>), passing on <F>'s request, which the host approved: <text>`
  - `chatLine`: adds `request_from: '<F>'`
  - `buildPrompt`: a first line `[<F>'s request, approved by the host]` above the message text
  - The Foreman job gains one sentence: `Outside a run, you can ask other agents for work with ask_agents; the host approves it first. In a run, say it in the chat.`

- [ ] **Step 1: Write the failing tests:**
  - `a request step reads as the foreman's request`, covering `turnMessage` output, a `view_chat` line's `request_from`, and the `buildPrompt` first line.
- [ ] **Step 2: Run them and check they fail.** Run `npm run test:server`. Expected: FAIL.
- [ ] **Step 3: Implement it, and update the README:**
  - the `/stop` row: also cancels a foreman request;
  - a short "Foreman requests" paragraph: who can ask, the modal, outside runs only.
- [ ] **Step 4: Run them and check they pass.** Run `npm run test:server`. Expected: PASS.
- [ ] **Step 5: Commit.** `feat: agents see a request step as the foreman's, approved by the host`

---

### Task 5: The page: the approval modal, the chat label, Stop

**Files:**
- Create: `web/src/components/RequestDialog.svelte`
- Create: `web/src/components/RequestDialog.test.ts`
- Modify: `web/src/lib/types.ts`:
  - `ChatMessage.request?`;
  - `Colab.request`;
  - an exported `ForemanRequest` type.
- Modify: `web/src/lib/api.ts`: `answerRequest(id: string, yes: boolean): Promise<void>` → `POST /api/colab/request`
- Modify: `web/src/App.svelte`: mount `<RequestDialog />` next to `<Toast />`.
- Modify: `web/src/components/Chat.svelte`:
  - after the `→ <to>` tag on a message with `request`, add `· <F>'s request (<step> of <of>), approved`;
  - the Stop button also shows when `live.board?.colab?.request?.state === 'playing'`.
- Test: `web/src/components/Chat.test.ts`

**Interfaces:**
- Consumes: the board's `colab.request` (Task 1) and the route (Task 3).
- Produces: the `RequestDialog` component.
  - It shows only while `live.board?.colab?.request?.state === 'waiting'`.
  - It is a `role="dialog" aria-modal="true"` titled `<F> asks:`, with one numbered row per step: `<name>: <text>`.
  - Its buttons are `Yes, send it` and `No`. Each calls `api.answerRequest(request.id, yes)`.
  - It has no Escape close, since the host has to answer.
  - An error shows in a `role="alert"` line. A 409 reads "Already answered", and the dialog closes once the board updates.
  - Styled like `SettingsDialog` (backdrop, `bg-raised` panel, `border-line`).

- [ ] **Step 1: Write the failing tests:**
  - `RequestDialog.test.ts`:
    - `shows the whole chain while a request waits`: set `live.board` with a waiting request of two steps. Both rows render in order, and the title names the foreman.
    - `Yes and No answer with the request id`: mock `api.answerRequest` and assert `('r_1', true)`, then `('r_1', false)`.
    - `hidden when nothing waits or a chain is playing`.
  - `Chat.test.ts`:
    - `a request step is labelled as the foreman's, approved`;
    - `Stop shows while a chain plays`.
- [ ] **Step 2: Run them and check they fail.** Run `npm run test:web`. Expected: FAIL.
- [ ] **Step 3: Implement it.**
- [ ] **Step 4: Run them and check they pass.** Run `npm run test:web && npm run check && npm run lint && npm run build`. Expected: all PASS, and the build succeeds.
- [ ] **Step 5: Commit.** `feat: the host approves a foreman request in a modal`
