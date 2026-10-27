# Foreman requests

## Why

The foreman sees what the team needs next, but it can only say so in the chat. "Systems should
work out the save format" is just a line in the chat. Nobody owes it an answer, so Systems acts on
it only if it happens to pick it up on a later turn. Only the host's messages put an agent on the
hook to answer.

What happened: a foreman said in the chat that it wanted Systems to do something. The host
wants the foreman to "just be able to ask directly after the user approves the request".

Success: the foreman puts a request to an agent, the host sees it and says Yes or No, and on Yes
the agent does it, carrying the same weight as a message from the host.

## What it is

### Decided by the host

- **Who can ask:** whoever holds the Foreman role. That is usually Claude, but it can be an
  OpenRouter card that has been given the role. If several connections hold it (Claude and a card,
  or two cards), every one of them may ask.
- **A request is a chain:** one or more steps in order. Each step is one request to one agent.
  A step goes out only after the agent in the step before it has answered, so later steps build on
  earlier ones. Example: "1. Systems: rework the save format. 2. Art: update the inventory
  mockups to match."
- **Approval, once per chain:** a modal dialog shows the whole chain: each step's agent and
  request, then Yes and No. One answer covers the whole chain. If something in it is wrong, the
  host says No and raises it in the chat.
- **Nothing moves while the modal is open.** A run pauses until the host answers, however long
  that takes.
- **No is a plain no.** It has no reason field. If the foreman ought to know why, the host tells
  it in the chat.
- **Once approved, the chain plays out straight away,** even in the middle of a run, out of the
  normal turn order. Each agent works on its step and answers, just as it does when the host
  writes to it directly. It may change the board. Then the run carries on from where it stopped.

### Our calls (not discussed with the host; listed so they can be checked)

- **How the foreman asks:** a new board tool that takes a list of steps (agent and request text).
  Claude and the cards both get it through the same tool list. The server refuses it from anyone
  who doesn't hold the Foreman role, and the tool is described to the others as the foreman's
  alone, or hidden from them.
- **Which agents can be named:** any connection in the line-up except the asker, Claude included
  when a card is the foreman. Agents are named the way `view_chat`'s `from` names them (id, or
  part of a name such as the role). Another Foreman can be named. A name that matches no one or
  more than one, or an agent that can't answer right now (out of budget, disconnected), is
  refused before the modal opens, so the host never approves a chain that can't run.
- **The foreman's turn ends with the request.** In a run, the tool's answer tells the foreman the
  request is waiting for the host and that it will see the answers in the chat. Its turn then
  finishes as usual. The foreman doesn't wait inside its turn, so the turn timer isn't running
  while the modal is open. The chain starts after the foreman's turn is over.
- **One chain at a time.** A second request while one is waiting or playing out is refused, and
  the tool's answer says so.
- **In the chat:**
  - when the foreman asks: one message from the foreman that lists the chain, marked as waiting
    for the host;
  - on Yes: each step is posted when it goes out, as the foreman's request to that agent and
    marked approved by the host; the agent's answer follows it;
  - on No: a short line, "The host declined the request."
- **What an agent is told:** a step reaches its agent like a host message addressed to it (the
  answer rules, the board changes since its last turn), with a line saying it is the foreman's
  request and the host approved it.
- **A step that can't run:** if the agent can't answer when its step comes up (out of budget,
  disconnected, its answer failed), the chain stops there. A chat note names the step and why, and
  the rest of the chain is dropped.
- **Stop:** `/stop`, or Stop on the page, while the modal is open or a chain is playing out
  cancels the chain and stops the run as usual. A step already under way is cut the same way a
  turn is.
- **Outside a run:** the same flow. Claude, as the foreman answering the host in chat, can make
  a request. The modal opens. The chain starts as soon as the host says Yes, even if the foreman
  is still working: an interactive Claude Code session has no clear end to wait for. The host's
  Yes is the gate. Nothing else is held up.
- **Audits and prunes:** the tool is refused during an audit (read-only) and during a prune
  pass. A chain that is playing out when a pass is due finishes first, the way answers do now.
- **The modal survives a reload.** The waiting chain is kept on the server, and every open tab
  shows the modal. The first answer from any tab counts, and the modal closes in the others. A
  server restart drops a waiting or unfinished chain with a chat note, the way a run is dropped
  now.
- **Budget:** steps answered by cards cost what an answer costs and count against the run's
  budget.

## Goals

- The foreman can make a chain of requests to other agents, and they get done.
- Nothing goes to an agent until the host has seen the whole chain and said Yes.
- A run waits for the host's answer.

## Non-goals

- Approving requests automatically. The host wants a setting for this later ("some kind of
  threshold in settings for auto approval", like running with permissions bypassed). Not part of
  this work, but the design shouldn't rule it out.
- Agents other than the foreman making requests.
- Editing a chain in the modal, or approving only some of its steps.
- Sending one step to several agents at once.

## Anti-goals (a failure even if it technically works)

- Anything reaches an agent before the host says Yes.
- The run carries on while a request is waiting for the host.
- The modal pops up for something the host can't act on: a chain naming an unknown agent, say.
- A step goes out before the agent in the step before it has answered.

## Left to the builder

- The tool's name, its description and its exact answers.
- How the server tells the page a chain is waiting, and how the page answers (the page already
  gets the board and run state pushed to it).
- The modal's look: it should match the existing dialogs (`SettingsDialog`).
- The prompt and README wording: the Foreman role's text in the library, `TURN_RULES` and
  `ANSWER_RULES` if needed, and the commands and roles sections of the README.
- Tests:
  - only the foreman can ask;
  - an unknown or ambiguous agent is refused before the modal;
  - nothing is sent before Yes;
  - a run waits while the modal is open;
  - steps go out in order, each after the answer before it;
  - No posts the line and sends nothing;
  - a step that can't run stops the chain with a note;
  - Stop cancels the chain;
  - one chain at a time;
  - the modal shows again after a reload;
  - a restart drops the chain with a note.
