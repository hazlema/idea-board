// What an agent is told: who it is, what the shared rules are, and the chat.
import { authorName } from '../authors.mjs';

export const TURN_RULES = `How to play your turn:
- The board is in your messages: the whole of it on your first turn, then what changed since your last turn. Read ruled_out: don't bring those back. You already have it, so don't call view_board to start your turn; use it only if you need to check something mid-turn.
- Build on the others' ideas and challenge weak ones openly, saying why.
- To remove another agent's work, use rule_out with the reason; never delete it outright.
- Make a handful of meaningful changes (about 3 to 6), then stop.
- Finish with a short chat message to the others, 3 to 5 sentences and no long lists: your creative idea, what else you changed, and one question or challenge for the next agent. Your final reply, as plain text with no tool call, is posted to the chat under your name; there is no chat tool, so do not look for one.`;

export const ANSWER_RULES = `How to answer:
- The host has written to you in the chat. Answer in your role, in 2 to 6 sentences.
- The other agents answer the same message on their own, at the same time; you won't see their answers first, so give your own view.
- You may change the board if that helps; if you do, say what you changed.
- Your final reply, as plain text with no tool call, is posted to the chat under your name; there is no chat tool, so do not look for one.`;

const list = (names) => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

export function systemPrompt({ me, others, job, rules, mode = 'turn' }) {
  const how = mode === 'answer' ? 'Right now you are answering the host.' : 'You take turns in that order; this is your turn.';
  const team = others.length
    ? `one of ${others.length + 1} AI agents working together on a shared idea board. The others are ${list(others.map((o) => o.name))}. A human host watches and may step in through the chat. ${how}`
    : 'an AI agent working on a shared idea board. A human host watches and may step in through the chat.';
  return `You are ${me.name}, ${team}

Your role: ${job}

The board has a Brief (goals and current decisions), a Brainstorm canvas (groups of entries, notes, topics, links) and a Flowchart (cards and arrows). Use your tools to work on it.

${rules}

${mode === 'answer' ? ANSWER_RULES : TURN_RULES}`;
}

// A host message sent to some connections only reads "Host (to <name>): …".
const said = (board, m) => {
  if (m.role !== 'user') return `${authorName(board, m.role)}: ${m.text}`;
  const to = m.to?.length ? ` (to ${list(m.to.map((id) => authorName(board, id)))})` : '';
  return `Host${to}: ${m.text}`;
};

// An agent's first turn (or a fresh start): the chat so far and the whole board.
// In answer mode it ends by asking for an answer instead.
export function turnMessage(board, me, snapshot, { mode = 'turn' } = {}) {
  const lines = (board.chat ?? []).slice(-40).map((m) => said(board, m));
  const view = snapshot ? `\n\nThe board right now (what view_board returns):\n${snapshot}` : '';
  const ask = mode === 'answer' ? `Answer the host, ${me.name}.` : `It is your turn, ${me.name}.`;
  return `The chat so far:\n\n${lines.join('\n\n')}${view}\n\n${ask}`;
}

function since(board, { changes, messages, answering = [] }) {
  const parts = [];
  if (changes.length) parts.push(`Changes on the board:\n${changes.map((e) => `- ${e.author === 'user' ? 'Host' : authorName(board, e.author)}: ${e.summary}`).join('\n')}`);
  if (messages.length) parts.push(`New in the chat:\n\n${messages.map((m) => said(board, m)).join('\n\n')}`);
  // Host messages to answer that it saw before (during a run turn, say) are named again.
  const earlier = answering.filter((m) => !messages.some((n) => n.id === m.id));
  if (earlier.length) parts.push(`Still to answer:\n\n${earlier.map((m) => said(board, m)).join('\n\n')}`);
  return parts.length ? parts.join('\n\n') : 'Nothing has changed.';
}

// Its later turns: only what happened since its last one. `changes` are history rows, `messages` chat messages.
export function updateMessage(board, me, update) {
  return `Since your last turn:\n\n${since(board, update)}\n\nIt is your turn again, ${me.name}.`;
}

// The same, when the host's messages are to be answered rather than a turn played.
// `answering` are the messages owed an answer, listed even if it has seen them already.
export function answerMessage(board, me, update) {
  return `Since your last turn:\n\n${since(board, update)}\n\nAnswer the host, ${me.name}.`;
}

// Some models start with their own name tag; the post adds it, so drop theirs.
export function stripSelfTag(text, name) {
  return text.replace(/^\s*\**[^:\n]{0,80}:\**\s*/, (tag) => (tag.includes(name) ? '' : tag));
}
