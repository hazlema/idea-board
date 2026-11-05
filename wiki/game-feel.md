# Game feel

> How controlling the game feels: responsive, weighty, alive. Every action acknowledged. Read before deciding controls, feedback or effects.

Game feel is the tactile sense of controlling something in a game: the reason one jump feels great and another feels dead, even with the same rules. It comes from an instant response to input, movement with believable weight, and polish that emphasises every interaction. Designers call that extra layer of feedback "juice."

## Principles

- **Game feel is "real-time control of virtual objects in a simulated space, with interactions emphasized by polish" (Swink).** Three parts: an unbroken loop of input and response, a world where movement and collisions have weight, and polish (animation, sound, effects) that sells each interaction. Super Mario Bros. gets rich, expressive movement out of a d-pad and two buttons.
- **The response must be instant and continuous.** The player should feel they are moving the thing directly, not sending requests to it. Any lag or dead time breaks the feeling.
- **Juice: rich feedback for every interaction (Jonasson and Purho).** In "Juice It or Lose It" they turn a plain Breakout clone into a joy to play without changing a single rule. Things wobble, squash, stretch, bounce, flash and make little sounds when touched. Feel is a layer you can add on top of the rules.
- **Small tweaks add up (Nijman).** In "The Art of Screenshake," Vlambeer's Jan Willem Nijman takes a dull shooter and applies about thirty small changes. Screen shake against the direction of fire and enemies that sometimes burst when they die are two of them, and each change makes it more exciting to play *and* to watch.
- **Feedback says "that worked."** Every input should produce an immediate, unmistakable answer: a sound, a movement, a flash. The player should never wonder whether the game heard them.
- **Juice can be overdone.** Effects that hide what is happening, or tire the player, hurt clarity. The later GDC talk "Don't Juice It or Lose It" makes the case for restraint.

## For our designs

- Give every player action an instant answer they can see and hear.
- Make important moments land harder than routine ones: a big win gets more feedback than a step.
- Describe on the board *what the player should feel* ("tapping a card feels like flipping a real card"). The exact timings and effects belong in the build.
- Keep feedback readable for the youngest or least experienced player we expect.

## Common mistakes

- Silent actions: the player taps and nothing seems to happen.
- Delays between input and response.
- Same feedback for everything, so nothing feels important.
- So many effects that the player can't see what is going on.
- Leaving feel for "later polish," so it never arrives.

## Questions to ask of a design

- What does the player see and hear the instant they act?
- Which action is touched most often, and does it feel good the hundredth time?
- Which moments should feel biggest, and do they get the biggest feedback?
- Is there any moment where the player can't tell whether their input worked?
- Could a spectator tell what just happened from the feedback alone?
- Is any effect getting in the way of clarity?

## Sources

- Steve Swink, [Game Feel: A Game Designer's Guide to Virtual Sensation](https://en.wikipedia.org/wiki/Game_feel), Morgan Kaufmann, 2008.
- Martin Jonasson and Petri Purho, [Juice It or Lose It](https://gdcvault.com/play/1016487/Juice-It-or-Lose), GDC Europe 2012.
- Jan Willem Nijman, [The Art of Screenshake](https://www.youtube.com/watch?v=AJdEqssNZ-U), INDIGO Classes 2013 ([write-up](https://gamedeveloper.com/design/vlambeer-co-founder-shares-advice-on-building-better-action-games)).
- [Don't Juice It or Lose It](https://gdcvault.com/play/1020861/Don-t-Juice-It-or), GDC Europe 2014.
