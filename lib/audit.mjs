// The final audit: a read-only pass by the Foreman. This file holds its texts and prompts.

export const AUDIT_FRAME = "You are auditing a shared idea board for its host. You can only read it: your tools can't change anything, so don't try. Your final reply is posted to the chat as your audit report. The host reads it and decides what, if anything, to do.";

export const DEFAULT_AUDIT_TEXT = 'Please audit the board and report any problems or inconsistencies: contradictions, duplicates, gaps, stale items, and anything in the Brief that is out of step with the rest of the board. One line per problem, saying where on the board it is. If you find none, say so.';

// The only board tools an audit may call: all of them read.
export const AUDIT_TOOLS = new Set(['view_board', 'view_picture', 'get_node', 'get_history', 'list_versions']);

export const auditSystemPrompt = (text) => `${AUDIT_FRAME}\n\n${text}`;

export function auditPrompt({ focus = '', snapshot = null } = {}) {
  let prompt = 'Audit the board now.';
  if (focus.trim()) prompt += `\n\nThe host's focus for this audit: ${focus}`;
  if (snapshot) prompt += `\n\nThe board right now (what view_board returns):\n${snapshot}`;
  return prompt;
}
