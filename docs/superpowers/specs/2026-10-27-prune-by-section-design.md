# Prune by section

## Why

Prune exists because a board grew too big for its collaborators to read: the ninjas board hit
about 25K tokens in one `view_board` answer, Claude Code's cap on a tool's output, and Claude
could no longer see it. Today the server measures the whole board as one number and, at 45,000
characters, prunes all of it.

The board is now read one section at a time (`view_brief`, `view_brainstorm`, `view_flow`,
`view_chat`), so the cap applies to each section on its own. The host's words: "should take sizes
on the different sections and run prune. Probably will need a lot less pruning now that we have
basically quadrupled the context. No sense pruning a section that does not need it."

Success: prune runs far less often, and when it runs, it works on the section that is too big and
leaves the rest of the board alone.

## What it is

### Decided by the host

- **Measured per section.** The server measures the Brief, the Brainstorm and the Flowchart
  separately. A section over its limit gets pruned; a section under it is not touched.
- **Cross-section clean-up.** When a pass cuts an idea from the section that is too big, it also
  removes that idea's pieces in the other sections (its Brief text, its cards, its entries), even
  though those sections are not over their limit.
- **`/prune` always runs when the host asks.** If no section is over its limit, the page first
  asks: "Pruning isn't needed: every section is under its limit. Prune anyway?" Yes runs it over
  the whole board, as `/prune` does today; No cancels, and the typed text stays in the box.

- **Aggressiveness stays as set.** A pass prunes at the strength chosen in Settings → Pruning;
  getting a section under its limit does not override it, so a Gentle pass stays gentle. If a
  section a pass worked on is still over its limit afterwards, the pass's chat note ends with a
  warning that names it, e.g. "The Brainstorm is still over its limit (84,000 of 80,000
  characters). Raise Aggressiveness under ⋯ → Settings → Pruning and run /prune again." The prompt
  gives the sizes and the limit for context, not as a target.

### Our calls (not discussed with the host; listed so they can be checked)

- **The limit:** 80,000 characters for each section, measured as the JSON its reading tool returns
  by default (`view_brief`, `view_brainstorm`, `view_flow` without full notes). That is about 20K
  tokens, under the 25K cap with room to spare, and the same figure `view_chat` uses
  (`MAX_CHAT_CHARS`).
- **The Brief is measured without the ruled-out list,** although `view_brief` carries both. The list
  is law during a prune, so a pass can't shrink it, and every cut mechanic adds to it. Counting it
  would point passes at the host's Brief text to make room, or push the Brief over the limit after
  a Brainstorm pass. If the list itself grows big enough to crowd `view_brief`, that is separate
  work.
- **Regrow, per section:** after a section is pruned, it is not pruned automatically again until it
  is over its limit *and* has grown 10,000 characters past what the last pass left. This is
  today's rule (`PRUNE_REGROW`), counted per section. Every pass that runs records what it left for
  each section it pruned, the host's `/prune` included (today only automatic passes do), so a
  `/prune` that leaves a section just over is not followed by an automatic pass the next round. A section that drops back under its limit
  (pruned by hand, say) starts fresh.
- **One pass for several sections.** If two or three sections are over in the same round, one pass
  runs and is told about all of them. It is cheaper than one pass each, and it sees the overlap
  between them.
- **What the pass reads:** the whole board, as today (it needs to know which pieces belong to an
  idea). The prompt adds which sections are over, with their sizes and the limit, and tells it to
  work on those sections and to touch the others only to remove the pieces of ideas it cuts.
- **Where that wording lives:** in the part of the prompt the server builds (with the settings and
  "new since the last pass"), not in the editable prune text under Edit roles… → Passes. A host's
  own prune text keeps working unchanged. The built-in default prune text stays as it is.
- **What the chat shows:** the pass's summary as today, then one size line per pruned section, e.g.
  "Brainstorm: 84,000 → 61,000 characters." A whole-board pass (the host said Yes in the popup)
  shows one line per section. These replace today's single "Board size" line.
- **No note when nothing is due.** A round where no section is over its limit says nothing in the
  chat, as today when the board is under 45,000.
- **`/prune` when some section is over:** no popup; the pass works on the sections that are over.
  Sizes are taken when the pass starts, not when `/prune` is typed (in a run, the pass waits for the
  end of the round).
- **`/prune <text>`** passes its text as guidance, as today, with or without the popup.
- **Unchanged:** when automatic passes run (between rounds, in a run), who runs them (Claude
  through the `claude` command), the version saved first, one-undo, the law the server enforces,
  Settings → Pruning (mechanics limit, aggressiveness), "new since the last pass", Stop, and the
  read-only rules for everyone else during a pass.
- **The limit and the regrow are fixed in code**, as the threshold is today; not in Settings.

## Goals

- A section under its limit is never pruned automatically.
- A pass works on the section that is over, and cleans up the cut ideas' pieces elsewhere.
- `/prune` still prunes on demand, after a confirmation when nothing needs it.

## Non-goals

- Changing what is protected during a prune (the law).
- Changing what OpenRouter cards get pasted into their first turn (still the whole board). Fewer
  prunes mean that paste grows and card turns cost more; that is a separate piece of work.
- Pruning the chat or the ruled-out list.
- Making the limits editable.

## Anti-goals (a failure even if it technically works)

- A pass rewrites a section that was under its limit, beyond removing the pieces of an idea it cut.
- Automatic passes run every round because a pass only trims a little.
- `/prune` silently does nothing.
- The popup appears for an automatic pass, or anywhere other than the host's own `/prune`.

## Left to the builder

- How the page learns that no section is over (the server refusing with a "needs confirmation"
  answer that the page turns into the popup and resends confirmed, or the page asking first), as
  long as the decision uses the server's sizes.
- Whether "nothing needs pruning" for the popup is judged when `/prune` is typed or re-checked when
  the pass starts (a run may grow a section in between); either is fine, but a confirmed `/prune`
  must run.
- The exact prompt wording that names the sections, and the README update (the `/prune` row and
  the Pruning paragraph).
- Tests: the still-over warning after a pass, and none when the section ended under; sizes per section; a round with one section over prunes only that one and names it; the
  regrow rule per section; two sections over → one pass naming both; no section over → no pass and
  no note; `/prune` with nothing over → confirmation, then a whole-board pass; `/prune` with a
  section over → no confirmation; the chat's size lines.
