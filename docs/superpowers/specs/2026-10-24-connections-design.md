# Connections: one chat to every agent, slash commands, no Start button

Date: 2026-10-24
Status: design, agreed in conversation; not yet planned

## Intent

Today the board has three separate ways to talk to a model, and they don't fit
together. The background Claude (`claude -p`) answers chat. An MCP session
that is listening (`wait_for_chat`) takes over from it. OpenRouter agents work
only inside a run that you set up in the Agents panel and begin with
**Start**. While a run goes, Claude says nothing.

The user wants a single room instead. Whoever is connected is listed in the
Collaborate sidebar, each with a role, and the chat is how you talk to them.
A plain message goes to everyone, `/chat N` goes to one, and `/start` begins
the round robin. Claude is always the first connection, through the binary or
through MCP, and it takes part like everyone else.

## Behaviour

### Connections

- **1. Claude: the direct connection.** There is always exactly one, and it is
  always number 1. It is labelled with how it is connected right now:
  - **via binary:** the default. At startup the server looks for `claude`, or
    for `IDEA_BOARD_CLAUDE` if that is set.
  - **via MCP:** an interactive Claude Code session is listening with
    `wait_for_chat`. As today, it takes precedence over the binary while it is
    attached, and the binary takes over again after the 5-minute detach grace.
  - **not connected:** there is no binary and no session listening. The card
    shows a warning saying that `claude` wasn't found, the
    `claude mcp add --transport http idea-board <url>/mcp` command, and
    "then ask Claude to listen to the board chat". The server prints the same
    warning at startup.

  Claude has a role picker that uses the same role library as the other
  agents. Its role's job text and the shared rules go into its prompt, along
  with its existing board system prompt. It cannot be removed or reordered.
