// The board as the server stores it (see lib/board.mjs). Keep in step.

export type Author = 'user' | 'claude';
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
  handled: boolean;
  context?: Pointer[];
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

export type AgentState = 'idle' | 'working' | 'off';

export interface BoardInfo {
  board: Board;
  presence: boolean;
  agent: AgentState;
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
