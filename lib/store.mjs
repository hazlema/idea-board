// Owns the board file: loads (migrating old files), applies ops, saves
// atomically, and tells subscribers what changed.
import fs from 'node:fs';
import path from 'node:path';
import { applyOp, emptyBoard, migrateBoard } from './board.mjs';
import { boardPaths } from './paths.mjs';

// Ids of everything an op touched, so the page can flash them.
function changedIds(result) {
  return [result.node?.id, result.edge?.id, result.section?.id, ...(result.changed ?? [])].filter(Boolean);
}

export class BoardStore {
  constructor(file) {
    this.paths = boardPaths(file);
    this.file = this.paths.board;
    this.listeners = new Set();
    this.board = this.#load();
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
    const result = applyOp(this.board, op, author);
    this.board.version += 1;
    this.#save();
    this.emit({ type: 'board', board: this.board, op: op.type, author, changed: changedIds(result) });
    return result;
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
