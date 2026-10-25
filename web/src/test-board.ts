import type { Board } from '$lib/types';

/** A minimal valid board for component tests. */
export function emptyBoard(): Board {
  return {
    schema: 2,
    version: 0,
    title: 'Untitled board',
    brief: { sections: [] },
    flow: { nodes: [], edges: [] },
    brainstorm: { pages: [{ id: 'p_main', name: 'Brainstorm', objects: [], links: [] }] },
    ruledOut: [],
    chat: [],
    claudeSessionId: null,
    colab: { roster: [], lineup: { agents: [], rounds: 5, budget: 5, turnLimit: 30, claudeRoleId: 'creative', imageModel: 'openai/gpt-5.4-image-2', claudeModel: 'sonnet', pruneLimit: 5, pruneAggressiveness: 'normal' }, extras: { rules: '', roles: {} }, run: null, spent: 0, claudeName: 'Claude', lastPruneAt: null },
  };
}
