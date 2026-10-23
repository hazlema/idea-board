# Agent Colab: several AI models designing on one board

Date: 2026-10-23
Status: design, agreed in conversation; not yet planned

## Intent

The board becomes an idea engine. In the Collaborate tab the user picks a few
OpenRouter models, gives each a role (Creative Director, QA & Playtester,
Foreman, …), presses Start, and posts a kickoff in chat ("This is a colab,
there are 3 agents here, design a game about deadly ninjas who ride horses…").
The agents then take turns working the board, building on and challenging each
other's ideas, while the user watches and can step in through chat.

The user wants to experiment: with which models work well together, with the
wording of roles and shared rules, and (later) with model settings such as
temperature. The UI is for running those experiments quickly, without editing
scripts.

### Evidence from two test runs

A throwaway script (`~/Dev/games/ninjas/colab.mjs`) ran this loop twice on the
same kickoff. It is the reference for the turn loop, prompts and tool calls.
What it showed:

- Turn-taking works: agents answer the previous agent's challenge and extend
  its ideas. Running them in parallel was never tried and is not wanted.
- Without roles, agents drifted into numeric fine-tuning and never removed
  anything. With roles plus the user's "every turn must contribute a creative
  idea" rules, the QA role ruled out 5 ideas with reasons and the Foreman
  scored each round.
- Cost: about $0.23 per round of three mid-tier models ($2/$10 per M tokens);
  turns take 20–110 s. Most turns use 2–5 tool calls (`view_board`, `batch`).
- OpenRouter connections occasionally drop; a turn must retry rather than fail.
- Some models prefix their reply with their own name; the app strips that.

## Goals

1. **Pick agents in the Collaborate tab**: add agents, each with a model (from
   OpenRouter's list) and a role; reorder; remove. The list order is the turn
   order.
2. **Run controls**: rounds (default 5), budget in dollars (default $5), Start,
   Stop. Spend so far is shown live.
3. **Roles and shared rules are editable in the app**, in two layers:
   - a **global library** on the user's machine (role name + job text; shared
     rules text), the same for every board;
   - **board-specific extras**: per role, and for the shared rules, extra
     instructions saved with the board, appended after the global text.
   Edits take effect from the next turn, including during a run.
4. **Who did what is visible**:
   - each agent posts in chat under its own name, "Model · Role", in its own
     colour;
   - everything an agent adds is marked as that agent's ("GPT 6.1 Sol added"
     instead of "Claude added"), and History, Ruled out and "Last edit" show
     the agent's name;
   - whose turn it is shows without reading the chat: the active agent card
     lights up and the chat header says "Round 2 of 5 · Gemini's turn".
5. **Runs survive the browser**: the board server runs the turns, so closing
   or reloading the tab does not stop a run.

## Non-goals (for now)

- Temperature and other per-model parameters. Leave room for them: each agent
  in a run config has a settings object that is passed through to OpenRouter
  but has no UI yet.
- Agents acting in parallel, or reacting to every board event.
- Providers other than OpenRouter.
- Scheduled or unattended runs.
- An automatic independent critique at the end (the user can ask an agent in
  chat, or export the design doc).

## Anti-goals (would make this a failure even if it works)

- **The API key reaches the page or the board file.** It stays on the server
  (environment variable `OPENROUTER_API_KEY` or `~/.config/openrouter/key`).
  The page only learns whether a key is present.
- **A run quietly spends money**: every run has a budget, Stop always works,
  and spend is always visible.
- **Agents destroy each other's or the user's work without a trace**: removals
  go through Rule out with a reason (as today), and every agent change is in
  History and undoable.
- **The existing single-Claude experience gets worse**: with no agents set
  up, the board, the background Claude and MCP sessions behave as today.

## Behaviour

### Setting up

- The Agents panel sits to the right of the chat in the Collaborate tab (see
  the mockup in the conversation: chat on the left, panel on the right). It is
  not shown in the popped-out chat window; that window shows only the run
  status line.
- **+ Add agent** adds a card: model dropdown (searchable; the list comes from
  OpenRouter's public models endpoint, filtered to models that support tool
  calls, cached by the server) and role dropdown (roles from the global
  library). ✕ removes. Cards can be dragged to reorder.
- The agent set (models, roles, order, rounds, budget) is saved with the
  board, so reopening the board shows the same line-up.
- If no OpenRouter key is found, the panel says so and how to add it (the
  file path and a one-line shell command); Start is disabled.
- While a run is active, the line-up, rounds and budget are locked. Roles and
  rules stay editable.

### Running

- **Start** connects the agents: status becomes "Waiting for your first
  message". Nothing is spent until the user posts in chat.
