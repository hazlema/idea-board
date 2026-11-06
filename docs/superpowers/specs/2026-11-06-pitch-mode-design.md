# Pitch mode: twists that live somewhere new

_Design, 2026-11-06. Built from a conversation with Frosty (the host) about the Last Call Raccoon board._

## Why

On earlier boards (tic-tac-toe, Connect 4), every twist or power-up arrived the same way: between turns, as a card choice. The twists differed; where they lived in the game never did. The raccoon board showed the other half: asked plainly, three different model families all pitched the same game, and the board's later rounds wore the fun part away with rules.

The fix is to ask for twists in a way that forces spread in *where* they live (a card in the deck, the dealer calling "trick time", a heckler yelling "do a trick", a slot machine's dials, the twist falling out of a smashed bottle), let the agent pitch many, and let the host pick and lock the few worth keeping.

An earlier draft used random seeds drawn by code. That was dropped: random content produces nonsense ("behind a gnome's ear"). The spread comes from a fixed list of placement kinds instead, and the content stays the model's own, so it fits the game.

## What gets built

### 1. The pitch board

A group titled **Pitches** on the Brainstorm tab. Each pitch is one entry, labelled `toy : where it lives`, for example `Trick time : the dealer stops the game and calls it out loud`. The entry's text says in a sentence or two what the toy is (the thing that is fun before any rules) and how it reaches the player. The host can add his own pitches to the group like any other entry.

### 2. `/pitch`

- A chat command, `/pitch [how many] [guidance]`, for example `/pitch 20` or `/pitch 10 more like the heckler one`. With no number it asks for five.
- The agent reads the board and adds that many pitches to the Pitches group, creating it if it doesn't exist.
- Pitches spread across the **placement kinds**, a short list kept in the library defaults so the host can edit it:
  - a person in the game (a dealer, a heckler, an officer);
  - a machine in the setting (a slot machine, a vending machine, a radio);
  - chance the player can see (dice, a wheel, a card in the deck);
  - the setting itself (lights, weather, a phone ringing, time running out);
  - the player's own action (the twist comes out of something the player does).
- The pitch prompt tells the agent to think first of the most obvious twists for this game and not pitch them, and to say for each pitch what the twist is and where it reaches the player.
- `/pitch` can be run any time, as often as the host likes. It adds pitches and never edits or removes existing ones.

### 3. Locking: the host removes the checkbox

- The host already marks an entry as settled by removing its checkbox (`check: 'none'`). That gesture becomes the lock. Nothing changes in the UI.
- When the **host** removes an entry's checkbox, the server records that the host did it. From then on, no AI author can update, delete, move or rule out that entry, or delete a group holding it, until the host gives it a checkbox again.
- Entries that an agent created without a checkbox, or whose checkbox an agent removed, are not locked and stay editable as today. (`none` is the default check for new entries, so "no checkbox" alone can't mean locked.)
- The guard applies on every agent op, at all times, not only during a prune.
- History: a guard like this existed in `lib/prune.mjs` ("plain bullets are law during a prune") and was removed in `8a4b2a0` so prune could cut bullets. It applied only during a prune and protected every bullet, the agents' own included. The new guard closes both gaps.
- Locked pitches are part of the design. The turn, prune and audit prompts say so: build on locked entries, never edit them away. Unlocked pitches are ordinary entries; the host can delete the ones he doesn't want.

## The flow Frosty will test

One agent, the raccoon story. `/start` with the story builds the Brief and Flowchart as today. Then `/pitch 20`, lock the best few (or write his own), and `/start` again to build the game out around the locked pitches.

## Goals

- Pitches land in different places in the game, not always "between turns, as a card".
- Each pitch fits the game (no random-noun nonsense).
- Asking for more pitches is always one command away.
- What the host locks survives every later round, prune and audit.

## Non-goals

- Random seeds, reseeding, or a seed shown on the board.
- Agent voting on pitches (later, for an autonomous mode).
- Automatic pitch phases inside a run; pitching happens only when the host asks.
- A separate Pitch page or tab.

## Anti-goals

- **Locks an agent can undo.** If a locked entry can be edited away, the feature has failed even if everything else works.
- **Pitches that all live in the same place.** If twenty pitches come back as twenty card draws, the prompt has failed.

## Constraints

- `/pitch` follows the existing command path (`lib/commands.mjs` → `lib/room.mjs`) and runs as a one-off pass, like `/prune` and `/audit`.
- New prompt text and the placement kinds live in `defaults.json`, validated by `lib/defaults.mjs` (an unknown key is fatal, so new keys must be registered).
- The lock guard sits in the server's op path for all AI authors at all times, not only inside a prune pass as `lib/prune.mjs`'s guard does today. Existing boards have no record of who removed a checkbox, so nothing on them starts out locked.

## Left to the builder

- Which agent runs `/pitch` (the way audit picks its auditor is a good model).
- Whether `/pitch` is refused or queued while a run is going.
- Whether a locked entry looks any different from an agent's plain bullet.
- Exact prompt wording, within the rules above.
