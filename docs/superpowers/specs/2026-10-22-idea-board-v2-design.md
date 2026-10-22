# Idea board v2: Brainstorm view, memory, history

Date: 2026-10-22. Status: approved by Frosty 2026-10-22.
Mockup (approved as "exactly right"): `.superpowers/brainstorm/183424-1792711693/content/brainstorm-view-v2.html`.

## Why

Frosty is designing a game (the warlock game) with Claude and can't hold it all
in their head. They think visually: "I can see things better when they are laid
out clearly." v1 (a flowchart board with a brief and a chat) works, but game
design starts as jumbled ideas, not flows: "Wizards" with a list of what wizards
can do, "Trolls" beside it, a scene idea, a concept sketch.

Two problems drive v2:

1. **No place for loose, grouped, multi-line ideas and pictures.** Cards hold a
   one-liner; there's no way to sketch "Wizards: familiars, magic, towers…" or
   drop in a character sketch.
2. **Claude forgets what was rejected.** "We don't want the wizards to do xyz,
   then it's suggested again later." The tool must remember decisions and
   rejections, and keep a history so nothing is lost.

The board is "for your benefit as well as mine": it is also Claude's working
memory for the project, and what Claude will read when the game gets built.

## Goals

- A **Brainstorm** view: a free-form surface where you move and resize things.
- **Memory**: a Ruled-out list Claude checks before suggesting anything.
- **History**: every change recorded; undo; undo a whole Claude reply; named
  saved versions you can preview and restore.
- Claude is a full collaborator: it can do anything Frosty can do (add, edit,
  move, resize, link, delete) on every view. It sees the pictures and knows
  what Frosty is pointing at.
- Export the agreed design to a markdown document for building the game.

Frosty, on approving this design: "will be useful for so many things not just
games. A tool like this other people would probably like to use as well for
their projects." So nothing in the tool is game-specific (examples and
defaults stay neutral), and it should stay easy for someone else to install
and run. Publishing it is a later step, not part of v2.

## Non-goals (for v2)

- Multiple pages inside Brainstorm (the data model allows it; UI comes later).
- Search across views.
- Links between flowchart cards and brainstorm items.
- Multi-user, cloud sync, mobile layout.
- Claude generating images.

## Anti-goals (would make it a failure even if it works)

- Claude changing or deleting something with no visible trace and no way back.
  (Claude may change anything; every change must flash on screen, appear in
  History, and be undoable.)
- A ruled-out idea coming back without Claude saying it was ruled out before.
- Any action that loses work with no way back.
- Becoming slow or heavy: the board should open and respond instantly.

## What Frosty decided

### Three views as tabs: Brief | Brainstorm | Flowchart

- **Brief**: today's brief (free-form text boxes with headings), moved out of the
  side panel into its own full tab.
- **Brainstorm**: new; see below.
- **Flowchart**: today's board, behaviour unchanged.

The chat bar stays along the bottom on every tab. The right-hand side panel
shows **Memory** (Ruled out | History) on Brainstorm; on Flowchart it keeps
today's card-details behaviour.

### Brainstorm view (matches the mockup)

A pannable, zoomable dotted canvas holding objects you drag by their title bar
and resize from the corner. Object kinds:

