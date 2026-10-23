// What an agent is told: who it is, what the shared rules are, and the chat.
import { authorName } from '../authors.mjs';

export const TURN_RULES = `How to play your turn:
- Start with view_board to see where the design is. Read ruled_out: don't bring those back.
- Build on the others' ideas and challenge weak ones openly, saying why.
- To remove another agent's work, use rule_out with the reason; never delete it outright.
- Make a handful of meaningful changes (about 3 to 6), then stop.
- Finish with a short chat message to the others, 3 to 5 sentences and no long lists: your creative idea, what else you changed, and one question or challenge for the next agent. Your final reply, as plain text with no tool call, is posted to the chat under your name; there is no chat tool, so do not look for one.`;

const list = (names) => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

export function systemPrompt({ me, others, job, rules }) {
  const team = others.length
    ? `one of ${others.length + 1} AI agents working together on a shared idea board. The others are ${list(others.map((o) => o.name))}. A human host watches and may step in through the chat. You take turns in that order; this is your turn.`
    : 'an AI agent working on a shared idea board. A human host watches and may step in through the chat.';
  return `You are ${me.name}, ${team}

Your role: ${job}

The board has a Brief (goals and current decisions), a Brainstorm canvas (groups of entries, notes, topics, links) and a Flowchart (cards and arrows). Use your tools to work on it.

${rules}

${TURN_RULES}`;
}

export function turnMessage(board, me) {
  const lines = (board.chat ?? []).slice(-40).map((m) => `${m.role === 'user' ? 'Host' : authorName(board, m.role)}: ${m.text}`);
  return `The chat so far:\n\n${lines.join('\n\n')}\n\nIt is your turn, ${me.name}.`;
}

// Some models start with their own name tag; the post adds it, so drop theirs.
export function stripSelfTag(text, name) {
  return text.replace(/^\s*\**[^:\n]{0,80}:\**\s*/, (tag) => (tag.includes(name) ? '' : tag));
}
