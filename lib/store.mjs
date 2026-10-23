// Owns the board file: loads (migrating old files), applies ops, saves
// atomically, records every content change in the history log, undoes and
// redoes from it, and tells subscribers what changed.
import fs from 'node:fs';
import path from 'node:path';
import { applyOp, emptyBoard, migrateBoard, shortId } from './board.mjs';
import { HistoryLog, applyChanges, changedIdsOf, cloneContent, describeOp, diffContent, isUndoOrRedo } from './history.mjs';
import { boardPaths } from './paths.mjs';

// Ids of everything an op touched, so the page can flash them.
function changedIds(result) {
  return [result.node?.id, result.edge?.id, result.section?.id, ...(result.changed ?? [])].filter(Boolean);
}

// Claude's changes are grouped by reply: a turn lasts until Claude's next chat message.
const newTurn = () => shortId('t');

export class BoardStore {
  // `now` and `coalesceMs` are passed to the history log (tests use a fake clock).
  constructor(file, { now, coalesceMs } = {}) {
    this.paths = boardPaths(file);
    this.file = this.paths.board;
    this.listeners = new Set();
    this.board = this.#load();
    this.historyLog = new HistoryLog(this.paths.history, { now, coalesceMs });
    this.claudeTurn = newTurn();
  }

  #load() {
    try {
      return migrateBoard(JSON.parse(fs.readFileSync(this.file, 'utf8')));
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error(`cannot read board file ${this.file}: ${error.message}`);
      return emptyBoard(path.basename(path.dirname(this.file)));
    }
  }

  #save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(this.board, null, 2)}\n`);
    fs.renameSync(tmp, this.file);
  }

  apply(op, author) {
    const before = cloneContent(this.board);
    const result = applyOp(this.board, op, author);
    const changes = diffContent(before, this.board);
    this.board.version += 1;
    this.#save();
    if (changes.length) {
      const summary = describeOp(op, result, before, author);
      this.historyLog.record({ author, turn: author === 'claude' ? this.claudeTurn : undefined, op, summary, changes });
    }
    if (author === 'claude' && op.type === 'chat') this.claudeTurn = newTurn();
    this.emit({ type: 'board', board: this.board, op: op.type, author, changed: changedIds(result) });
    return result;
  }

  // Save and announce changes replayed from history, and log the replay itself.
  #replayed(applied, { author, op, summary, kind, targets }) {
    this.board.version += 1;
    this.#save();
    const turn = author === 'claude' ? this.claudeTurn : undefined;
    this.historyLog.record({ author, turn, op, summary, changes: applied, kind, targets });
    this.emit({ type: 'board', board: this.board, op, author, changed: changedIdsOf(applied) });
    this.emit({ type: 'history' });
  }

  // Undo the user's newest change that is still in effect.
  undo() {
    const log = this.historyLog;
    const target = log.entries().findLast((e) => e.author === 'user' && !isUndoOrRedo(e) && !log.isUndone(e.seq));
    if (!target) return { undone: null, skipped: [] };
    const { applied, skipped } = applyChanges(this.board, target.changes, 'undo');
    this.#replayed(applied, { author: 'user', op: 'undo', summary: `undid: ${target.summary}`, kind: 'undo', targets: [target.seq] });
    return { undone: target, skipped };
  }

  // Redo the change the latest plain undo took back, unless the user has
  // changed something since that undo.
  redo() {
    const log = this.historyLog;
    const entries = log.entries();
    let target = null;
    for (let i = entries.length - 1; i >= 0 && !target; i -= 1) {
      const entry = entries[i];
      if (entry.author === 'user' && !isUndoOrRedo(entry)) break;
      if (entry.kind !== 'undo' || entry.op !== 'undo') continue;
      const undone = entries.find((e) => e.seq === entry.targets?.[0]);
      if (undone?.author === 'user' && log.isUndone(undone.seq)) target = undone;
    }
    if (!target) return { undone: null, skipped: [] };
    const { applied, skipped } = applyChanges(this.board, target.changes, 'redo');
    this.#replayed(applied, { author: 'user', op: 'redo', summary: `redid: ${target.summary}`, kind: 'redo', targets: [target.seq] });
    return { undone: target, skipped };
  }

  // Undo every change of one turn (one Claude reply), newest first. Changes
  // whose target was edited or deleted since are skipped and reported; an
  // entry counts as undone only when none of its changes were skipped.
  undoTurn(turn, author = 'user') {
    const log = this.historyLog;
    const entries = log.entries().filter((e) => e.turn === turn && !isUndoOrRedo(e) && !log.isUndone(e.seq)).reverse();
    const applied = [];
    const undone = [];
    const skipped = [];
    for (const entry of entries) {
      const result = applyChanges(this.board, entry.changes, 'undo');
      applied.push(...result.applied);
      if (result.skipped.length) skipped.push({ seq: entry.seq, summary: entry.summary });
      else undone.push(entry.seq);
    }
    if (applied.length || undone.length) {
      const count = `${undone.length} change${undone.length === 1 ? '' : 's'}`;
      this.#replayed(applied, { author, op: 'undoTurn', summary: `undid a reply (${count})`, kind: 'undo', targets: undone });
    }
    return { undone: undone.length, skipped };
  }

  // History rows, newest first, without their change data.
  history({ limit = 50, before } = {}) {
    const log = this.historyLog;
    const rows = log.entries()
      .filter((e) => before === undefined || e.seq < before)
      .slice(-Math.max(1, limit))
      .reverse()
      .map(({ changes, ...row }) => ({ ...row, undone: log.isUndone(row.seq) }));
    return { entries: rows };
  }

  setSessionId(id) {
    this.board.claudeSessionId = id;
    this.#save();
  }

  emit(event) {
    for (const listener of this.listeners) listener(event);
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