- **2…N: OpenRouter connections.** These are the current agent cards, added
  with **+ Add connection** (today's **+ Add agent** flow and model picker).
  Each has a role and a ✕, and can be dragged to reorder.
- **Numbering** is the position in the sidebar at the moment a message is
  sent. Claude is 1 and the OpenRouter cards follow from 2.
- **Activity** is shown on every card: Waiting, Thinking…, or the current tool
  activity (today's `activity` strings such as "adding group “Heists”").
- Adding more kinds of direct connection (other CLIs) is **later, not in this
  work**. The user wants to look at it in a few days.

### The chat

There is no Start button. What you type decides who answers:

| You type | Who gets it | What happens |
|---|---|---|
| `Do you like this design for the Warlocks?` | every connection | Each answers once, in its own voice and role, all at the same time. None of them reads the others' answers to this message before replying. |
| `/chat 2 Do you like…` or `/c 2 …` | connection 2 only | Only that agent answers. The others still see the message in the chat history the next time they are asked something; they just don't reply to it. |
| `/start ok guys, lets build out the classes…` | every connection | Starts the round robin: they take turns in sidebar order, reading each other's work and building on the board, until the rounds cap, the budget, or a stop. The text after `/start` is the kickoff. |
| `/stop` | (no one) | Ends the run after the current turn, and cuts the current call short, as the Stop button does today. |
| Anything typed during a run | every connection | Steers the run. Each agent sees it on its next turn, as today. It does not also start a round of plain answers. |

- **`/chat N` during a run** *(my call)*: it doesn't interrupt. Connection N
  gets it on its next turn, marked as addressed to it. The others see it but
  are told it isn't for them.
- **Who owes an answer** *(my call)*: only the connections that are able to
  answer when a message is posted. A connection added later, a Claude that
  connects later, or a budget raised later never brings on a backlog of
  answers to old messages. A plain message nobody can answer is still posted,
  with a short note saying no one is connected. `/chat 1` while Claude is not
  connected, or `/chat N` to an agent that is over budget, counts as invalid
  (see below).
- **Conversations** *(my call)*: each agent keeps one conversation through
  plain answers, `/chat` answers and `/start` runs for as long as the server
  is running, capped as today (it starts over with the full board once it
  passes 400,000 characters). A restart starts every conversation fresh. They
  are not saved to disk.
- **During a run,** the chat header reads "Round 2 of 5 · GPT-5's turn" and
  has a **Stop** button, which does the same as `/stop`. The card whose turn
  it is lights up.
- **Answers keep the board tools.** An agent answering a plain message or a
  `/chat` can change the board, as Claude can today when it answers chat.
- **A slash message shows in the chat** with its target visible, for example a
  "→ 2. GPT-5" tag on a `/chat 2` message, so the chat reads correctly later.
- **Typos and invalid commands are not sent.** This covers an unknown command,
  `/chat` with a number that has no connection, `/chat` with no text, `/start`
  while a run is going, and `/stop` with no run. The text stays in the input
  box and a short inline hint lists the commands. While the input starts with
  `/`, a one-line hint below it shows the commands.

### Limits and spend

The footer of the sidebar holds **Rounds**, **Budget**, **Turn timeout**,
**Spent $0.42 of $5.00** and **Edit roles…**. The spend total moves here from
the chat header.

- **One budget covers everything:** plain-message answers, `/chat` answers
  and `/start` runs. Spent counts up across all of them and is saved with the
  board, so it survives a restart. Raising the budget lets agents answer
  again. When spent reaches the budget, OpenRouter connections stop answering:
  their cards say so and a chat note says it once. Claude keeps answering,
  because it runs on the user's Claude plan, which this budget doesn't count.
- **Resetting spent** *(my call)*: a small **Reset** button next to
  "Spent $x of $y" puts it back to $0.00 after a confirm. Nothing resets it
  on its own. An existing board starts at $0.00.
- **Budget reached during a `/start` run** *(my call)*: the run ends, as it
  does today, with a note. Claude doesn't carry on alone.
- **Turn timeout** applies to every OpenRouter answer, not only run turns.
- **Rounds** applies to `/start` runs.

### Startup and flags

- `--no-agent` is removed. The server always tries the binary. (Development
  that wants no background Claude can set `IDEA_BOARD_CLAUDE` to a missing
  path, which ends up in the "not connected" state.)
- The README's Agents, "Claude in the chat" and Development sections are
  rewritten to match.

## Goals

1. One sidebar lists every connection with its number, role and live
   activity, as in the approved mockup (Direct connection on top, OpenRouter
   connections below, limits and spend in the footer).
2. Chat is the only control: plain messages go to everyone, and `/chat N`
   (alias `/c N`), `/start` and `/stop` cover the rest.
3. Claude takes part in everything, including `/start` runs, through
   whichever connection it has.
4. Money is always capped and visible.

## Non-goals

- More than one direct connection, and other CLIs as direct connections
  (later).
- Agents reading each other's answers to a plain message. That is what
  `/start` is for.
- Per-run budgets.
- Temperature and other model settings in the UI (unchanged from the colab
  design).

## Anti-goals

- **A plain message silently costs more than the user expects.** The cap
  covers every OpenRouter call and spend is always on screen.
- **Two Claudes answer the same message.** The binary and an MCP session must
  never both reply.
- **A typo becomes a broadcast.** An invalid slash command never reaches the
  agents.
- The OpenRouter key still never reaches the page or the board file
  (unchanged).

## Constraints

- Keep what already works in `lib/colab/run.mjs`: per-agent conversations
  kept between turns, stats under each post, retrying dropped replies, the
  turn time limit with a closing message, cache marking, authorship and
  "<name> added" marks, and run recovery after a restart.
- The binary Claude keeps its own session (`claudeSessionId`) and its tool
  restrictions: board MCP tools only.
- The board file stays backward compatible. An existing `colab.lineup` loads
  as the OpenRouter connections, and Claude's role defaults to Foreman if
  there is one, otherwise to the first role.
- Node 18+ for the server, with no runtime dependencies (unchanged).

## Left to the builder

- Undo grouping: parallel answers must each get their own undoable turn.
  Today `store.claudeTurn` is shared by every AI author.
- Stable ids for OpenRouter cards. Two cards with the same model and role are
  allowed, and today they would share an `agentId`.
- Sidebar edits stay locked during a run, as the line-up is today.

- Where slash commands are parsed. Prefer the server, so a chat op carries its
  target and every path (page, tests, MCP) agrees. The page only does the
  inline validation hint.
- How Claude takes a run turn:
  - **Binary:** a `claude -p` call, resumed in its session, whose prompt says
    it is its turn and what changed since its last turn.
  - **MCP:** `wait_for_chat` returns a "your turn" item, and the run waits for
    the session's `reply`, up to the turn timeout. A session that never
    replies is treated like a timed-out turn.
- How `wait_for_chat` and the binary skip messages that were `/chat`'d to
  someone else.
- How replies to a plain message are tracked, so each connection answers each
  message exactly once (for example a per-connection "answered" set,
  replacing the single `handled` flag for Claude).
- Queueing when a new plain message arrives while some agents are still
  answering the last one. Suggested: each connection answers its pending
  messages together on its next go, as the binary Agent does today.
