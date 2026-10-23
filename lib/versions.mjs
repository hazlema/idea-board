// Saved versions: named snapshots of the board's content (title, brief,
// flowchart, brainstorm), one JSON file each in <board>.versions/. Memory
// (ruled-out list, chat, history) is not part of a version.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const CONTENT_KEYS = ['title', 'brief', 'flow', 'brainstorm'];
const ID_FORMAT = /^v_\d{8}-\d{6}_[0-9a-f]{4}$/;

const notFound = (id) => Object.assign(new Error(`no saved version ${id}`), { status: 404 });

// What a version holds, copied out of a board.
export function versionContent(board) {
  return structuredClone(Object.fromEntries(CONTENT_KEYS.map((key) => [key, board[key]])));
}

// Counts shown beside a version. `entries` counts every entry, ruled-out ones included.
function statsOf(content) {
  const objects = content.brainstorm.pages.flatMap((page) => page.objects);
  const groups = objects.filter((o) => o.kind === 'group');
  return {
    groups: groups.length,
    entries: groups.reduce((total, g) => total + g.entries.length, 0),
    notes: objects.filter((o) => o.kind === 'note').length,
    pictures: objects.filter((o) => o.kind === 'picture').length,
    cards: content.flow.nodes.length,
  };
}

export class VersionStore {
  #dir;
  #now;
  #lastAt = 0;

  constructor(dir, { now = Date.now } = {}) {
    this.#dir = dir;
    this.#now = now;
  }

  // Timestamps never repeat or go backwards, so "newest first" is stable
  // even when two versions are saved in the same millisecond.
  #tick() {
    this.#lastAt = Math.max(this.#now(), this.#lastAt + 1);
    return new Date(this.#lastAt);
  }

  save(content, { name, author, auto = false }) {
    const when = this.#tick();
    const stamp = when.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    const id = `v_${stamp}_${randomBytes(2).toString('hex')}`;
    const saved = versionContent(content);
    const meta = { id, name, at: when.toISOString(), author, auto, stats: statsOf(saved) };
    fs.mkdirSync(this.#dir, { recursive: true });
    const file = path.join(this.#dir, `${id}.json`);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ meta, content: saved }, null, 2)}\n`);
    fs.renameSync(tmp, file);
    return meta;
  }

  list() {
    let names;
    try {
      names = fs.readdirSync(this.#dir);
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    const metas = [];
    for (const name of names) {
      const id = name.replace(/\.json$/, '');
      if (name !== `${id}.json` || !ID_FORMAT.test(id)) continue;
      try {
        metas.push(this.read(id).meta);
      } catch {
        // a file that cannot be read is left out of the list
      }
    }
    return metas.sort((a, b) => (a.at === b.at ? (a.id < b.id ? 1 : -1) : a.at < b.at ? 1 : -1));
  }

  // Throws a 404 error for an unknown or malformed id (checked before
  // touching the disk so an id can never point outside the versions folder).
  read(id) {
    if (typeof id !== 'string' || !ID_FORMAT.test(id)) throw notFound(id);
    try {
      return JSON.parse(fs.readFileSync(path.join(this.#dir, `${id}.json`), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') throw notFound(id);
      throw error;
    }
  }
}
