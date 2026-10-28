# Defaults file: the agents' texts out of the code

## Why

Every text an agent is given — the shared rules, the roles, Claude's chat prompt, the turn and
answer rules, the audit and prune instructions — is hard-coded in JavaScript. The host wants to
tune them (the agents have been arguing over pixels instead of keeping a 30,000-foot overview of
the game) and wants them where a person can read and change them, shipped with the app. Their
motto: KISS, and everything that's related goes together.

## What we're building

1. **One `defaults.json` at the repo root**, next to `server.mjs`, shipped with the app. It holds
   every behaviour text, in the shape the host asked for:

   ```json
   {
     "shared": "…the shared rules…",
     "roles": {
       "Creative Director & Lore": "…job…",
       "QA & Playtester": "…job…",
       "Foreman": "…job…",
       "Systems Designer": "…job…"
     },
     "chat": "…Claude's chat prompt…",
     "turn": "…how to play a turn in a run…",
     "answer": "…how to answer the host…",
     "audit": "…the final audit's instructions…",
     "prune": "…the prune pass's instructions…"
   }
   ```

   Plain strings, one per key; role name → job. No markers or templating: the code adds the
   facts around them (see "Behaviour vs mechanics").

2. **No behaviour text left in the code.** `DEFAULT_LIBRARY`, `TURN_RULES`, `ANSWER_RULES`,
   `SYSTEM_PROMPT` (agent.mjs), `DEFAULT_AUDIT_TEXT`, `PRUNE_SYSTEM_PROMPT`, the Brainstorm/Brief
   description in the card system prompt, and the behaviour parts of `BINARY_TURN_END`,
   `TURN_NEXT` (mcp-tools.mjs) and `INSTRUCTIONS` (mcp.mjs) all come from the file instead.

3. **First run copies it.** When `~/.config/idea-board/colab.json` doesn't exist, it's built from
   `defaults.json`: `shared` → `rules`, each role → `{id, name, job}` with the id made from the
   **first word** of the name (lower case, a-z0-9 only; a clash gets `-2`, `-3`…). That gives
   `creative`, `qa`, `foreman`, `systems` — today's ids — so a board whose line-up names them
   still works when `colab.json` is rebuilt (new machine, file deleted), and `foreman`, which the
   code relies on, stays `foreman`. *(Our call.)* The user's `colab.json` keeps its current shape
   (`rules`, `roles` array, `passes`), so existing files and boards keep working.

4. **Chat, turn and answer become editable in the app**, like audit and prune are now. In the
   Roles box (Connections → Edit roles…), the "Passes" list becomes "Prompts" (or similar) with
   Chat, Turn, Answer, Final audit and Prune. Each pane works like `PassPane` today: text equal to
   the default is stored as nothing, an empty override falls back to the default, and **Reset to
   default** restores the `defaults.json` text. The overrides live in `colab.json` alongside the
   existing `passes` (extending `passes` with `chat`, `turn`, `answer` is fine). The next agent
   turn uses the change; no restart.

5. **Startup fails loudly** if `defaults.json` is missing, isn't valid JSON, lacks a key, has an
   empty text, or has no roles — naming the file and what's wrong. The same limits as the
   library's validation apply (role names ≤ 80 chars, texts ≤ 20,000, 1–20 roles, unique ids).
   Edits to `defaults.json` take effect on restart; that's fine (it's for shipping, not tuning).

6. **Reworded defaults.** `shared` is the host's new text (below), verbatim. The builder rewords
   `turn`, `answer`, `chat` and the four role jobs so they agree with it (see "The new texts").
   `audit` and `prune` move over unchanged.

## Behaviour vs mechanics

The file says **how an agent should behave**. The code keeps only **how the machine works**:
facts that are true because the code makes them true, and that would break things if a host
deleted them. Those stay in code, short, and are added around the file's text:

- who the agent is, its role's job, who the others are, whether it's taking a turn or answering
  (the "You are X, one of N agents… The others are …" line);
- "your final reply is posted to the chat under your name; there is no chat tool" and, for an
  MCP session, "call reply, then wait_for_chat again";
- the audit's "you can only read; your reply is posted as the report";
- the labels that frame data: "The chat so far:", "Since your last turn:", "Changes on the
  board:", "It is your turn, X.", "Answer the host, X.", the out-of-time / out-of-moves wrap-up
  asks, the prune pass's settings and section sizes block.

If a line is both (e.g. "3 to 5 sentences" inside `BINARY_TURN_END`), the behaviour half goes to
the file and the mechanics half stays.

## Everyone gets the same turn rules

Today a card agent gets `TURN_RULES`, but Claude in a run gets its chat prompt plus a separate
`BINARY_TURN_END` (binary) or `TURN_NEXT` (MCP session), each saying "3 to 5 sentences" in its
own words. After this change every agent taking a run turn gets the `turn` text. Exactly what
each one gets *(our call)*:

