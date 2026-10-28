# Defaults file: the agents' texts out of the code

## Why

Every text an agent is given — the shared rules, the roles, Claude's chat prompt, the turn and
answer rules, the audit and prune instructions — is hard-coded in JavaScript. The host wants to
tune them (the agents have been arguing over pixels instead of keeping a 30,000-foot overview of
the game) and wants the starting texts in a file shipped with the app, not in code. Their motto:
KISS, and everything that's related goes together.

## The host's design (as they put it)

> File default.json has the system prompts.
> - When you first run the app it has nothing for system prompts.
> - It sees that there is nothing, then populates the values from default.
> - When the user hits reset in the UI (when editing a role) it resets the prompt to what's in
>   default.json.

That's the whole model: `defaults.json` is the starting point and the source for Reset. The app
only ever reads the user's own settings (`~/.config/idea-board/colab.json`).

## What we're building

1. **`defaults.json` at the repo root**, next to `server.mjs`, shipped with the app:

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

   Plain strings; role name → job. Read once at startup. If it's missing, isn't valid JSON, lacks
   a key, has an unknown key, a blank text or no roles, the server won't start and says which file
   and what's wrong. Limits as the library's: names ≤ 80, texts ≤ 20,000, 1–20 roles.

2. **No behaviour text left in the code.** `DEFAULT_LIBRARY`, `TURN_RULES`, `ANSWER_RULES`,
   `SYSTEM_PROMPT` (agent.mjs), `DEFAULT_AUDIT_TEXT`, `PRUNE_SYSTEM_PROMPT`, the Brief/Brainstorm/
   Flowchart sentence in the card system prompt, and the behaviour parts of `BINARY_TURN_END`,
   `TURN_NEXT` (mcp-tools.mjs) and `INSTRUCTIONS` (mcp.mjs) come from the user's settings instead.

3. **The user's settings hold every prompt.** `colab.json` becomes
   `{ rules, roles: [{id, name, job, pictures?}], prompts: { chat, turn, answer, audit, prune } }`.
   When the app starts, anything missing is filled from `defaults.json` and written back:
   - no file → everything (`shared` → `rules`, the roles, all five prompts);
   - no `rules` → `shared`; no roles → the default roles;
   - a missing prompt → its default (an emptied one stays empty).
   An old file's `passes.audit` / `passes.prune` move into `prompts` (a non-blank one wins over
   the default), and `passes` goes away. So the host's current file keeps its shared rules, roles
   and audit text and gains chat, turn, answer and prune.

   A role's id comes from the **first word** of its name (lower case, a-z0-9; a clash gets `-2`,
   `-3`…; no word → `role`): `creative`, `qa`, `foreman`, `systems` — today's ids, so boards that
   name them keep working, and `foreman`, which the code relies on, stays `foreman`. *(Our call.)*

4. **Everything is edited in the app** (Connections → Edit roles…). The list gets a **Prompts**
   section — Chat (Claude), Turn, Answer, Final audit, Prune — each a text box like Final audit's
   today. Edits are saved to `colab.json` and used on the next agent turn.

5. **Reset to default** puts back the `defaults.json` text: on each prompt, on Shared rules, and on
   a role whose id is one of the default roles (its job; the name stays). A role that isn't in
   `defaults.json` (the host's Art Director) has no Reset. The button is disabled while the text
   already equals the default.

6. **Reworded defaults.** `shared` is the host's new text (below), verbatim. The builder rewords
   `turn`, `answer`, `chat` and the four role jobs so they agree with it. `audit` and `prune` move
   over unchanged.

## Behaviour vs mechanics

The prompts say **how an agent should behave**. The code keeps only **how the machine works**:
facts true because the code makes them true, which would break things if a host deleted them:

- the identity line ("You are X, one of N agents… The others are …"), "Your role: …";
- "your final reply is posted to the chat under your name; there is no chat tool"; for the
  binary, "do not call reply yourself" and that it can read (not change) project files; for an
  MCP session, "call reply, then wait_for_chat again", batch, and that changes are undoable;
- the audit's "you can only read; your reply is posted as the report";
- the labels that frame data: "The chat so far:", "Since your last turn:", "Changes on the
  board:", "It is your turn, X.", "Answer the host, X.", the out-of-time / out-of-moves wrap-up
  asks, the prune pass's settings and section sizes.

## Who gets what

Every agent taking a run turn gets the `turn` text; Claude's old "3 to 5 sentences" lines go.

| Who, doing what | System prompt | Added to the turn's message |
|---|---|---|
| Card, run turn | identity + job + shared rules + `turn` + reply mechanics | — |
| Card, answering the host | identity + job + shared rules + `answer` + reply mechanics | — |
| Claude binary, chat with the host | `chat` + binary mechanics + role + shared rules | — |
| Claude binary, run turn | the same (one resumed session) | `turn` + "your reply is posted as your message to the others" |
| Claude MCP session, connecting | MCP mechanics + `chat` | — |
| Claude MCP session, run turn | — | `next` = "It is your turn…" + `turn` + "call reply, then wait_for_chat" |

`chat` is Claude's "talking with the host" prompt; it must not contradict `turn` and should say
that in a run turn the turn rules in the message apply. `answer` is for cards (Claude's chat is
its answer). An edit to `chat` reaches an attached MCP session when it reconnects *(our call)*.

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
  substance on the board. Drop "about 3 to 6 changes" and "3 to 5 sentences". Keep the how-to:
  the board is in your messages (whole on the first turn, changes after), read ruled_out, use
  rule_out with a reason rather than deleting others' work, view_* tools to check a part mid-turn.
- **answer**: answer in your role, briefly (≤ 3 sentences); others answer at the same time, so
  give your own view; you may change the board, and say what you changed.
- **chat** (Claude with the host): today's `SYSTEM_PROMPT`, trimmed of what `shared` now says,
  keeping the tool how-to (view_brief first, ruled_out, rule_out on rejections, Pointing at,
  "Claude added").
- **roles**: the four jobs at overview level (scenes and what the player does, not pixels). The
  Foreman keeps coherence, merging, settling contradictions, keeping the Brief to current
  decisions, the last turn of each round with its 1–10 score and next focus, and `ask_agents`
  outside a run; and gains what `shared` gives it: approving decisions and applying out-of-role
  changes others propose.

The host will keep tuning these in the app; they don't need to be perfect.

## Non-goals

- The board tools' own descriptions (`DEFINITIONS` in `lib/mcp-tools.mjs`) stay in code.
- No save-back from the app to `defaults.json`; the host copies text over by hand.
- `defaults.json` is read at startup only; editing it means a restart.
- `PASS` replies are posted as they are; no new default roles.

## Left to the builder

- How the prompts reach the agent and the MCP session (the Room already hands a `role()` getter to
  both; a `prompts()` getter alongside is the obvious shape).
- Pane layout and wording, following `RoleEditor` / `PassPane` / `RolePane`.
- Exact wording of the reworded texts, within the rules above.
- README updates where it describes roles, passes and `colab.json`.
