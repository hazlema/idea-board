# Paper playtests

## Why

QA's job says to "play the game in your head", and its own prompt admits that imagined
playthroughs are hypotheses, not playtests. When the player in your head is also the one who knows
what the team meant, every gap in the rules gets filled without anyone noticing. ALL OF US, the
design from the streamer transcript, shows this: a strong premise, but nobody could say what you
do minute to minute, how a crowd with no weapons holds a street, or how often people die.

Success: an agent (or the host) plays the game as written. A referee who knows only the board says
what happens, and stops play wherever the rules don't say. Those stops, plus the numbers it had to
invent, tell the team what the design is missing.

## What it is

### Decided by the host

- **Agents can play it, and so can the host.** The agents will use it more than the host does.
- **It has its own tab,** Playtest, so it doesn't clutter the chat.

### Our calls (not discussed with the host; listed so they can be checked)

- **A playtest is a game of turns.** The player says what they do in plain words ("ring the bell
  in the market"). The referee answers with what happens, the game's state after it, and anything
  it couldn't settle from the rules.
- **The referee sees only the board:** the Brief, the Brainstorm and the Flowchart, the same views
  the agents read. It never sees the chat. If it knew what the team meant, it would fill the gaps
  quietly and every playtest would "work".
- **A gap stops the action, not the game.** When the rules don't say what happens, the referee
  says so ("The rules don't say what happens when the drum reaches the crowd") and the state stays
  as it was. The player can try something else. Small things it can settle with a made-up detail
  (which happens first, how many) are not gaps: it assumes them and plays on.
- **Invented numbers are allowed, and listed.** The board keeps numbers and tuning off it, and a
  referee can't settle "the crowd holds the street" without some. When it needs one it makes it
  up, says so ("assumed: 10 people hold a street"), and keeps using it for the rest of that game.
  The log lists every one.
- **The server rolls the dice,** not the model. Each referee call gets a fresh set of rolls
  (1–100) to use in order when something is left to chance, and must say which it used. The
  state is the referee's own words (a short list of facts, such as "Crowd: 40, three named:
  Bettany (baker)…"). The server keeps it and passes it back each turn, so it can't drift.
- **The referee answers through a `rule` tool,** its only tool, with a fixed schema. It is asked to
  call it rather than forced to, because Sonnet 5.5 refuses a forced tool choice; a JSON answer in
  plain text is read too. (Asked for plain JSON, it once wrote an imitation tool call instead.)
- **The referee is one OpenRouter call per turn,** with its own model in ⋯ → Settings beside the
  image model. The default is `anthropic/claude-sonnet-5.5`: the referee has to be strict, so it
  is worth a strong model. Its cost counts against the run's budget like pictures do, and a
  playtest is refused when the budget is used up or there is no OpenRouter key.
- **The referee's prompt is in the library** (`prompts.referee` in `defaults.json`), editable in
  the Roles box like every other prompt.
- **Every agent gets the tools,** not only QA, through the same tool list Claude and the cards
  share:
  - `playtest_start` sets up a game from the board and returns the opening and the state.
  - `playtest_act` takes the player's action and returns what happens.
  - `playtest_end` closes the game with the player's verdict (a few lines: what worked, what broke).
  - `read_playtest` lists the playtests, or reads one in full, so others can read QA's findings.
  QA's default job in `defaults.json` gets a line telling it to playtest rather than imagine. A
  library someone has edited keeps its own text, as always.
- **One open playtest per player,** and at most 20 actions in one, so an agent can't spend the
  budget in a loop. A second `playtest_start` while one is open is refused.
- **Playtests are kept beside the board,** one file each in a `playtests` folder next to
  `versions` and `files`. They are not board content: no undo, no history, and the prune and the
  board views never see them. An audit may read them but not play.
- **The tab:** a list on the left (who, when, how many turns, how many gaps, open or ended).
  The selected one shows its log on the right: each action, what happened, gaps in amber, invented
  numbers in a list at the end, and the current state in a box at the top. Under an open game of
  the host's there is a box to type the next action, and an End button. A New playtest button
  starts one for the host. An agent's game updates live as it plays.
- **The chat isn't used.** Starting or finishing a playtest posts nothing. QA reports what it
  found the usual way, in its turn.

## Not now

- A numbers simulator that plays thousands of games for balance. It needs the rules written as
  exact numbers first; the invented-numbers list is the first step towards that.
- A picture of the game state, or a chart of state over turns. The log comes first; a chart can
  read it later.
