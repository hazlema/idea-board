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

Options: `--port <n>`, `--no-open` (don't open a browser), `--help`. The default port can also be set with `IDEA_BOARD_PORT`.

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

#### Connections

The chat is one room. Everyone connected is listed in the **Connections**
sidebar, each with a number, a role and what it is doing right now (Waiting,
Thinking…, or the tool it is using). You talk to all of them in the chat.

- **Direct connection:** Claude is always connection 1 and can't be removed or
  moved. The label says how it is connected: **via binary** (the `claude`
  command, found at startup or at `IDEA_BOARD_CLAUDE`), **via MCP** (a Claude
  Code session that is listening, see below) or **not connected**. Claude has a
  role picker like the others. The name reads **1. Claude · Sonnet**; click it
  to pick the model: Sonnet, Opus, Haiku, Fable, or **Other…** with a full model
  id such as `claude-opus-5-5`. It can't change during a run. While Claude is
  connected via MCP, your own session decides which model answers.
- **OpenRouter connections:** connections 2, 3 and so on. **+ Add connection**
  adds a card. Pick the model from a searchable list (only models that support
  tools, with the price per million tokens) and a role. Drag the grip to
  reorder (the order is the turn order); **✕** removes a card. Numbers are the
  positions in the sidebar when you send a message.
- The sidebar footer holds **Rounds**, **Budget ($)**, **Turn timeout (min)**,
  **Spent $0.42 of $5** with **Reset**, and **Edit roles…**.
- The card whose turn it is lights up, and during a run the chat header reads
  "Round 2 of 5 · <model>'s turn" with a **Stop** button.

What you type decides who answers:

| You type | What happens |
|---|---|
| `What do you think of this?` | Everyone connected answers once, at the same time, in their own role. They don't read each other's answers to it. |
| `/chat 2 What do you think?` (or `/c 2 …`) | Only connection 2 answers. The others see the message later but don't reply. |
| `/start ok, let's build out the classes` | Starts a run: everyone takes turns in sidebar order, reading each other's work and building on the board, until the rounds are used up, the budget is reached or you stop it. The text is the kickoff. |
| `/stop` | Ends the run after the current turn (same as **Stop**). |
| `/prune` (or `/prune <what to focus on>`) | Claude tidies the board: merges duplicates, deletes what is settled elsewhere and shortens wording and cuts weak mechanics, plain bullets included, without touching accepted cards, struck-through entries, pictures, the ruled-out list or the chat. The Brief, the Brainstorm and the Flowchart are measured separately: it works on the ones over 80,000 characters, and removes the pieces elsewhere of the ideas it cuts there. When none is over, it asks before pruning the whole board. A version is saved first, and the pass is one undo (History → Undo this reply). It also runs on its own between rounds for any section over 80,000 characters (once pruned, a section waits until it has grown 10,000 past what the pass left). Needs the `claude` command. |
| `/audit` (or `/audit <what to check>`) | The Foreman reads the whole board and posts a short report in the chat of any problems or inconsistencies, one line each. Read-only: it changes nothing on the board. Refused while a run is going (the run ends with an audit). Stop it with `/stop`. |
| `//hello` | Sends `/hello` as plain text. |

**Final audit.** At the end of a run the Foreman audits the board once (switch it off under **⋯ → Settings → Audit at the end of a run**), and `/audit` does the same on demand. Claude audits when its role is the Foreman; otherwise the first card with the Foreman role that can answer does; otherwise Claude through the `claude` command. If none of those is available, `/audit` is refused. The audit is read-only (the server enforces it), runs in a fresh session and posts its report in the chat. Its instructions are the "Final audit" text under **Edit roles… → Passes**, where the Prune text is also editable.

Pruning is tuned under **⋯ → Settings → Pruning**: a mechanics limit (blank means no limit) and how aggressive the pass is (Gentle, Normal or Aggressive). New ideas get one pass before they can be cut, and cut mechanics go on the ruled-out list with a reason starting "cut by prune:". A pass's chat note gives each section's size before and after; if a section is still over its limit, it says so: raise Aggressiveness and run `/prune` again.

During a run, anything you type steers it: each connection sees it on its
next turn, and it doesn't start a round of plain answers. `/chat N` during a
run doesn't interrupt; connection N gets it on its next turn. If nobody is
connected, your message is still posted with a note saying so.

A command that can't work is not sent: an unknown command, `/chat` with a
number that has no connection (or Claude when it is not connected, or a card
that is over budget), `/chat` or `/start` with no text, `/start` while a run
is going, `/stop` with no run. Your text stays in the box with the reason.
While the box starts with `/`, a line under it lists the commands. **Shift+↑**
brings back what you sent before, as you typed it (commands included);
**Shift+↓** goes forward again. Plain arrows just move the cursor. The last
50 are kept in this browser.

Everyone, Claude included, changes the board the same way and takes part in
`/start` runs. Each OpenRouter connection posts in the chat as "Model · Role".
What it adds is marked "<name> added" with **Keep** and **Dismiss**, and
History and Ruled out show its name. Each answer is one undoable turn.

**Edit roles…** opens the role editor. It starts with four roles (Creative
Director & Lore, QA & Playtester, Foreman, Systems Designer) and the shared
rules every connection follows. Each has text for every board (saved in
`~/.config/idea-board/colab.json` on Linux, the platform's config folder
elsewhere) and **Extra for this board** (saved in the board file). Edits
apply from the next answer.

**Pictures.** A role has a **Can make pictures** checkbox in the role editor
(for example a "Concept Art" role). Connections with such a role get a
`generate_image` tool that draws with the **Image model** set in **⋯ →
Settings…** (a new board uses `openai/gpt-5.4-image-2`; routers such as
`openrouter/auto` aren't offered). If the image service refuses, the error
says which provider and what it said. The picture lands on the Brainstorm canvas marked "<name> added"
(Keep / Dismiss). It is limited to 2 pictures per turn, and each one is paid
from the run's budget. OpenRouter agents whose model can
see images look at the board's pictures too. If Claude's role gains Can make
pictures while an MCP session is connected, reconnect it (/mcp) to see the new
tool; the permission itself applies at once.

**The key.** OpenRouter connections need an OpenRouter key, from `OPENROUTER_API_KEY` or the
file `~/.config/openrouter/key`. It stays on the server and is never sent to
the page. If it is missing, the panel shows the exact command that saves it:

```bash
mkdir -p ~/.config/openrouter && read -rs -p "OpenRouter key: " k && printf '%s' "$k" > ~/.config/openrouter/key && chmod 600 ~/.config/openrouter/key; unset k; echo
```

**Cost.** Every OpenRouter call costs money. One budget covers plain
answers, `/chat` answers and `/start` runs. **Spent** counts them all, is saved
with the board and survives a restart; **Reset** (after a confirm) puts it back
to $0. When Spent reaches the budget the OpenRouter cards stop answering, a
note in the chat says so once, and a `/start` run ends. Raise the budget and
they answer again. Claude keeps answering, because it uses your Claude plan,
which this budget doesn't count. The **turn timeout** applies to every
OpenRouter answer: when it runs out, the connection is asked to wrap up. If the
server restarts mid-run, the run ends and a note in the chat says how far it
got; send `/start` again.

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
entries left out); notes; pictures, each with its caption and who made it,
embedded as an image from `<board>.assets/` so a Markdown viewer shows the
reference art inline; links; accepted flowchart cards and the connections
between them; and the Ruled out list with reasons. Anything Claude added that
you have not kept yet is tagged _(Claude added, not reviewed)_. To hand the
design to someone, send the `.design.md` together with the `.assets` folder.

## Claude in the chat

Claude is connection 1. By default the server answers your chat messages by
running Claude Code in the background (`claude -p`) with the board tools plus
read-only file tools (Read, Glob, Grep) limited to the board's folder, so it can
look at the project being built there. It can't edit files, and it has no shell
and no web. `~/.config/openrouter` is denied outright. A `/prune` pass gets no
file tools. Claude can look at the pictures on the board.
Its edits appear live and its answer lands in the chat. Follow-up messages
continue the same conversation (the session id is kept in the board file).
These runs use your Claude plan.

If the server can't find `claude` (or the path in `IDEA_BOARD_CLAUDE`), it
prints a warning at startup, and the sidebar shows **not connected** with the
command to connect a session of your own (next section). Plain messages still
go to your OpenRouter connections.

Settings (environment variables and flags):

- `IDEA_BOARD_MODEL`: the starting Claude model of a new board (default: your Claude Code default); after that, pick it on Claude's card
- `IDEA_BOARD_CLAUDE`: path to the `claude` binary
- `IDEA_BOARD_PORT`: default port (otherwise 4777)

## Claude from your own session (MCP)

Register the board once in the project:

```bash
claude mcp add --transport http idea-board http://127.0.0.1:4777/mcp
```

Then in any Claude Code session in that project, Claude has these tools:

| Area | Tools |
|---|---|
| Read | `view_brief` (start here; lists ruled-out items first), `view_brainstorm`, `view_flow`, `view_chat` (pages back through the chat; can pick one author), `view_picture`, `get_node`, `get_history`, `list_versions`; `view_board` (deprecated: the whole board in one go) |
| Brief | `add_brief_section`, `update_brief_section`, `move_brief_section`, `delete_brief_section` |
| Brainstorm | `add_group`, `update_group`, `add_entry`, `update_entry`, `move_entry`, `delete_entry`, `add_note`, `update_note`, `add_topic`, `update_topic`, `add_picture_from_url`, `update_picture`, `move_object` (move or resize), `delete_object`, `link`, `update_link`, `unlink` |
| Flowchart | `add_node`, `update_node`, `delete_node`, `connect`, `update_connection`, `disconnect`, `tidy_layout` |
| Memory | `rule_out`, `bring_back`, `undo_reply`, `save_version`, `restore_version` |
| Other | `rename_board`, `export_design_doc`, `reply`, `wait_for_chat`, `batch` (several tools in one call; `"$0.id"` reuses an id an earlier call returned) |

**Live mode:** ask Claude to "listen to the board chat". It loops on
`wait_for_chat` (a long poll), so your board messages go straight to that
session instead of the background Claude (the sidebar then says **via MCP**). Each wait also lists what you
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
IDEA_BOARD_CLAUDE=/nonexistent node server.mjs --no-open   # the board server on 4777, no background Claude
npm run dev                            # Vite dev server with hot reload; proxies /api, /assets and /mcp to 4777
```

Open the URL Vite prints. Pointing `IDEA_BOARD_CLAUDE` at a missing file keeps
the background Claude off while you work on the page; leave it out when you
want to test the chat. The front end is Svelte 5 (runes), TypeScript and
Tailwind 4 under `web/`; the server is plain JavaScript with no runtime
dependencies (`lib/` and `server.mjs`).

```bash
npm test          # server tests (node:test) and web tests (vitest)
npm run check     # svelte-check / TypeScript
npm run lint      # ESLint
npm run build     # production build into dist/
```
