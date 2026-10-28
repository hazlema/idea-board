// Files the host attaches in the chat (playtest logs and the like) live beside the
// board (<base>.files/) under their own names. Agents read them with read_attachment.
import fs from 'node:fs';
import path from 'node:path';
import { OpError } from './board.mjs';

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_NAME = 100;
const CHUNK_LINES = 500;
const CHUNK_CHARS = 40000;
// Starts and ends with a letter or digit, so no name can climb out of the folder.
export const FILE_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/;
const EXTENSION = /\.[A-Za-z0-9]{1,10}$/;

const trimEnds = (name) => name.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '');

// What a file the browser sent is stored as: its own name, made safe.
export function safeName(name) {
  const base = String(name).split(/[\\/]/).pop();
  const safe = trimEnds(base.replace(/[^A-Za-z0-9._-]+/g, '-')) || 'attachment';
  if (safe.length <= MAX_NAME) return safe;
  const ext = safe.match(EXTENSION)?.[0] ?? '';
  return trimEnds(safe.slice(0, MAX_NAME - ext.length)) + ext;
}

export class FileStore {
  constructor(dir) {
    this.dir = dir;
  }

  // Absolute path of an attachment; the only way a name becomes a path.
  resolve(name) {
    if (typeof name !== 'string' || !FILE_NAME.test(name)) throw new OpError('not an attachment name');
    return path.join(this.dir, name);
  }

  // Stores a text file and returns the name it got: `name`, or name-2, name-3… when taken.
  save(name, buf) {
    if (buf.length > MAX_FILE_BYTES) throw Object.assign(new OpError('file is larger than 10 MB'), { status: 413 });
    if (buf.includes(0)) throw new OpError('not a text file (attach logs and other plain text)');
    const wanted = safeName(name);
    const ext = wanted.match(EXTENSION)?.[0] ?? '';
    const stem = wanted.slice(0, wanted.length - ext.length);
    fs.mkdirSync(this.dir, { recursive: true });
    for (let n = 1; ; n += 1) {
      const suffix = n === 1 ? '' : `-${n}`;
      const candidate = `${trimEnds(stem.slice(0, MAX_NAME - ext.length - suffix.length))}${suffix}${ext}`;
      try {
        fs.writeFileSync(this.resolve(candidate), buf, { flag: 'wx' });
        return candidate;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
    }
  }

  list() {
    if (!fs.existsSync(this.dir)) return [];
    return fs.readdirSync(this.dir).filter((name) => FILE_NAME.test(name)).sort()
      .map((name) => ({ name, bytes: fs.statSync(path.join(this.dir, name)).size }));
  }

  // Up to CHUNK_LINES lines (and CHUNK_CHARS characters) from line `from` on, counting from 1.
  read(name, from = 1) {
    let content;
    try {
      content = fs.readFileSync(this.resolve(name), 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') throw new OpError(`no attachment called ${name}`);
      throw error;
    }
    const lines = content.split(/\r?\n/);
    if (lines.length > 1 && lines.at(-1) === '') lines.pop();
    const start = Math.max(1, Math.floor(Number(from)) || 1);
    if (start > lines.length) throw new OpError(`${name} has only ${lines.length} lines`);
    const taken = [];
    let size = 0;
    for (let i = start - 1; i < lines.length && taken.length < CHUNK_LINES; i += 1) {
      const line = lines[i];
      if (!taken.length && line.length > CHUNK_CHARS) {
        taken.push(line.slice(0, CHUNK_CHARS));
        break;
      }
      size += line.length + (taken.length ? 1 : 0);
      if (size > CHUNK_CHARS) break;
      taken.push(line);
    }
    const to = start + taken.length - 1;
    return {
      name,
      total_lines: lines.length,
      from_line: start,
      to_line: to,
      text: taken.join('\n'),
      ...(to < lines.length ? { more: `Call read_attachment again with from_line ${to + 1} for the rest.` } : {}),
    };
  }
}
