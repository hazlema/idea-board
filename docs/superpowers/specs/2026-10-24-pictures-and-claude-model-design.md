# Pictures for agents, and choosing Claude's model

Date: 2026-10-24
Status: agreed in conversation (follows the connections work, `2026-10-24-connections-design.md`)

## Intent

The user wants a **Concept Art** role whose agent can make pictures on the
board. Only that role should be able to, since every agent making pictures
would be chaos. Agents should also be able to look at the pictures on the
board, which OpenRouter agents can't do today. Separately, the direct Claude
runs on the CLI's default model (Sonnet), and the user wants to change it from
the sidebar.

## Behaviour

### 1. Agents can see pictures
- When an OpenRouter card calls `view_picture` and its model accepts images
  (OpenRouter lists this), the image is passed to the model.
- A text-only model gets the note `This model can't see images.` instead of
  an empty result.
- Claude already sees pictures; that is unchanged.

### 2. A picture permission on roles, and `generate_image`
- Each role in the library has a **Can make pictures** checkbox in the role
  editor (saved in the library as `pictures: true`). It is off for the four
  starting roles. The user will add "Concept Art" and tick it.
- **`generate_image(prompt, caption, near?)`** is a new board tool. It asks the
  image model for one picture and adds it to the Brainstorm canvas like any
  picture: authored by the caller, so it shows "<name> added" with Keep and
  Dismiss.
- **Who gets it:** only connections whose role has `pictures: true`. Everyone
  else never sees the tool, and the server refuses it by role anyway. This
  covers OpenRouter cards, Claude via the binary and Claude via MCP. The
  refusal reads: `Only roles that can make pictures can use generate_image.`
- **Limit** *(my call)*: 2 pictures per turn or answer. A third call gets
  `Picture limit reached for this turn (2).`
- **Cost:** counts toward the one budget and shows in Spent. When the budget
  is used up, the tool refuses with `The budget is used up; raise it or press
  Reset to make pictures.` Claude making a picture also spends OpenRouter
  money, because the picture comes from the OpenRouter image model.
- **Image model:** chosen once in the sidebar footer (**Image model**), from
  OpenRouter models that output images. Until one is chosen, the tool says
  `No image model is set; choose one in the sidebar.`

### 3. Choosing Claude's model
- Clicking Claude's name in the sidebar opens a small popup to pick its model:
  **Sonnet** (default), **Opus**, **Haiku**, **Fable**, or **Other…** (type a
  model id). These are the `claude --model` aliases `sonnet`, `opus`, `haiku`
  and `fable`.
- The choice is saved with the board (`lineup.claudeModel`) and used from
  Claude's next reply (the binary is started with `--model <choice>`).
- The card shows it: `1. Claude · Sonnet (via binary)`.
- **With MCP:** an MCP session runs its own model, so the popup notes
  `Set by your session while connected via MCP.`, and the choice only applies
  when the binary is answering.
- **`IDEA_BOARD_MODEL`** *(my call)*: it still works, but only as the starting
  value for a board that has never had a model set.

## Non-goals
- Pictures billed to the Claude plan.
- Editing or varying an existing picture.
- More than one image model.

## Anti-goals
- A role without the permission gets a picture onto the board by any route.
- Picture spend that skips the budget.
- One big picture in an agent's conversation history pushing it over the
  conversation limit (400,000 characters), so its history keeps being wiped.
