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
    colab: { roster: [], lineup: { agents: [], rounds: 5, budget: 5, turnLimit: 30, claudeRoleId: 'creative', imageModel: '', claudeModel: 'sonnet' }, extras: { rules: '', roles: {} }, run: null, spent: 0, claudeName: 'Claude' },
  };
}
