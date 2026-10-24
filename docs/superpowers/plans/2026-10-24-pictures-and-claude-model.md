# Pictures and Claude's Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** OpenRouter agents can see board pictures. Roles marked "Can make pictures" get a `generate_image` tool backed by an OpenRouter image model, which counts toward the budget and is capped at 2 per turn. Claude's model can be chosen from the sidebar.

**Architecture:**
- `lib/colab/openrouter.mjs` learns model capabilities (vision, image output) and gains an `image()` call.
- A new `lib/colab/pictures.mjs` (`PictureMaker`) owns the permission check, the limit, the budget and the generation. The tool runner calls it for `generate_image`, and every connection path hides the tool from roles without the permission.
- `run.mjs` passes `view_picture` images to models that accept them, then strips them from the stored conversation after the turn.
- The page gets a role checkbox, an image-model picker and a Claude model popup.

**Tech Stack:** Node 18+ ESM (`node --test`, no runtime dependencies); Svelte 5 + Vite (`vitest`).

**Spec:** `docs/superpowers/specs/2026-10-24-pictures-and-claude-model-design.md`

## Global Constraints

- Node 18+ on the server, with no runtime dependencies. The OpenRouter key never reaches the page or the board file.
- Exact copy is fixed by the spec: `Only roles that can make pictures can use generate_image.`, `Picture limit reached for this turn (2).`, `The budget is used up; raise it or press Reset to make pictures.`, `No image model is set; choose one in the sidebar.`, `This model can't see images.`, `Set by your session while connected via MCP.`
- The limit is `PICTURES_PER_TURN = 2`, counted per author per undo turn (`store.turnOf(author)`, which renews after that author's chat post).
- Picture cost goes through `store.addColabSpend(cost)`. The budget check is `board.colab.spent >= lineup.budget`.
- Claude model aliases: `sonnet` (default), `opus`, `haiku`, `fable`. Any other value is a free-text model id of 200 characters at most.
- Old boards and libraries load: a missing `pictures` reads as false, a missing `imageModel` as `''`, and a missing `claudeModel` as `process.env.IDEA_BOARD_MODEL || 'sonnet'` (applied once by `Room.recover()`).
- `npm test`, `npm run check` and `npm run lint` pass at the end of every task.

## Review Focus

1. **A non-picture role calls `generate_image` anyway**, for example a model that invents the tool name, or a session that saw the tool before its role was changed. The server refuses with the role copy and adds no picture. *(Task 3 test.)*
2. **The image model returns text and no image**, or returns a URL instead of a data URL. The tool fails with `The image model returned no picture.`, any cost is still counted, and nothing is added. *(Task 2 and Task 3 tests.)*
3. **A conversation grows past 400,000 characters because of a picture.** After a turn that viewed a picture, the stored conversation holds `[picture <id> shown]` instead of the base64, so the next turn is not reset. *(Task 4 test.)*
4. **The role changes during a session.** Moving Claude's role off Concept Art hides the tool on the next binary run and the next MCP `tools/list`, and calls are refused right away. *(Task 3 test.)*
5. **A picture is generated while the budget is exactly used up**, or is crossed by a parallel answer. The tool refuses before calling OpenRouter. *(Task 3 test.)*

---

### Task 1: Data — the role permission, image model and Claude's model

**Files:**
- Modify: `lib/colab/library.mjs`, `lib/board.mjs`, `lib/room.mjs`
- Test: `test/colab-library.test.mjs`, `test/board.test.mjs`, `test/room.test.mjs`

**Interfaces:**
- Produces:
  - Library roles are `{ id, name, job, pictures?: boolean }`. `validate` accepts an optional boolean `pictures` and drops it when false, so stored roles stay small. Anything else throws `role <id>: pictures must be true or false`.
  - `setColabLineup` takes an optional `imageModel` (string, 200 characters at most, trimmed) and an optional `claudeModel` (non-empty string, 200 characters at most, trimmed). When either is absent, the stored value is kept. `emptyColab().lineup` adds `imageModel: ''` and `claudeModel: 'sonnet'`.
  - `migrateBoard` keeps an existing `claudeModel` and leaves it `undefined` when absent, so `Room.recover()` can apply the env default. A missing `imageModel` becomes `''`.
  - `Room.recover()`: if `lineup.claudeModel` is missing, applies `setColabLineup` with `claudeModel: process.env.IDEA_BOARD_MODEL || 'sonnet'` (a system op with no history).
- [ ] **Step 1: Failing tests**
  - `colab-library` "a role can carry the picture permission": save roles where one has `pictures: true` and one has `pictures: false`. `get()` gives the first `pictures: true` and the second no `pictures` key. `pictures: 'yes'` throws `/pictures must be true or false/`.
  - `board` "lineup keeps image and Claude models": a `setColabLineup` with `imageModel: ' google/x-image '` and `claudeModel: 'opus'` stores `'google/x-image'` and `'opus'`. A later `setColabLineup` without them keeps both. `claudeModel: ''` throws.
  - `room` "recover sets Claude's model from IDEA_BOARD_MODEL once": with `delete lineup.claudeModel` and `process.env.IDEA_BOARD_MODEL = 'haiku'`, `recover()` gives `'haiku'`. Restore the env afterwards. With the env unset it gives `'sonnet'`. With `claudeModel: 'opus'` already stored it stays `'opus'`.
- [ ] **Step 2:** `node --test test/colab-library.test.mjs test/board.test.mjs test/room.test.mjs`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5:** Commit `feat: roles can carry a picture permission; boards store an image model and Claude's model`.

---

### Task 2: OpenRouter — model capabilities and image generation

**Files:**
- Modify: `lib/colab/openrouter.mjs`, `server.mjs` (one route)
- Test: `test/colab-openrouter.test.mjs`, `test/server.test.mjs`

**Interfaces:**
- Produces:
  - `models()` entries gain `vision: boolean`, true when `architecture.input_modalities` includes `'image'`. The list is still only tool-capable models.
  - `imageModels(): Promise<Model[]>` lists models whose `architecture.output_modalities` includes `'image'`, with tools not required, in the same entry shape. It shares the one `/models` fetch and cache with `models()`: cache the raw list, then filter both from it.
  - `image({ model, prompt, signal }): Promise<{ data: Buffer, cost: number }>` posts `/chat/completions` with `{ model, messages: [{ role: 'user', content: prompt }], modalities: ['image', 'text'], usage: { include: true } }`. It reads `message.images[0].image_url.url`, which must be a `data:image/...;base64,` URL, and decodes it.
    - If there is no image, or the URL isn't a data URL, it throws `OpenRouterError('The image model returned no picture.')` with `cost` attached as `error.cost` (so the caller can still count it).
    - Keep the existing retry-on-dropped-connection logic by sharing a private `#post(body, signal)` with `complete`.
  - Server: `GET /api/colab/image-models` returns `{ models }`, or 502 with `{ error }`, mirroring `/api/colab/models`.
- [ ] **Step 1: Failing tests** (fake `fetch` as the existing openrouter tests do):
  - "models carry vision": a `/models` payload with one model whose `input_modalities` is `['text', 'image']` and one with `['text']` gives `vision` true and false.
  - "imageModels lists image-output models without requiring tools": a model with `output_modalities: ['image', 'text']` and no `tools` appears; a text-only model does not.
  - "image decodes a data URL and returns the cost": the response `images: [{ image_url: { url: 'data:image/png;base64,' + PNG_1x1_BASE64 } }]` with `usage.cost: 0.04` gives `data` equal to the decoded bytes and `cost` 0.04. Also assert that the posted body has `modalities: ['image', 'text']`.
  - "image without a picture throws with the cost": text only plus `usage.cost: 0.01` throws `/returned no picture/` with `error.cost === 0.01`.
  - `server` "GET /api/colab/image-models": returns the fake's list.
- [ ] **Step 2:** `node --test test/colab-openrouter.test.mjs test/server.test.mjs`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5:** Commit `feat: OpenRouter client knows which models see and make images, and can make one`.

---

### Task 3: `generate_image`, gated by role on every path

**Files:**
- Create: `lib/colab/pictures.mjs`
- Modify: `lib/mcp-tools.mjs` (tool definition and `createToolRunner` option), `lib/mcp.mjs` (`createMcpHandler` tool list), `lib/colab/run.mjs` (tool list for each card), `lib/agent.mjs` (disallowed tool and model), `lib/room.mjs` and `server.mjs` (wiring)
- Test: `test/pictures.test.mjs`, `test/mcp.test.mjs`, `test/colab-run.test.mjs`, `test/agent.test.mjs`

**Interfaces:**
- Consumes: Task 1 (`pictures`, `imageModel`, `claudeModel`) and Task 2 (`openrouter.image`).
- Produces:
  - `export const PICTURES_PER_TURN = 2;`
  - `class PictureMaker({ store, library, openrouter })`:
    - `canMake(author: string): boolean`. True when the author's role has `pictures: true`. For `'claude'` the role is `lineup.claudeRoleId`; for an agent it is the roster entry's `roleId`. Unknown authors give false.
    - `async make({ author, prompt, signal }): Promise<{ asset: string }>`. Checks run in this order, each throwing `OpError` with the spec's copy: role, then image model set, then budget (`spent >= budget`), then the per-turn count (keyed by `store.turnOf(author)`). Then it calls `openrouter.image`, adds `cost` (including `error.cost` on failure) through `store.addColabSpend`, saves with `store.assets.ingestBuffer(data)`, counts it toward the limit, and returns `{ asset }`.
  - Tool `generate_image`:
    - Description: `Make a new picture from a text prompt with the board's image model and add it to the brainstorm. Only some roles can use it; at most 2 per turn; it costs money from the budget.`
    - Schema: `{ prompt: string (required), caption: string, near }`.
    - It runs `pictures.make`, then `apply({ type: 'addObject', kind: 'picture', asset, caption, near })`, and returns `{ id, caption }`.
    - `createToolRunner(store, presence, { author, pictures })`. When `pictures` is missing, the tool throws `No image model is set; choose one in the sidebar.`
    - It is in `NOT_IN_BATCH`.
  - **Hiding the tool:**
    - **MCP:** `createMcpHandler(tools, { listTools = () => TOOLS })`. The server passes a `listTools` that drops `generate_image` unless `pictures.canMake('claude')`.
    - **OpenRouter cards:** `ColabRun` takes a `pictures` constructor option. A card's tool list drops `generate_image` unless `pictures.canMake(me.id)`, and its runner gets `{ pictures }`.
    - **Binary:** the `Agent` constructor takes `canMakePictures = () => false` and `model` as a string or a function returning a string. `#invoke` adds `'--disallowedTools', 'mcp__board__generate_image'` when `!canMakePictures()`, and passes `--model <model()>` when non-empty.
  - **Wiring:**
    - `server.mjs` main builds one `PictureMaker` and passes it to `createToolRunner` (the MCP runner), to `ColabRun` and to `Agent` (`canMakePictures: () => pictures.canMake('claude')`).
    - The `Agent` gets `model: () => store.board.colab.lineup.claudeModel`. `IDEA_BOARD_MODEL` is no longer read directly by `Agent`; Task 1's recover applies it.
- [ ] **Step 1: Failing tests**
  - `pictures.test.mjs`, using a store, a temp library and a fake `openrouter.image` that returns a 1×1 PNG with cost 0.05:
    - "only a picture role can make pictures": with roster agent A in role `art` (`pictures: true`) and B in role `qa`, `canMake(A)` is true and `canMake(B)` false. `make({author: B})` rejects with the exact role copy, and no image call is made.
    - "Claude's permission follows claudeRoleId": the result changes when `claudeRoleId` moves between `art` and `qa`.
    - "no image model": with `imageModel ''` it rejects with the exact copy and makes no call.
    - "the budget is checked first and spend is counted": `spent = budget` rejects with the budget copy and makes no call. A successful `make` raises `spent` by 0.05.
    - "two per turn": two makes by A succeed and the third rejects with `Picture limit reached for this turn (2).`. After A posts a chat message, a new make succeeds.
    - "no picture back still costs": the fake throws an `OpenRouterError` with `cost: 0.01`. It rejects `/returned no picture/`, `spent` rises by 0.01, and no asset is written.
  - `mcp.test.mjs`:
    - "tools/list hides generate_image unless Claude's role can make pictures": check both role states.
    - "a refused generate_image adds no picture": through `call`, with Claude in `qa`. The error copy is the role copy and there are no picture objects.
  - `colab-run.test.mjs`:
    - "a card sees generate_image only with a picture role": the request `tools` names include it for an `art` card and not for a `qa` card.
    - "a card's generate_image adds a picture authored by it": the fake `complete` calls `generate_image`. The picture object's `author` is the card id and spent includes 0.05.
  - `agent.test.mjs`:
    - "the binary gets --disallowedTools for generate_image without the permission, and the board's model": a fake binary echoes its argv. Check both permission states, and that `--model opus` follows `model: () => 'opus'`.
- [ ] **Step 2:** `node --test test/pictures.test.mjs test/mcp.test.mjs test/colab-run.test.mjs test/agent.test.mjs`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm run test:server`. Expected: PASS.
- [ ] **Step 5:** Commit `feat: generate_image for picture roles only, two per turn, paid from the budget`.

---

### Task 4: OpenRouter agents see pictures

**Files:**
- Modify: `lib/colab/run.mjs`
- Test: `test/colab-run.test.mjs`

**Interfaces:**
- Consumes: `models()` `vision` from Task 2 (`prepare()` already loads the models; keep a `Set` of vision model ids from it).
- Produces:
  - In the tool loop, when a tool result has `mcpContent` with `type: 'image'` blocks:
    - **Vision model:** push the tool message with the text parts (as today). Then push one `user` message `[{ type: 'text', text: 'The picture you asked to see:' }, { type: 'image_url', image_url: { url: 'data:<mimeType>;base64,<data>' } }]` for each image.
    - **Text-only model:** the tool message's text gets `\nThis model can't see images.` appended.
  - When the turn or answer ends (in `finally`), each such `user` image message in the stored conversation is replaced by `{ role: 'user', content: '[picture <id> shown]' }`. The `<id>` is the `view_picture` argument. This keeps base64 out of the 400,000-character history check.
- [ ] **Step 1: Failing tests**
  - "a vision card gets the picture as an image part": add a picture to the board (ingest a 1×1 PNG). The prepared models mark the card's model as `vision`. The fake `complete` calls `view_picture`, then answers. The second request's messages contain an `image_url` whose url starts with `data:image/png;base64,`.
  - "a text-only card is told it can't see images": the tool message content ends with `This model can't see images.`
  - "pictures don't stay in the conversation": after the turn, the next request's messages contain `[picture <id> shown]` and no `data:image` text. `JSON.stringify(messages).length` is under 50,000 with a 200 KB picture.
- [ ] **Step 2:** `node --test test/colab-run.test.mjs`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5:** Commit `feat: OpenRouter agents that can see images look at board pictures`.

---

### Task 5: Page — role checkbox, image model picker, Claude model popup, README

**Files:**
- Modify: `web/src/lib/types.ts`, `web/src/lib/api.ts`, `web/src/colab/colab.svelte.ts`, `web/src/colab/RoleEditor.svelte` (or `RolePane.svelte`, wherever a role's name and job are edited), `web/src/colab/ConnectionsPanel.svelte`, `README.md`
- Create: `web/src/colab/ClaudeModelPopup.svelte`
- Test: `web/src/colab/RoleEditor.test.ts`, `web/src/colab/ConnectionsPanel.test.ts`

**Interfaces:**
- Consumes: Task 1 fields and Task 2's `GET /api/colab/image-models`.
- Produces:
  - **Types:** `Role` gains `pictures?: boolean`; `lineup` gains `imageModel: string` and `claudeModel: string`. In api.ts, `colabImageModels(): Promise<Model[]>`. `colabState.imageModels` loads alongside `models`.
  - **Role editor:** a `Can make pictures` checkbox for the selected role. It saves through the existing library save, writing `pictures: true` or omitting the key.
  - **Sidebar footer:** `Image model`, using the existing `ModelPicker` with `colabState.imageModels`. It saves `imageModel` through `setColabLineup`, which still sends every field as today. The hint under it is `Used by roles that can make pictures.` It is disabled during a run, like the other footer fields.
  - **Claude's card:** the name renders as a button `1. Claude · <Label>`. `Label` is `Sonnet`/`Opus`/`Haiku`/`Fable` for the aliases, otherwise the raw id. The button opens `ClaudeModelPopup`.
    - The popup has a radio list of the four aliases, `Other…` with a text box (prefilled with the custom id when one is set), Save and Cancel. Save sends `setColabLineup` with `claudeModel`.
    - When `status.claude === 'mcp'` it also shows `Set by your session while connected via MCP.`
    - Escape or Cancel closes it. It is disabled during a run.
  - **README:** in "Collaborate → Connections", document the permission checkbox and Concept Art example, `generate_image` (2 per turn, from the budget, Image model in the footer), agents seeing pictures, and Claude's model popup. `IDEA_BOARD_MODEL` now sets only a new board's starting model.
- [ ] **Step 1: Failing tests**
  - RoleEditor "the picture checkbox saves pictures": tick it on a role. The `api.saveLibrary` mock (whatever the existing test mocks) is called with that role's `pictures: true`. Untick it and the key is omitted.
  - ConnectionsPanel:
    - "Claude's card shows its model and opens the popup": with `claudeModel: 'opus'`, the text `1. Claude · Opus` shows. Click it, choose `Haiku`, Save, and `api.op` is called with `objectContaining({ type: 'setColabLineup', claudeModel: 'haiku' })`.
    - "Other… saves a custom id": typing `claude-opus-5-5` sends that string.
    - "the popup notes MCP": `status.claude = 'mcp'` gives `Set by your session while connected via MCP.`
    - "Image model saves": pick an image model and `imageModel` is sent.
- [ ] **Step 2:** `npx vitest run web/src/colab`. Expected: FAIL.
- [ ] **Step 3:** Implement, then update the README.
- [ ] **Step 4:** Run `npm test && npm run check && npm run lint`. Expected: PASS.
- [ ] **Step 5:** Commit `feat: picture permission, image model and Claude's model in the page; docs`.
