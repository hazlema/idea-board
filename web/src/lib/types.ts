// The board as the server stores it (see lib/board.mjs). Keep in step.

export type Author = 'user' | 'claude' | `agent:${string}`;
export type Check = 'none' | 'open' | 'done';
export type Color = 'slate' | 'violet' | 'green' | 'amber' | 'rose' | 'sky';
export type FlowStatus = 'idea' | 'accepted' | 'rejected';

export interface Section {
  id: string;
  title: string;
  text: string;
  updatedBy: Author;
  updatedAt: string;
}

export interface FlowProp {
  key: string;
  value: string;
}

export interface FlowNode {
  id: string;
  title: string;
  notes: string;
  props: FlowProp[];
  status: FlowStatus;
  author: Author;
  x: number;
  y: number;
  createdAt: string;
  updatedAt: string;
  updatedBy: Author;
}

export interface FlowEdge {
  id: string;
  from: string;
  to: string;
  label: string;
  author: Author;
}

export interface Entry {
  id: string;
  label: string;
  text: string;
  check: Check;
  ruledOut: boolean;
  author: Author;
  claudeAdded: boolean;
}

interface Base {
  id: string;
  x: number;
  y: number;
  /** 0 means "auto"; a positive h is a minimum height. Topics use 0 for both. */
  w: number;
  h: number;
  author: Author;
  claudeAdded: boolean;
  createdAt: string;
  updatedAt: string;
  updatedBy: Author;
}

export interface Group extends Base {
  kind: 'group';
  title: string;
  color: Color;
  entries: Entry[];
}

export interface Note extends Base {
  kind: 'note';
  text: string;
  color: Color;
}

export interface Picture extends Base {
  kind: 'picture';
  asset: string;
  preview: string | null;
  caption: string;
}

export interface Topic extends Base {
  kind: 'topic';
  text: string;
}

export type BObject = Group | Note | Picture | Topic;

export interface BLink {
  id: string;
  from: string;
  to: string;
  label: string;
  dashed: boolean;
  author: Author;
}

export interface Page {
  id: string;
  name: string;
  objects: BObject[];
  links: BLink[];
}

export interface RuledOut {
  id: string;
  text: string;
  reason: string;
  by: Author;
  at: string;
  source: {
    view: 'brainstorm' | 'flowchart' | 'chat';
    label: string;
    pageId?: string;
    objectId?: string;
    groupId?: string;
    entryId?: string;
    nodeId?: string;
  };
  snapshot: unknown | null;
}

export interface Pointer {
  kind: 'object' | 'entry' | 'node' | 'section';
  id: string;
  groupId?: string;
  label: string;
}

export interface ChatMessage {
  id: string;
  role: Author;
  text: string;
  at: string;
  /** Who this message still waits on (connection ids). */
  owed?: string[];
  /** Who it was addressed to, when a slash command routed it. */
  to?: string[];
  /** The message that started a run. */
  start?: boolean;
  context?: Pointer[];
  /** On an agent's note: what its turn took. */
  stats?: TurnStats;
  /** A host message passing on the foreman's request: who asked, and which step of how many. */
  request?: { by: Author; step: number; of: number };
}

/** The foreman's request: waiting for the host's Yes or No, or playing out step by step. */
export interface ForemanRequest {
  id: string;
  by: Author;
  at: string;
  state: 'waiting' | 'playing';
  /** The step under way while playing (from 0). */
  step: number;
  steps: { to: string; name: string; text: string }[];
}

export interface TurnStats {
  seconds: number;
  cost: number;
  calls: number;
  promptTokens: number;
  cachedTokens: number;
}

export interface Board {
  schema: 2;
  version: number;
  title: string;
  brief: { sections: Section[] };
  flow: { nodes: FlowNode[]; edges: FlowEdge[] };
  brainstorm: { pages: Page[] };
  ruledOut: RuledOut[];
  chat: ChatMessage[];
  claudeSessionId: string | null;
  colab: Colab;
}

export type AgentColor = 'amber' | 'sky' | 'green' | 'violet' | 'rose';

export interface LineupAgent {
  model: string;
  roleId: string;
  settings: Record<string, unknown>;
}

export interface RosterEntry {
  id: string;
  model: string;
  roleId: string;
  name: string;
  modelName: string;
  color: AgentColor;
}

