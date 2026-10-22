# Idea board

A whiteboard for brainstorming with Claude. You and Claude both add ideas as
cards, connect them, and mark them accepted or rejected. Click a card to see
its notes and properties in the side panel. Chat with Claude along the bottom;
Claude reads and edits the board while you watch.

No dependencies: Node 18+ only.

## Start

```bash
cd ~/your-project
node ~/Dev/tools/idea-board/server.mjs            # board saved to ./idea-board.json
node ~/Dev/tools/idea-board/server.mjs plans/game.json --port 4800
```

Open http://127.0.0.1:4777.

## Using the board

There's no save button: every change is written to the board file
immediately. The top bar shows "All changes saved".

- **Brief:** the **Brief** button opens the project description: free-form
  text boxes with headings (what you're building, goals, decisions, open
  questions, anything). Add, reorder or remove boxes as you like. Claude
  reads the brief before every change and records decisions you settle.
- **Add an idea:** double-click the board, or **+ Idea**.
- **Details:** click a card. Edit the title, status, properties (name/value
  pairs) and notes in the right panel. Changes save as you type.
- **Accept:** tick the card's checkbox, or use Idea / Accepted / Rejected in the panel.
- **Connect:** drag the dot on a card's right edge onto another card. Click
  an arrow to label or delete it.
- **Move around:** drag the background to pan, scroll to zoom, **F** or **Fit**
  to see everything, **Tidy** to arrange cards left to right.
- **Delete:** select and press Delete.

Cards Claude added say *Claude* in orange and flash when Claude changes them.

## Claude in the chat

When you send a chat message, the server runs Claude Code in the background
(`claude -p`) with only the board tools: no shell, no file access, no web.
Claude's edits appear live and its answer lands in the chat. Follow-up
messages continue the same conversation (the session id is kept in the board file).

Settings (environment variables):

- `IDEA_BOARD_MODEL`: model for the background Claude (default: your Claude Code default)
- `IDEA_BOARD_CLAUDE`: path to the `claude` binary
- `--no-agent`: never run a background Claude; chat waits for a session (below)

## Claude from your own session (MCP)

Register the board once in the project:

```bash
claude mcp add --transport http idea-board http://127.0.0.1:4777/mcp
```

Then in any Claude Code session in that project, Claude has these tools:
`view_board`, `add_brief_section`, `update_brief_section`,
`delete_brief_section`, `get_node`, `add_node`, `update_node`, `delete_node`, `connect`,
`disconnect`, `tidy_layout`, `reply`, `wait_for_chat`.

**Live mode:** ask Claude to "listen to the board chat". It loops on
`wait_for_chat` (a long poll), so your board messages go straight to that
session instead of a background Claude. If the session stops listening for
five minutes, the background Claude takes over again.

## Safety

The server only listens on 127.0.0.1 and refuses requests from other
websites (Origin check) or other host names (Host check), so a web page you
visit can't post to your board or set off a Claude run.

## Tests

```bash
npm test
```
