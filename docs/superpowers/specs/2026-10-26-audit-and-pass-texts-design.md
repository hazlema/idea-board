# Final audit, /audit, and editable pass texts

## Why

When you finish a change, you check it. The host does that by hand at the end of every agents' run
by typing `/chat 1 Please audit the board and report any problems or inconsistencies`. This makes
that check part of the run, and gives it a command of its own.

The host also wants to tune the instructions behind these passes without a code change. Today the
pruning instructions are a string in `lib/prune.mjs`.

Success means two things. Every run that reaches its last round ends with an audit report in the
chat, which the host reads and acts on (or doesn't). The host can also reword the audit and prune
instructions from the page.

## What it is

### The audit (decided by the host)

- The Foreman reads the board and posts a report of problems and inconsistencies in the chat.
- **It only reports.** Nothing happens after it, and the agents don't act on it. The host reads it
  and decides what, if anything, to do.
- **At the end of a run:** it runs once the last round is over (after that round's prune pass, if
  one is due).
- **`/audit`:** runs the same check at any time. It joins the slash-command hint, the "unknown
  command" help and the README.

### Editable texts (decided by the host)

- The audit instructions and the prune instructions are edited like the roles: in the Roles dialog
  (Edit roles…), in the list on the left, as plain text you edit in place.
- The starting audit text is the host's own wording: "Please audit the board and report any
  problems or inconsistencies."
- The starting prune text is today's `PRUNE_SYSTEM_PROMPT`.

## Our calls (not discussed with the host; listed so they can be checked)

- **Who audits:** the connection whose role is the Foreman (role id `foreman`), Claude's or a card's.
  If nobody holds it, or the one who does can't answer right now, connection 1 (Claude) audits. If
  that isn't possible either, `/audit` is refused with a reason, and the run-end audit is skipped
  with a one-line note.
- **Read-only, enforced by the server:** during an audit turn, the auditor's board tools that
  change anything are refused (or not offered), the same idea as the read-only rule for everyone
  else during a prune pass. It may still read: view_board, get_history, read_note and similar, and
  for Claude its read-only file tools. A report that "fixes" things the host hasn't agreed to would
  be a failure.
- **Stop:** a run stopped with Stop or `/stop`, or ended early (budget, OpenRouter refused the
  key), gets no audit. Only a run that reaches the end of its last round is audited. Stop during an
  audit cuts it short, like any turn.
- **`/audit` during a run** is refused with "The run ends with an audit." `/audit` during a prune
  pass waits for the pass, as answers do.
- **`/audit <text>`** passes the extra text to the auditor as the host's focus for this audit, like
  `/prune <text>`.
- **What the chat shows:** the host's line reads "Audit the board." (or "Audit the board: <text>"),
  posted as the host for `/audit` and as a note for the run-end audit. The auditor's reply is posted
  under its name, as answers are. The audit text itself is not shown in the chat.
- **A switch:** Settings → a checkbox "Audit at the end of a run", on by default, saved with the
  board. `/audit` works either way.
- **Where the texts live:** in the role library file, `~/.config/idea-board/colab.json`, alongside
  the shared rules and roles, so every board shares them. They are not separate `.md` files.
- **List placement:** after the roles, under a small "Passes" heading: "Final audit" and "Prune".
  They can't be renamed or deleted. Each has "Reset to default".
- **Stored only when changed:** a text the host never edited is not written to the file, so later
  improvements to the built-in default still reach them. Reset clears the stored text.
- **What stays in code** (and so can't be broken by an edit): the board data, the pass settings
  (mechanics limit, aggressiveness, what's new since the last pass) and the host's guidance are
  still added to the prompt by the server. For prune, the law is still enforced by the server
  whatever the text says. The read-only rule for the audit is enforced the same way.
- **The audit text replaces the role and rules, as the prune text does.** The audit runs as its own
  fresh session, not inside the auditor's ongoing conversation. Its instructions are the audit text
  plus a short framing from the server: you can only read, and your reply is the report. The
  Foreman's job and the shared rules are left out, because they push the other way: "contribute at
  least one creative idea", "merge duplicates", "end with a score". That would turn the report into
  more design work. The default audit text therefore starts from the host's wording and is filled
  out a little: report problems and inconsistencies (contradictions, duplicates, gaps, stale
  items, the Brief out of step with the board), one line each, saying where on the board each one
  is, and change nothing.
- **No "Extra for this board" field** on the two pass panes. They are shared texts only, and the
  pane says so in a line. Per-board focus is what `/audit <text>` and `/prune <text>` are for.
- **Length limit:** the same as a role's text (20,000 characters). An empty text means "use the
  default".

## Goals

- Every completed run ends with an audit report in the chat, with no typing.
- `/audit` gives the same report on demand.
- The host can reword both passes from the page and get the defaults back.

## Non-goals

- Acting on the audit: no automatic fixes, no follow-up round, no checklist on the board.
- A file-based template folder or `.md` files on disk.
- Changing what the law guard allows during a prune.
- Making the other passes' wiring editable (the prompt framing, settings lines, tool lists).

## Anti-goals (a failure even if it technically works)

- The audit changes the board.
- An audit fires after the host pressed Stop.
- A bad edit to the prune text lets a prune break the law.
- Editing a text in one place leaves the old wording in use somewhere else.

## Left to the builder

- How the auditor's fresh session is driven, as
  long as it shows up as that agent at work and its reply lands in the chat.
- How read-only is enforced for each kind of connection: the binary, an attached MCP session, and an
  OpenRouter card.
- How the audit prompt is framed around the host's text (board size limits apply: give a binary
  auditor the board through its tools, as in a normal turn, not inline).
- Tests: run end with and without Stop, `/audit` routing and refusals, read-only refusals, the
  library's defaults and reset, the prune prompt using the stored text.