- **Group**: a coloured box with an editable title ("Wizards") and a list of
  entries. Each entry is a bold label plus multi-line text ("**Familiars:**
  conjured using soul points"). An entry is either a plain bullet or has a
  checkbox. Meaning: **ticked checkbox = agreed**, **unticked checkbox =
  undecided, waiting on a call**, **plain bullet = a note or fact** (neither a
  decision nor a question). Claude treats them the same way. Entries can be added ("+ add item"), edited in
  place, reordered, and moved between groups. Each group keeps its own folded
  "N ruled out" list at the bottom.
- **Note**: a sticky note with free multi-line text.
- **Picture**: an image with an editable caption. Added by pasting an image,
  dropping a file, or pasting an image URL.
- **Topic**: a round hub bubble ("Factions") that groups are linked to, giving
  the mind-map shape.
- **Link**: a curved line between any two objects, with an optional label
  ("rivals") and an optional dashed style for loose associations
  ("concept", "scene").

Boxes grow to fit their content; resizing sets the width, and dragging the
height taller is allowed. Content never hides behind an internal scrollbar.

### Claude is a full collaborator

Frosty: "This is a colab tool, you should be able to do anything I can do
(move things around / add things / delete / edit etc.). We do this now in
chats, this will just make it easier to visualize."

- Through the connector Claude can do everything the UI can, on all three views:
  add, edit, move, resize, recolour, link, tick, rule out, delete, save versions.
- **New things Claude adds on Brainstorm are marked**: dashed orange with
  "Claude added", plus **Keep** and **Dismiss…**. Keep clears the mark. Dismiss
  asks "Why not?" (reason optional) and sends it to Ruled out. Unreviewed marks
  don't block anything; Frosty can ignore them. (The flowchart keeps today's
  behaviour: Claude's cards start as "idea" with an accept checkbox.)
- Edits, moves and deletions by Claude happen directly, with no approval step.
  They flash on screen, are listed in History grouped by Claude's reply, and
  "Undo this reply" reverses them.

### Memory: Ruled out

One list for the whole board, shown in the Memory panel. Each record: what was
ruled out, the reason (Frosty's words), who/when, and where it came from
(group, flowchart card, or chat). "Bring back" removes it from the list and
restores the item where possible.

Things land here when Frosty:

- dismisses something Claude added,
- marks a brainstorm entry ruled out (struck through, folded into its group's
  "ruled out" list),
- rejects a flowchart card (today's Rejected status; prompt for an optional reason),
- or says so in chat ("we don't want wizards doing X"): Claude records it with a tool.

Claude reads this list on every look at the board and is instructed never to
re-propose a ruled-out idea; if a new idea resembles one, it must say so.

### History, undo and saved versions

- **History tab**: every change with who and when, newest first. Claude's
  changes are grouped per reply, each group with **Undo this reply**.
- **Undo / Redo** (buttons and Ctrl+Z / Ctrl+Shift+Z): undoes Frosty's own last
  changes.
- **★ Save version**: names and stores a full copy of the board. Versions appear
  in History with **Preview** and **Restore**. Restoring is itself undoable
  (save the current state as an automatic version first).
- Autosave stays: every change is written immediately; "All changes saved" in the top bar.

### Claude sees pictures

Claude can open a picture as an image through the connector and comment on it.

### Pointing at things

Selecting an object (or entry) shows a "Talking about: Wizards ×" chip in the
chat bar. The next message carries that selection, and Claude is told exactly
what Frosty is pointing at.

### Export to a design doc

One button (and a connector tool) writes a markdown document: the brief, each
group's entries marked agreed / undecided / note (ruled-out entries left out
of the groups), notes, picture captions with file paths,
accepted flowchart cards and connections, and the Ruled-out list with reasons.
Written next to the board file as `<board-name>.design.md`, overwritten on each
export.

### Built with Svelte

Frosty agreed to rebuild the page in Svelte. Follow the conventions recorded in
`~/Dev/bun3/artboard2/AGENTS.md`: Svelte 5 with runes, TypeScript (strict),
Tailwind CSS 4, ESLint.

## Constraints

- Stays a local tool: one Node server on 127.0.0.1, same Host/Origin checks,
  same board file + MCP connector + background `claude -p` (board tools only)
  + `wait_for_chat` long poll as v1.
- The **server keeps zero runtime dependencies**. Svelte/Vite/Tailwind are
  build-time only; the server serves the built files. Starting the tool must
  not require a dev server.
- Existing v1 board files must load (top-level `nodes`/`edges` become the
  flowchart; brief carries over; nothing lost).
- Pictures are files, not inlined in the board JSON.
- The board file stays human-readable JSON.
- Node 18+; Claude Code CLI is already installed (2.1.308).

## Prior art to reuse

`~/Dev/bun3/artboard` (Frosty's Electron reference-image board): port the
remote-image ingest from `src/workspace/manager.ts` (`ingestAssets`,
`downloadRemoteAsset`: 30 MB cap, content-type check, Google Images URL
unwrapping) to the server. Its Fabric.js canvas is not reused; Brainstorm
objects are DOM elements so lists and checkboxes are editable in place.

## Calls I made (Frosty can overrule)

- Plain Vite + Svelte single-page app, not SvelteKit: the existing Node server
  already owns the API, SSE, MCP and agent; SvelteKit would duplicate that.
- Pictures stored in `<board-name>.assets/` beside the board file with
  content-hash filenames. Versions in `<board-name>.versions/`. History in an
  append-only `<board-name>.history.jsonl`, so the board file stays small.
- Assets referenced by any saved version are never deleted.
- Ruled-out reasons are optional (a prompt with a pre-filled suggestion is fine),
  so dismissing is never a chore.
- Undo of a Claude reply skips (and reports) any change whose target was since
  edited or deleted, rather than clobbering newer work.
- **Memory survives a restore.** A saved version stores the content of the three
  views (brief, brainstorm, flowchart). The Ruled-out list, chat, Claude session
  id and history live beside the versions, not inside them, so restoring an old
  version never makes Claude forget a rejection. If restoring brings back an
  item that was ruled out after that version, it comes back marked ruled out.
- **Re-proposal guard on the server, not just in the prompt.** When Claude adds
  something, the server compares it with the Ruled-out list using a simple
  word-overlap check (no packages). On a likely match the tool still succeeds
  but its result tells Claude which ruled-out record it resembles, and Claude
  must say so in its reply. The rule is also in the MCP server instructions and
  tool descriptions, so Frosty's own interactive sessions get it, not only the
  background Claude.

## Left to the builder

- Exact MCP tool names and shapes for the new view (must cover: read everything
  including ruled-out list and history summary; add/edit/move groups, entries,
  notes, topics and links; resize, recolour, tick, delete anything;
  rule out with a reason; view a picture;
  save a version; export the design doc).
- Where Claude's new objects are placed (near what they relate to, without overlap).
- Picture sizing for Claude (downscale to what the API accepts).
- Colours for groups (a small palette Frosty can pick from).
- How the history log is compacted; how much of it Claude reads by default.
- Front-end test approach; server logic keeps the node:test suite.