export interface Colab {
  roster: RosterEntry[];
  /** turnLimit: minutes an agent's turn may take before it is asked to wrap up. */
  lineup: { agents: LineupAgent[]; rounds: number; budget: number; turnLimit: number; claudeRoleId: string; imageModel: string; claudeModel: string; pruneLimit: number | null; pruneAggressiveness: 'gentle' | 'normal' | 'aggressive'; auditAtEnd?: boolean };
  extras: { rules: string; roles: Record<string, string> };
  run: null | { round: number; spent: number };
  /** Spend across all OpenRouter connections, until reset. */
  spent: number;
  /** How Claude (connection 1) is named in chat. */
  claudeName: string;
  /** When the last prune pass ended, or null. */
  lastPruneAt: string | null;
  /** The foreman's request, while one is open. */
  request?: ForemanRequest | null;
}

/** What the agents are told, by occasion. The server fills any missing one from the defaults. */
export interface Prompts {
  chat: string;
  turn: string;
  answer: string;
  audit: string;
  prune: string;
}

export interface Library {
  rules: string;
  roles: Role[];
  prompts?: Prompts;
}

/** The shipped starting texts (defaults.json), which Reset to default puts back. */
export interface Defaults {
  shared: string;
  roles: Role[];
  prompts: Prompts;
}

export interface Role {
  id: string;
  name: string;
  job: string;
  /** May make pictures (gets the generate_image tool). */
  pictures?: boolean;
}

/** Prices are per million tokens. */
export interface Model {
  id: string;
  name: string;
  promptPrice: number;
  completionPrice: number;
  context: number;
}

export interface ConnectionStatus {
  state: 'waiting' | 'thinking' | 'over-budget';
  /** What the connection is doing right now ("reading the board"), or null. */
  activity: string | null;
  /** What it has done so far this turn ("read the board", "made 3 changes"). */
  done: string[];
}

export interface RunStatus {
  state: 'idle' | 'running' | 'stopping';
  round: number;
  rounds: number;
  /** Id of the connection whose turn it is: 'claude' or a card id. */
  current: Author | null;
  spent: number;
  budget: number;
  claude: 'binary' | 'mcp' | 'none';
  /** A prune pass is going. */
  pruning?: boolean;
  /** A prune pass is asked for or going (from /prune until it ends or is dropped). */
  prunePending?: boolean;
  /** An audit is going: the final audit of a run, or an /audit. */
  auditing?: boolean;
  /** Per connection id ('claude' or a card id). */
  connections: Record<string, ConnectionStatus>;
}

/** One connection as the server lists it (1 is Claude, 2 onward are the OpenRouter cards). */
export interface ConnectionInfo {
  n: number;
  id: string;
  kind: 'direct' | 'openrouter';
  available: boolean;
  why?: string;
}

/** An operation sent to POST /api/op. */
export type Op = { type: string; [key: string]: unknown };

export interface HistoryRow {
  seq: number;
  at: string;
  author: Author;
  turn: string;
  op: string;
  summary: string;
  kind?: 'undo' | 'redo' | 'restore';
  undone: boolean;
}

export interface VersionMeta {
  id: string;
  name: string;
  at: string;
  author: Author;
  auto: boolean;
  stats: { groups: number; entries: number; notes: number; pictures: number; cards: number };
}

export interface Skipped {
  seq: number;
  summary: string;
}

export type AgentState = 'idle' | 'working';

export interface BoardInfo {
  board: Board;
  presence: boolean;
  agent: AgentState;
  claude: 'binary' | 'mcp' | 'none';
}

/** The short name shown for an object (same rules as lib/brainstorm.mjs). */
export function objectLabel(o: BObject): string {
  switch (o.kind) {
    case 'group':
      return o.title;
    case 'note':
      return (o.text.split('\n').find((line) => line.trim()) ?? '').trim().slice(0, 60);
    case 'picture':
      return o.caption || 'picture';
    default:
      return o.text;
  }
}

/** The brainstorm object with this id, on any page. */
export function findObject(board: Board | null, id: string): BObject | undefined {
  for (const page of board?.brainstorm.pages ?? []) {
    const found = page.objects.find((o) => o.id === id);
    if (found) return found;
  }
  return undefined;
}
