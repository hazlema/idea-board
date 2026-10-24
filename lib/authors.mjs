// Who made a change. 'user' is the person; every other author is an AI: the
// Claude session ('claude') or an agent from the colab roster, whose id is
// 'agent:<model>=<roleId>' (one model in one role).

export const isAi = (author) => author === 'claude' || (typeof author === 'string' && author.startsWith('agent:'));

export const agentId = (model, roleId) => `agent:${model}=${roleId}`;

// Ids for lineup cards, in order. Two cards with the same model and role would
// share an id, so the n-th repeat gets '#n' after it.
export function cardIds(agents) {
  const seen = new Map();
  return agents.map(({ model, roleId }) => {
    const id = agentId(model, roleId);
    const n = (seen.get(id) ?? 0) + 1;
    seen.set(id, n);
    return n === 1 ? id : `${id}#${n}`;
  });
}

// The name shown for an author. An agent missing from the roster (removed
// since it wrote) falls back to what follows 'agent:'.
export function authorName(board, author) {
  if (author === 'user') return 'You';
  if (author === 'claude') return board.colab?.claudeName ?? 'Claude';
  const entry = board.colab?.roster?.find((r) => r.id === author);
  return entry?.name ?? String(author).replace(/^agent:/, '');
}
