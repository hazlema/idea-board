// /pitch: one agent adds twist pitches ("toy : where it lives") to the Pitches group. This
// file holds its texts and prompts; the pass itself runs like an audit (lib/colab/run.mjs).

export const PITCH_FRAME = 'You are pitching twists for a shared idea board. Add your pitches to the board with your tools; never change or remove entries that are already there. Your final reply is posted to the chat.';

export const pitchSystemPrompt = (text) => `${PITCH_FRAME}\n\n${text}`;

export function pitchPrompt({ count, guidance = '', snapshot = null }) {
  let prompt = `Add ${count} pitches to the group titled "Pitches" on the Brainstorm tab (create it if it doesn't exist). Label each one "toy : where it lives".`;
  if (guidance.trim()) prompt += `\n\nThe host's guidance for these pitches: ${guidance}`;
  if (snapshot) prompt += `\n\nThe board right now:\n${snapshot}`;
  return prompt;
}
