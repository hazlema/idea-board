# /prune: keeping the board small enough to read

## Why

After a 20-round run on the ninjas board, Claude said the board was "too large for me to read" and
could no longer check its own work. Measured on a copy of that board:

- `view_board` returned about 87,000 characters (roughly 25,000 tokens). That is Claude Code's cap on
  a single MCP tool result, so Claude's view of the board was being cut off.
- It came to Brainstorm 44K, Brief 27K, Flowchart 9K, Ruled out 5K and Recent history 2K.
- Much of it is the same decision written several times. The Brief's "Build order (decided)" also
  appears as the "Build plan (merged, A→C)" group, "Slice A spec: implement this" restates Brief
  sections, and 20 of 24 flowchart cards are still unaccepted ideas.
- 72 items are marked as agent-added and never reviewed, so nothing ever leaves.

Telling agents to stay pithy and to remove stale ideas did not stop the growth. Every round adds a
cleaner restatement of something, and nothing retires the older copy.

## What it is

A pruning pass by the Foreman (Claude, the direct connection). Its only job is to make the board
smaller without losing a decision. It runs when the host types `/prune`, and on its own between
rounds of a run once the board gets big.

Success means the board stays well under what Claude can read across a long run (20+ rounds), every
decision is still on the board afterwards, and the host can see what changed and undo it.

## Rules (decided by the host)

**Law. The pruner never changes or deletes these:**

- Plain bullets: group entries with no checkbox. This holds whoever wrote them, the host or an agent,
  and they stay word for word. A checkbox item that contradicts a plain bullet is the one to cut.
  (The host is trusting agents to use plain bullets only for things they are sure of; this may be
  tuned later.)
- The ruled-out list. The pruner may add to it but never removes anything.
- The chat. It is never edited.

**Fair game. The pruner may merge, rewrite, shorten or delete these:**

- Checkbox entries, ticked or not, whoever wrote them, the host included. The agents may have found
  a better approach than the host's.
- Groups, notes and Brief sections. All Brief sections are fair game, since the AI wrote all of the
  current Brief.

**Our calls (not discussed with the host; listed so they can be checked):**

- Accepted flowchart cards are law. Flowchart cards still marked "idea" are fair game. Rejected
  cards already have ruled-out records, so deleting the card loses nothing.
- Pictures are kept (they are the reference art in the export). Their captions are fair game.
- Topic bubbles and links follow what they connect: a link to a deleted object goes with it.
- Group titles are fair game. A group whose remaining entries are all plain bullets stays a group,
  and only its title may change.
- What the law guard allows and refuses:
  - **Plain bullets** may be moved or reordered, including into another group, so groups can be
    merged. Their label and text may not change, and they may not be deleted. A group that still
    holds a plain bullet can't be deleted; the bullet has to be moved out first.
  - **No new plain bullets:** the pruner may not add one, or take the checkbox off an entry, during
    a pass. That would create text that can never be pruned again. Merged results are checkbox
    entries or Brief text.
  - **Struck-through (ruled-out) entries** stay where they are. They are part of the ruled-out
    memory, and Bring back depends on them.
  - **Accepted cards:** the title, notes and status are frozen. Connections between two accepted
    cards are frozen too. Cards may still be moved, and tidy layout still works.

## How it prunes, most important first

1. Delete exact duplicates.
2. Merge restatements into one place. The settled version wins, usually the Brief.
3. Retire working copies whose content now lives somewhere settled.
4. Shorten wording (labels, descriptions, section text), but only when the meaning, the numbers and
   the reasons all survive. If it can't be shortened without losing context, it stays as it is.

## When it runs

- **`/prune`**: the host can type it at any time. While idle, it starts right away. During a run, it
  happens after the current round ends, and the run then carries on. `/prune` with extra text passes
  that text to the pruner as guidance (for example `/prune focus on the brainstorm`). It joins the
  other slash commands in the hint and the README.
- **Automatically**: between rounds of a run, when the board has reached about half of what Claude
  can read. That is a `view_board` result of about 45,000 characters, a named constant to be tuned.
  The trigger is the board's size, not a count of turns. It doesn't fire again until the board grows
  back over the threshold. If a pass leaves the board still over the threshold, the run carries on;
  the next round boundary may try once more. The builder should make sure a stuck board can't
  trigger a prune every single round.