| Who, doing what | System prompt | Added to the turn's message |
|---|---|---|
| Card, run turn | identity line + job + `shared` + `turn` | — |
| Card, answering the host | identity line + job + `shared` + `answer` | — |
| Claude binary, chat with the host | `chat` + role + `shared` (as now) | — |
| Claude binary, run turn | the same (one resumed session) | `turn`, replacing `BINARY_TURN_END`'s behaviour |
| Claude MCP session, connecting | `INSTRUCTIONS` = mechanics + `chat` | — |
| Claude MCP session, run turn | — | `turn`, in the `next` text of the `wait_for_chat` result (replacing `TURN_NEXT`'s behaviour) |

So `chat` is Claude's "talking with the host" prompt; it must not contradict `turn`, and should
say that in a run turn the turn rules in the message apply. `answer` is for cards only (Claude's
chat already is its answer). An edit to `turn` reaches every agent on its next turn; an edit to
`chat` reaches an attached MCP session when it reconnects *(our call; acceptable)*.

## The new texts

### shared (the host's, verbatim; they may still tweak it)

```
# Mission

We are designing a game together. You have creative freedom, access to a shared board, and responsibility for improving the design.

Stay in your role, but challenge anything when you see a concrete problem. Good ideas can come from anyone.

Everything you write must be clear and readable by a human.

# Authority

- The **host** has final say. When the host and foreman disagree, the host wins.
- The **foreman** runs the session, delegates tasks to any agent, and resolves disagreements between agents.
- A decision is **approved** only when the host or foreman says so. Agreement between other agents is not approval.

# How to contribute

- Fun comes first. The game must be beautiful, understandable, compelling, and worth replaying.
- The player's experience matters more than the elegance of our design.
- Keep the game to [3–5] core mechanics that interact. To add one, say which one it replaces or which decision it improves.
- Every new mechanic must improve an existing decision, create a meaningful tradeoff, or replace something weaker.
- Criticism, simplification, balancing, and deletion count as contributions, and are often the best ones.
- Challenge weak ideas directly: name the problem and suggest the smallest fix.
- Change your mind when shown a better argument. Defending a bad idea wastes everyone's time.
- Approved decisions are current agreements, not permanent truths. Reopen one only with a concrete flaw.
- Separate assumptions from facts. Nothing is "fun" until people have played it.
- If you have nothing useful to add this turn, reply with exactly `PASS`. That is a good turn, not a failure.
- Don't post agreement or praise ("great idea", "+1"). Silence means agreement.
- Chat messages: 3 sentences max. Put the substance on the board, not in chat.

# Editing the board

- Edit freely inside your role's area.
- Outside your role, propose the change in chat. The foreman applies it or tells you to.
- Change entries in place and delete what they replace. Never write "SUPERSEDED" or leave history.
- Before you post, review your own earlier entries and delete any that are no longer needed. Context is limited, so keep the board lean.

# The board

**Purpose:** a high-level design overview. A newcomer should understand the whole game in five minutes.

**Sections:**
- **Brief:** what the game is, its main rules and decisions, in a few short sections.
- **Brainstorm:** one group per scene or screen, in play order. Each entry is one thing the game does, in one short plain sentence ("Tap a card to put an X on it").
- **Flowchart:** screens and the buttons that move between them. Nothing else.

**Keep off the board:** pixel sizes, fonts, colour codes, millisecond timings, maths, test procedures, and debate or history ("QA was right that…"). Those belong in the build or in chat.

**Every design must cover:** controls a player can actually use, clear feedback, a slick UI, and a meaningful scoring or progression system. If one is missing, flag it.
```

### What the reworded texts must do

- **turn**: agree with `shared` — 3 sentences max in chat, `PASS` is a good turn, no praise,
  substance on the board. Drop the old "about 3 to 6 changes" and "3 to 5 sentences". Keep the
  useful how-to: the board is in your messages (whole on the first turn, changes after), read
  ruled_out, use rule_out with a reason rather than deleting others' work, view_* tools to check
  a part mid-turn.
- **answer**: answer in your role, briefly (≤ 3 sentences), others answer at the same time so
  give your own view, you may change the board and say what you changed.
- **chat** (Claude, outside a run): today's `SYSTEM_PROMPT`, trimmed of anything `shared` now
  says (the board's purpose and what belongs on it), keeping the tool how-to (view_brief first,
  ruled_out, rule_out on rejections, Pointing at, file reading, "Claude added").
- **roles**: the four jobs, reworded to the overview level (scenes and what the player does,
  not pixels). The Foreman keeps: coherence, merging, settling contradictions, keeping the
  Brief to current decisions, the last turn of each round with its 1–10 score and next focus,
  and `ask_agents` outside a run. The Foreman also now owns what `shared` gives it: approving
  decisions and applying out-of-role changes others propose.

The host will review these in the app and keep tuning them; they don't need to be perfect.

## Non-goals

- The board tools' own descriptions (`DEFINITIONS` in `lib/mcp-tools.mjs`) stay in code.
- No save-back button from the app to `defaults.json`; the host copies text over by hand.
- Shared rules and roles in an existing `colab.json` don't follow `defaults.json` and get no
  Reset button (only the prompts in item 4 do). The host pastes the new `shared` into their own
  copy through the app.
- The card prompt's Brief/Brainstorm/Flowchart description is dropped from code, not moved to a
  new key: `shared` now describes the board *(our call)*. An existing `colab.json` keeps its old
  rules, so its agents lose that description until the host pastes the new `shared` into Shared
  rules — the host is doing that anyway.
- `PASS` replies are posted to the chat as they are; no special handling.
- No new default roles (the host's own Art Director stays in their own `colab.json`).

## Left to the builder

- Where the loading code lives and how it's passed around (a small `lib/defaults.mjs` that reads
  and validates the file once at startup is the obvious shape); tests can load a fixture.
- The exact name of the Prompts list and its panes, following `RoleEditor`/`PassPane`.
- How `passDefaults` reaches the page (today `/api/colab` sends `passDefaults`; extend it).
- Exact wording of the reworded texts, within the rules above.
- Updating the README where it describes roles, passes and `colab.json`.
