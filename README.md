# Idea board

A shared whiteboard for thinking a project through with Claude. You write the
brief, sketch ideas on a free-form canvas, draw flows, and chat. Claude reads
and edits the same board while you watch, and it remembers what you ruled out
so it doesn't suggest the same thing twice.

It is a local tool: one small Node server, one JSON file per board. Use it for
a game, an app, a story, a renovation, a talk, anything you want to lay out
and decide.

- **Brief:** a free-form description of what you are doing.
- **Brainstorm:** a canvas of groups, notes, pictures, topics and links.
- **Flowchart:** cards and arrows for steps, systems or options.
- **Memory:** a Ruled out list Claude checks before it suggests anything, and a
  History of every change with undo and saved versions.
- **Chat:** Claude is a full collaborator. It can add, edit, move, link, tick,
  rule out and delete on every tab. Every change flashes on screen, shows in
  History and can be undone.

## Install and start

The server runs on Node 18+ and has no runtime dependencies. Building the page
(Vite and Svelte, done once) needs Node 20.19+, and running the tests needs
Node 22.12+. For the chat you also need the
[Claude Code](https://claude.com/claude-code) CLI (`claude`) signed in.

```bash
git clone <this repo> ~/idea-board    # or wherever you keep tools
cd ~/idea-board
npm install
npm run build                          # builds the page into dist/
```

Then run it from the project you are working on:

```bash
cd ~/your-project
node ~/idea-board/server.mjs                         # board saved to ./idea-board.json
node ~/idea-board/server.mjs plans/game.json --port 4800
```

The board opens in your browser at http://127.0.0.1:4777 (or your `--port`).
If `dist/` is missing the server tells you to run `npm run build`.

Options: `--port <n>`, `--no-agent` (never run a background Claude; see below),
`--no-open` (don't open a browser), `--help`. The default port can also be set with `IDEA_BOARD_PORT`.

Files next to the board (for `plans/game.json`):

| File | What it holds |
|---|---|
| `plans/game.json` | The board: brief, brainstorm, flowchart, ruled out, chat |
| `plans/game.assets/` | Pictures you added (never deleted) |
| `plans/game.versions/` | Saved versions |
| `plans/game.history.jsonl` | Change history |
| `plans/game.design.md` | The exported design doc (overwritten on each export) |

The board file is readable JSON. Boards from the first version of the tool
(top-level `nodes` and `edges`) open as they are: the nodes become the
Flowchart and the brief carries over.

## Using the board

There is no save button: every change is written to the board file at once.
The top bar shows "All changes saved". If a save fails (the server stopped,
say), what you typed stays on screen, the top bar says "Not saved", and it is
tried again every few seconds until it goes through.

Tabs along the top: **Brief**, **Brainstorm**, **Flowchart**, **Collaborate**.
The side panel shows **Memory** (tabs **Ruled out** and **History**); on
Flowchart, selecting a card shows its details there instead.

### Collaborate

The chat with Claude, on a page of its own. The slider in its header sets the
chat's text size. **⧉ Pop out** floats the chat over the other tabs, so you can
watch the board change while you talk: drag it by its title bar, resize it from
the corner, and close it with **✕** to put it back in the tab. The text size and
where you left the window are remembered in this browser.

#### Agents

Besides Claude, you can have other models talk about the board with you and
with each other. Pick OpenRouter models in the **Agents** panel, give each a
role, press **Start**, then post your first message. The agents take turns,
one turn each per round, and change the board the same way Claude does.

- **+ Add agent** adds a card. Pick the model from a searchable list (only
  models that support tools, with the price per million tokens) and a role.
  Drag the grip to reorder (the order is the turn order); **✕** removes a card.
- Set the number of **rounds** and a **budget** in dollars. **Start** begins a
  run; **Stop** ends it after the current turn.
- The card whose turn it is lights up, and the chat header reads "Round 2 of
  5 · <model>'s turn". Spend shows as "$0.42 of $5".
- **Edit roles…** opens the role editor. It starts with four roles (Creative
  Director & Lore, QA & Playtester, Foreman, Systems Designer) and the shared
  rules every agent follows. Each has text for every board (saved in
  `~/.config/idea-board/colab.json` on Linux, the platform's config folder
  elsewhere) and **Extra for this board** (saved in the board file). Edits
  apply from the next turn.

Each agent posts in the chat as "Model · Role". What it adds is marked
"<name> added" with **Keep** and **Dismiss**, and History and Ruled out show
its name. Each agent turn is one undoable turn.

**The key.** Agents need an OpenRouter key, from `OPENROUTER_API_KEY` or the
file `~/.config/openrouter/key`. It stays on the server and is never sent to
the page. If it is missing, the panel shows the exact command that saves it:

```bash
mkdir -p ~/.config/openrouter && read -rs -p "OpenRouter key: " k && printf '%s' "$k" > ~/.config/openrouter/key && chmod 600 ~/.config/openrouter/key; unset k; echo
```

**Cost.** Every model call costs money. A run stops when it reaches its
budget, which is checked before each turn. The background Claude doesn't
answer chat messages while a run is going. If the server restarts mid-run,
the run ends and a note in the chat says how far it got; press **Start**
again.

### Brief

Free-form text boxes with headings: what you are building, goals, decisions,
open questions, anything. Add, reorder or remove boxes. Claude reads the brief
before every change and records decisions you settle.

### Brainstorm

A pannable, zoomable dotted canvas. Add things from the palette on the left:

- **Group:** a titled box of entries. Each entry has a bold label and
  multi-line text. A plain bullet is a note or fact; add a checkbox from the
  entry menu to make it a decision: **ticked = agreed**, **unticked =
  undecided**. Click **+ add item** to add entries (type `:` or press Enter after the label
  to move on to its text); drag the handle to
  reorder them or move them to another group.
- **Note:** a sticky note with free text.
- **Topic:** a round hub bubble that groups and notes can be linked to.
- **Picture:** paste an image (Ctrl+V), drop a file, paste an image URL, or use
  the Picture button. Add a caption. png, jpeg, gif and webp, up to 30 MB.
- **Link:** a line between two objects, with an optional label and an optional
  dashed style.

Drag an object by its title bar, resize from the corner, drag the background
to pan, scroll to zoom. Boxes grow to fit their content. Select an object or
entry and the chat shows **Talking about: &lt;name&gt; ×**: your next message
tells Claude exactly what you are pointing at.

Things Claude adds here are dashed and marked **Claude added**, with **Keep**
(accept it) and **Dismiss…** (asks **Why not?**, then sends it to Ruled out).
You can also ignore the mark; nothing is blocked on it.

### Flowchart

Cards and arrows.

- **Add a card:** double-click the canvas, or **+ Idea**.
- **Details:** click a card to edit its title, status, properties and notes in
  the side panel.
- **Accept or reject:** tick the card's checkbox, or use Idea / Accepted /
  Rejected in the panel. Rejecting asks for an optional reason and adds the
  card to Ruled out.
- **Connect:** drag the dot on a card's right edge onto another card. Click an
  arrow to label or delete it.
- **Move around:** drag the background to pan, scroll to zoom, **F** or **Fit**
  to see everything, **Tidy** to arrange cards left to right.
- **Delete:** select and press Delete.

### Memory: ruled out and history

**Ruled out** is one list for the whole board. Things land there when you
dismiss something Claude added, rule out a brainstorm entry (it is struck
through and folded into its group's "N ruled out" list), reject a flowchart
card, or tell Claude in chat "we don't want X". Each record keeps what, why,
who and where it came from. **Bring back** restores it.

Claude reads this list every time it looks at the board and must not
re-propose anything on it. The server also checks what Claude adds against the
list, and if something looks like a ruled-out idea Claude is told which one
and must say so in its reply.

**History** lists every change, newest first, with who made it. Claude's
changes are grouped per reply, and each group has **Undo this reply**. A
change whose target you edited afterwards is skipped, not overwritten.
**Undo** and **Redo** in the top bar (Ctrl+Z, Ctrl+Shift+Z) step back through
your own changes.

### Saved versions

**★ Save version** names and stores a full copy of the Brief, Brainstorm and
Flowchart. Versions appear in History with **Preview** and **Restore**.
Restoring saves the current state first, so it can be undone. The Ruled out
list, chat and history are not part of a version, so restoring never makes
Claude forget a rejection.

### Export

The **⋯** menu has **Export design doc**: it writes `<board>.design.md` next
to the board as Markdown: the brief; each group's entries as bullets, `[x]`
for agreed, `[ ]` for undecided and a plain bullet for a note (ruled-out
entries left out); notes; picture captions with file paths; links; accepted
flowchart cards and the connections between them; and the Ruled out list with
reasons. Anything Claude added that you have not kept yet is tagged
_(Claude added, not reviewed)_.

## Claude in the chat

When you send a chat message, the server runs Claude Code in the background
(`claude -p`) with only the board tools: no shell, no file access, no web.
Claude can look at the pictures on the board. Its edits appear live and its
answer lands in the chat. Follow-up messages continue the same conversation
(the session id is kept in the board file). These runs use your Claude plan.

Settings (environment variables and flags):

- `IDEA_BOARD_MODEL`: model for the background Claude (default: your Claude Code default)
- `IDEA_BOARD_CLAUDE`: path to the `claude` binary
- `IDEA_BOARD_PORT`: default port (otherwise 4777)
- `--no-agent`: never run a background Claude; chat waits for a session (below)

## Claude from your own session (MCP)

Register the board once in the project:

```bash
claude mcp add --transport http idea-board http://127.0.0.1:4777/mcp
```

Then in any Claude Code session in that project, Claude has these tools:

| Area | Tools |
|---|---|
| Read | `view_board` (start here; lists ruled-out items first), `view_picture`, `get_node`, `get_history`, `list_versions` |
| Brief | `add_brief_section`, `update_brief_section`, `move_brief_section`, `delete_brief_section` |
| Brainstorm | `add_group`, `update_group`, `add_entry`, `update_entry`, `move_entry`, `delete_entry`, `add_note`, `update_note`, `add_topic`, `update_topic`, `add_picture_from_url`, `update_picture`, `move_object` (move or resize), `delete_object`, `link`, `update_link`, `unlink` |
| Flowchart | `add_node`, `update_node`, `delete_node`, `connect`, `update_connection`, `disconnect`, `tidy_layout` |
| Memory | `rule_out`, `bring_back`, `undo_reply`, `save_version`, `restore_version` |
| Other | `rename_board`, `export_design_doc`, `reply`, `wait_for_chat`, `batch` (several tools in one call; `"$0.id"` reuses an id an earlier call returned) |

**Live mode:** ask Claude to "listen to the board chat". It loops on
`wait_for_chat` (a long poll), so your board messages go straight to that
session instead of a background Claude. Each wait also lists what you
changed on the board since Claude last looked, so it can react to edits you
didn't mention in chat. If the session stops listening for five minutes, the
background Claude takes over again.

## Safety

The server only listens on 127.0.0.1 and refuses requests from other
websites (Origin check) or other host names (Host check), so a web page you
visit can't post to your board or set off a Claude run.

## Development

```bash
npm install
node server.mjs --no-agent --no-open   # the board server on 4777
npm run dev                            # Vite dev server with hot reload; proxies /api, /assets and /mcp to 4777
```

Open the URL Vite prints. `--no-agent` keeps the background Claude off while
you work on the page; leave it out when you want to test the chat. The front end is Svelte 5 (runes), TypeScript and
Tailwind 4 under `web/`; the server is plain JavaScript with no runtime
dependencies (`lib/` and `server.mjs`).

```bash
npm test          # server tests (node:test) and web tests (vitest)
npm run check     # svelte-check / TypeScript
npm run lint      # ESLint
npm run build     # production build into dist/
```