- The user's message starts round 1. Agents take turns in card order; one
  round is one turn each. Each turn, as in the test script:
  - the agent gets a system prompt built from: who it is ("Model · Role"),
    who the others are, its role's job (global + board extra), the shared
    rules (global + board extra), and how to play a turn;
  - a user message with the recent chat (last ~40 messages, the host shown as
    "Host");
  - the board's MCP tools, minus `wait_for_chat`, `reply`, `undo_reply` and
    `restore_version`;
  - a tool-call loop capped at 15 calls; out of calls, it is asked for its
    closing message without tools;
  - its closing text is posted in chat under its name (a leading self-name tag
    stripped).
- Messages the user posts mid-run are seen by the next agent (they are in the
  chat history). They do not interrupt the current turn.
- The run ends after the last round, when the budget is reached (checked
  before each turn), or on **Stop** (ends after the current turn; the button
  shows "Stopping…" until then). A failed turn (after retries) posts
  "(my turn failed: reason)" and the run continues with the next agent.
- After a run ends, Start runs it again with the same line-up; it again waits
  for a user message.
- While a run is active the background Claude does not answer chat. An
  interactive MCP session that is listening (`wait_for_chat`) is left alone;
  using both at once is the user's choice.
- *(Designer's call.)* After Start, the run waits for a **new** user message;
  messages already in chat, answered or not, do not start it. Every agent post
  marks the user's earlier messages as handled, as a Claude reply does today,
  so when a run ends the background Claude does not wake up and answer the
  kickoff and mid-run messages in a batch.
- *(Designer's call.)* A run lives only in the server's memory. If the server
  stops or restarts mid-run, the run is over: on the next start the server
  posts a chat note ("The agent run stopped when the server restarted, after
  round 2; $0.61 spent") and the user presses Start to run again. Nothing
  resumes, and nothing spends money, on its own.

### The role editor

- Opened from "Edit roles…" in the Agents panel; a panel over the tab.
- Left: "Shared rules", then the roles, then "+ New role". Right, for the
  selected item: name (roles only), the global text ("every board", saved to
  the global file), and "Extra for this board" (saved with the board).
- Ships with the four roles from the test runs (Creative Director & Lore, QA &
  Playtester, Foreman, Systems Designer) and the shared rules the user wrote
  (below). These are the defaults written to the global file the first time.
- Deleting a role that an agent card uses: the card shows the role as missing
  and Start is disabled until it is changed.

### Authorship

Today an author is `user` or `claude`, and much code treats `claude` as "an
AI". With agents, every agent is its own author and is shown by name. The
user and the background/interactive Claude stay as they are.

- Agents get stable ids per board (e.g. `agent:<id>`); their display name and
  colour come from the board's agent roster, which keeps removed agents so old
  content still shows the right name.
- *(Designer's call.)* An agent's identity is its **model + role** pair, not
  its card. Changing a card's model or role between runs makes it a different
  agent, so what the old one made keeps the old name. The same model in the
  same role on a later run is the same agent.
- Everything that today means "Claude made this" (the "Claude added" marker
  with Keep/Dismiss, flash on change, History grouping by turn, Ruled out
  "by", export's who-did-it) applies to any AI author, labelled with that
  author's name.
- Each agent turn is one undoable turn in History.

## Default shared rules (the user's wording, from run 2)

> Every turn must contribute at least one meaningful creative idea. This may be
> a new mechanic, character, ability, interaction, or an unexpected combination
> of existing mechanics. The agent may also remove or combine existing elements
> if doing so creates a more interesting gameplay experience.
>
> Numerical tuning and balance corrections may accompany the creative
> contribution, but cannot be its sole purpose.
>
> Prioritize ideas that interact with existing systems over isolated additions.
> Remember the game must be fun, compelling and mildly addictive!

The fixed "how to play a turn" instructions (view the board first, read Ruled
out, rule out instead of delete, 3–6 changes, a 3–5 sentence closing message
with one challenge for the next agent) are part of the app, not the editable
rules. The default role texts are in `~/Dev/games/ninjas/colab.mjs` (`ROLES`).

Note: these defaults are about designing games, because that is what the user
is doing. The shared rules are editable, so other kinds of boards just change
them.

## Constraints

- Server: plain Node, no runtime dependencies (as today). Calls OpenRouter's
  chat completions API with `usage: { include: true }` for cost; retries a
  dropped connection twice (2 s, 8 s).
- The agents use the board through the same tool layer as MCP sessions, so
  they get the same validation, history and undo.
- The global library is a JSON file in the user's config directory
  (`~/.config/idea-board/` on Linux; the platform equivalent on macOS and
  Windows), created with the defaults when first needed.
- Front end: Svelte 5, TypeScript, Tailwind 4, following the existing
  components (the Collaborate tab, Chat, Draft for editable text).

## Left to the builder

- The run status shape on the server and how it reaches the page (the existing
  server-sent events are the natural path).
- Exact board-file fields for the agent roster, run config and board extras,
  and migrating boards that have none.
- Model list caching, search behaviour and how much model info to show (price
  per M tokens is useful).
- Colours for agents.
- How authorship changes are spread through the code (e.g. an `isAi(author)`
  helper replacing `=== 'claude'` checks).
