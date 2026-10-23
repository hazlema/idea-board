// Owns the board file: loads (migrating old files), applies ops, saves
// atomically, records every content change in the history log, undoes and
// redoes from it, and tells subscribers what changed.
import fs from 'node:fs';
import path from 'node:path';
import { AssetStore } from './assets.mjs';
import { isAi } from './authors.mjs';
import { OpError, applyOp, emptyBoard, migrateBoard, shortId } from './board.mjs';
import { HistoryLog, applyChanges, changedIdsOf, cloneContent, describeOp, diffContent, isUndoOrRedo } from './history.mjs';
import { renderDesignDoc } from './export.mjs';
import { boardPaths } from './paths.mjs';
import { enforceRuledOut } from './memory.mjs';
import { VersionStore, versionContent } from './versions.mjs';

// Ids of everything an op touched, so the page can flash them.
function changedIds(result) {
  return [result.node?.id, result.edge?.id, result.section?.id, ...(result.changed ?? [])].filter(Boolean);
}

// Ops the page runs on its own (previews are made automatically after an
// upload); they are not the user's edits, so they never become undo steps.
const SYSTEM_OPS = new Set(['setPicturePreview', 'setColabLineup', 'setColabExtras']);

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
    this.versions = new VersionStore(this.paths.versions);
    this.assets = new AssetStore(this.paths.assets);
    this.claudeTurn = newTurn();
  }

  #load() {
    try {
      return migrateBoard(JSON.parse(fs.readFileSync(this.file, 'utf8')));
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error(`cannot read board file ${this.file}: ${error.message}`, { cause: error });
      return emptyBoard(path.basename(path.dirname(this.file)));
    }
  }

  #save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(this.board, null, 2)}\n`);
    fs.renameSync(tmp, this.file);
  }

  // Write the board as a readable design document beside the board file.
  exportDesignDoc() {
    const today = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const date = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
    const markdown = renderDesignDoc(this.board, { assetsDirName: path.basename(this.paths.assets), date });
    fs.mkdirSync(path.dirname(this.paths.design), { recursive: true });
    const tmp = `${this.paths.design}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, markdown);
    fs.renameSync(tmp, this.paths.design);
    return this.paths.design;
  }

  // Runs `change` (which edits the board and saves it). If it throws, the
  // board in memory is put back as it was, so nothing half-applied or
  // unsaved stays behind without a history step.
  #atomically(change) {
    const saved = structuredClone(this.board);
    try {
      return change();
    } catch (error) {
      for (const key of Object.keys(this.board)) delete this.board[key];
      Object.assign(this.board, saved);
      throw error;
    }
  }

  apply(op, author) {
    const before = cloneContent(this.board);
    const { result, changes } = this.#atomically(() => {
      const result = applyOp(this.board, op, author);
      const changes = diffContent(before, this.board);
      this.board.version += 1;
      this.#save();
      return { result, changes };
    });
    const recorded = changes.length > 0 && !SYSTEM_OPS.has(op.type);
    if (recorded) {
      const summary = describeOp(op, result, before, author);
      this.historyLog.record({ author, turn: isAi(author) ? this.claudeTurn : undefined, op, summary, changes });
    }
    if (isAi(author) && op.type === 'chat') this.claudeTurn = newTurn();
    this.emit({ type: 'board', board: this.board, op: op.type, author, changed: changedIds(result) });
    if (recorded) this.emit({ type: 'history' });
    return result;
  }

  // Save and announce changes replayed from history, and log the replay
  // itself. `applied` is in the order it was replayed; an undo stores it back
  // in forward order, so redoing an undo is a plain 'redo' replay.
  #replayed(applied, { author, op, summary, kind, targets }) {
    const turn = isAi(author) ? this.claudeTurn : undefined;
    const changes = kind === 'undo' ? [...applied].reverse() : applied;
    this.historyLog.record({ author, turn, op, summary, changes, kind, targets });
    this.emit({ type: 'board', board: this.board, op, author, changed: changedIdsOf(applied) });
    this.emit({ type: 'history' });
  }

  // Undo the user's newest change that is still in effect.
  undo() {
    const log = this.historyLog;
    const target = log.entries().findLast((e) => e.author === 'user' && !isUndoOrRedo(e) && !log.isUndone(e.seq));
    if (!target) return { undone: null, skipped: [] };
    const { applied, skipped } = this.#replay(() => applyChanges(this.board, target.changes, 'undo'));
    this.#replayed(applied, { author: 'user', op: 'undo', summary: `undid: ${target.summary}`, kind: 'undo', targets: [target.seq] });
    return { undone: target, skipped };
  }

  // Redo what the latest undo took back, unless the user has changed
  // something since. A plain undo is redone by replaying the user's entry; an
  // "Undo this reply" by replaying the changes it reverted.
  #redoTarget() {
    const log = this.historyLog;
    const entries = log.entries();
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const entry = entries[i];
      if (entry.author === 'user' && !isUndoOrRedo(entry)) return null;
      if (entry.kind !== 'undo') continue;
      if (entry.op === 'undoTurn') {
        if (!log.isUndone(entry.seq) && entry.changes.length) return { entry, changes: entry.changes, summary: `redid: ${entry.summary}` };
        continue;
      }
      const undone = entries.find((e) => e.seq === entry.targets?.[0]);
      if (undone?.author === 'user' && log.isUndone(undone.seq)) return { entry: undone, changes: undone.changes, summary: `redid: ${undone.summary}` };
    }
    return null;
  }

  redo() {
    const target = this.#redoTarget();
    if (!target) return { undone: null, skipped: [] };
    const { applied, skipped } = this.#replay(() => applyChanges(this.board, target.changes, 'redo'));
    this.#replayed(applied, { author: 'user', op: 'redo', summary: target.summary, kind: 'redo', targets: [target.entry.seq] });
    return { undone: target.entry, skipped };
  }

  // Applies replayed changes and saves; on failure the board is left as it was.
  #replay(change) {
    return this.#atomically(() => {
      const result = change();
      this.board.version += 1;
      this.#save();
      return result;
    });
  }

  // Undo every change of one turn (one Claude reply), newest first. Changes
  // whose target was edited or deleted since are skipped and reported; an
  // entry counts as undone only when none of its changes were skipped.
  // Claude may only undo its own replies, never a turn of the user's.
  undoTurn(turn, author = 'user') {
    const log = this.historyLog;
    const ofTurn = log.entries().filter((e) => e.turn === turn && !isUndoOrRedo(e));
    if (isAi(author) && ofTurn.some((e) => !isAi(e.author))) throw new OpError(`turn ${turn} is not one of your replies`);
    const entries = ofTurn.filter((e) => !log.isUndone(e.seq)).reverse();
    const applied = [];
    const undone = [];
    const skipped = [];
    this.#atomically(() => {
      for (const entry of entries) {
        const result = applyChanges(this.board, entry.changes, 'undo');
        applied.push(...result.applied);
        if (result.skipped.length) skipped.push({ seq: entry.seq, summary: entry.summary });
        else undone.push(entry.seq);
      }
      if (!applied.length && !undone.length) return;
      this.board.version += 1;
      this.#save();
    });
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

  saveVersion(name, author, { auto = false } = {}) {
    const meta = this.versions.save(this.board, { name, author, auto });
    this.emit({ type: 'versions' });
    return meta;
  }

  // Put a saved version's content on the board, after saving what is there now.
  // Memory (ruled-out list, chat, history) is untouched; ruled-out items that
  // come back with the version are struck out or removed again. Recorded as
  // one history step, so undo reverses it.
  restoreVersion(id, author) {
    const { meta: restored, content } = this.versions.read(id);
    const backup = this.saveVersion(`Before restoring “${restored.name}”`, author, { auto: true });
    const before = cloneContent(this.board);
    const changes = this.#atomically(() => {
      Object.assign(this.board, structuredClone(versionContent(content)));
      enforceRuledOut(this.board);
      const changes = diffContent(before, this.board);
      this.board.version += 1;
      this.#save();
      return changes;
    });
    if (changes.length) {
      const turn = isAi(author) ? this.claudeTurn : undefined;
      this.historyLog.record({ author, turn, op: 'restoreVersion', summary: `restored version “${restored.name}”`, changes, kind: 'restore' });
    }
    this.emit({ type: 'board', board: this.board, op: 'restoreVersion', author, changed: changedIdsOf(changes) });
    this.emit({ type: 'history' });
    return { restored, backup };
  }

  setSessionId(id) {
    this.board.claudeSessionId = id;
    this.#save();
  }

  // The progress of a running agent colab ({ round, spent }), or null when none runs.
  // Kept on the board so a restart can tell a run was cut short. No history, no event.
  setColabRun(run) {
    this.board.colab.run = run;
    this.#save();
  }

  // Roster entries for agents about to play, so their changes are accepted under their own names.
  addColabRoster(entries) {
    this.board.colab.roster.push(...entries);
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
