// The final audit: a pass by the Foreman that may fix the board and reports. This file holds its texts and prompts.

export const AUDIT_FRAME = 'You are auditing a shared idea board for its host. You can change the board with your tools, and every change can be undone. Your final reply is posted to the chat as your audit report.';

// The board tools an audit may not call. It fixes the board, may hand work on with ask_agents
// (the host approves it; it plays once the run is over) and may draw if its role can.
export const AUDIT_DENIED = new Set(['add_picture_from_url', 'reply', 'undo_reply', 'wait_for_chat', 'restore_version', 'rename_board']);

export const auditSystemPrompt = (text) => `${AUDIT_FRAME}\n\n${text}`;

export function auditPrompt({ focus = '', snapshot = null } = {}) {
  let prompt = 'Audit the board now.';
  if (focus.trim()) prompt += `\n\nThe host's focus for this audit: ${focus}`;
  if (snapshot) prompt += `\n\nThe board right now:\n${snapshot}`;
  return prompt;
}
