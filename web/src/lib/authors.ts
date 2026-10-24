import type { Author, Board } from './types';

// Who made a change (mirrors lib/authors.mjs). 'user' is the person; every
// other author is an AI: the Claude session or an agent from the colab roster.

export const isAi = (author: Author): boolean => author === 'claude' || author.startsWith('agent:');

/** The name shown for an author; an agent no longer in the roster falls back to what follows 'agent:'. */
export function authorName(board: Board | null, author: Author): string {
  if (author === 'user') return 'You';
  if (author === 'claude') return board?.colab?.claudeName ?? 'Claude';
  return board?.colab?.roster?.find((r) => r.id === author)?.name ?? author.replace(/^agent:/, '');
}

const AGENT_COLORS = {
  amber: '#f59e0b',
  sky: '#38bdf8',
  green: '#4ade80',
  violet: '#a78bfa',
  rose: '#fb7185',
};

/** A CSS colour for an author's name. */
export function authorColor(board: Board | null, author: Author): string {
  if (author === 'user') return 'var(--color-accent)';
  if (author === 'claude') return 'var(--color-claude)';
  const color = board?.colab?.roster?.find((r) => r.id === author)?.color;
  return color ? AGENT_COLORS[color] : 'var(--color-claude)';
}

/** The id of each lineup card (mirrors cardIds in lib/authors.mjs): a repeat of the same model and role gets #2, #3… */
export function cardIds(agents: { model: string; roleId: string }[]): string[] {
  const seen = new Map<string, number>();
  return agents.map(({ model, roleId }) => {
    const id = `agent:${model}=${roleId}`;
    const n = (seen.get(id) ?? 0) + 1;
    seen.set(id, n);
    return n === 1 ? id : `${id}#${n}`;
  });
}