- Not in the middle of anyone's turn. While a pass runs, nobody else acts: the run waits, and chat
  the host sends waits to be answered until the pass ends.

## Who prunes

Claude, the direct connection, using whatever model is chosen for it (the host usually picks Opus).
It costs nothing from the OpenRouter budget.

Our calls:

- The pass runs through the `claude` binary, not an MCP session. A board that is already too big
  can't be passed back through an MCP tool result (the 25,000-token cap applies to `wait_for_chat`
  too). With no binary, `/prune` is refused with a reason ("/prune needs the claude command"), and
  automatic passes are skipped with a one-line note in the chat.
- The pruner is given the whole board in its prompt, so it never relies on `view_board` and works
  even on a board that is already over the limit, such as ninjas. The prompt must go to the binary
  on stdin, not as a command-line argument: Linux caps a single argument at 128 KiB, and a big board
  would go past that.
- The pass is its own turn: a fresh session that doesn't resume Claude's normal chat session and
  doesn't take Claude's place in the round order. Claude's normal conversation mark is not moved,
  so on its next normal turn Claude sees the pruning as board changes.

## Stopping, time and the host

Our calls:

- **Time limit:** a pass gets the board's turn timeout (the sidebar's Turn timeout, 30 minutes by
  default), not the fixed 10 minutes of a chat answer.
- **Stopping:** Stop or `/stop` during a pass cancels it, and the run around it if there is one.
- **A pass that stops halfway** (cancelled, out of time or crashed) keeps what it already did, as one
  undoable step. Its summary says it was cut short.
- **The host's edits:** the host can still edit the page during a pass, as during any agent turn.
  Undo then keeps anything the host changed since, as it does today ("Kept N items you changed
  since").
- **`/prune` while connections are answering a plain message** waits for those answers to finish,
  then starts.
- **Repeat passes:** after an automatic pass, the next one needs the board to have grown at least
  10,000 characters past the size that pass left it at. This is a named constant. A board that
  won't shrink then can't trigger a prune every round.

## Safety

- A version named "Before prune" (with the date and time) is saved first.
- The whole pass is one undoable step, undone the way any Claude reply is today (History → Undo this
  reply). Undoing it also removes any ruled-out records the pass added. Ctrl+Z stays as it is: it
  steps through the host's own changes.
- The law is enforced by the server, not just stated in the prompt. During a prune pass, an op that
  would change or delete a plain bullet, an accepted card or a ruled-out record, or edit the chat, is
  refused. The pruner sees the refusal and moves on.
- When it's done it posts a short summary in the chat: what was merged, what was cut and what was
  shortened, plus the board size before and after (in `view_board` characters).
- **Review (decided by the host):** the pruner only updates. Its changes get no "Claude added" mark
  and no Keep or Dismiss. Dismiss would send a merged decision to the ruled-out list, which is law.
  The host reviews a pass through the chat summary and History, and undoes the whole pass if needed.
- **Credit (decided by the host):** whoever started an idea keeps the credit. An item the pruner
  rewrites, shortens or merges into keeps its original author, so it shows the same name in History,
  on its mark and in the export. History records the pass itself as the pruner's turn. When two
  items merge, the one that survives keeps its own author. Our call: if the merged text mostly comes
  from the other item, keep the author of whichever was settled first (ticked, or in the Brief).

## Goals

- Long runs stay readable: Claude can always read the whole board.
- No decision is lost: plain bullets, accepted cards and the ruled-out list survive word for word.
- The host can see and undo what was done.

## Non-goals

- New reading tools (a `view_board` table of contents, per-part readers). That comes next, after
  pruning.
- Capping how much chat a board read returns (for example the last 20 messages). That's for another
  day.
- Changing how agents write in normal turns.
- Pruning by OpenRouter agents.

## Anti-goals (a failure even if it technically works)

- A plain bullet, an accepted card or a ruled-out record is changed or lost.
- A decision quietly disappears: it is merged away without its numbers or reasons surviving
  somewhere.
- A pass the host can't see or undo.
- Pruning runs so often that it eats into the run, or loops round after round.

## Left to the builder

- The exact prune prompt (it should carry the rules and the order above).
- How the server knows a prune pass is the author of an op (for the law guard and for the one undo
  step).
- How size is measured. The `view_board` JSON length is the reference.
- The summary's wording.
- Tests, including a fixture shaped like the ninjas board: duplicates across the Brief and groups,
  plain bullets, an accepted card and idea cards.
