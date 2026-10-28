// The final audit: a pass by the Foreman that may fix the board and reports. This file holds its texts and prompts.

export const AUDIT_FRAME = 'You are auditing a shared idea board for its host. You can change the board with your tools, and every change can be undone. Your final reply is posted to the chat as your audit report.';

// The board tools an audit may not call: it fixes the board and reports, nothing more.
export const AUDIT_DENIED = new Set(['ask_agents', 'generate_image', 'add_picture_from_url', 'reply', 'undo_reply', 'wait_for_chat', 'restore_version', 'rename_board']);

export const auditSystemPrompt = (text) => `${AUDIT_FRAME}\n\n${text}`;

export function auditPrompt({ focus = '', snapshot = null } = {}) {
  let prompt = 'Audit the board now.';
  if (focus.trim()) prompt += `\n\nThe host's focus for this audit: ${focus}`;
  if (snapshot) prompt += `\n\nThe board right now:\n${snapshot}`;
  return prompt;
}
