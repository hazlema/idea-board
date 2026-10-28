// The global role library: shared rules plus the roles an agent can play.
// It lives in the user's config directory, so every board shares it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OpError } from '../board.mjs';
import { PROMPT_NAMES, defaults } from '../defaults.mjs';

export function configDir(platform = process.platform, env = process.env, home = os.homedir()) {
  if (platform === 'win32') return env.APPDATA || path.win32.join(home, 'AppData', 'Roaming');
  if (platform === 'darwin') return path.posix.join(home, 'Library', 'Application Support');
  return env.XDG_CONFIG_HOME || path.posix.join(home, '.config');
}

export const libraryFile = () => path.join(configDir(), 'idea-board', 'colab.json');

const MAX_TEXT = 20000;

// A fresh copy of the shipped defaults, in the library's shape.
export function defaultLibrary() {
  const { shared, roles, prompts } = defaults();
  return structuredClone({ rules: shared, roles, prompts });
}

const filled = (value) => typeof value === 'string' && value.trim() !== '';

// Whatever the library is missing comes from the defaults. An old file's passes move into
// prompts; a missing or blank prompt is the default, since every agent needs one.
export function fillLibrary(raw) {
  const base = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const start = defaultLibrary();
  const own = base.prompts && typeof base.prompts === 'object' ? base.prompts : {};
  const old = base.passes && typeof base.passes === 'object' ? base.passes : {};
  const prompts = Object.fromEntries(PROMPT_NAMES.map((name) => {
    const mine = [own[name], old[name]].find(filled);
    return [name, mine ?? start.prompts[name]];
  }));
  const library = {
    rules: typeof base.rules === 'string' ? base.rules : start.rules,
    roles: Array.isArray(base.roles) && base.roles.length ? base.roles : start.roles,
    prompts,
  };
  return { library, changed: JSON.stringify(library) !== JSON.stringify(raw) };
}

function validatePrompts(prompts) {
  if (prompts === undefined) return undefined;
  if (!prompts || typeof prompts !== 'object' || Array.isArray(prompts)) throw new OpError('prompts must be an object');
  for (const [name, text] of Object.entries(prompts)) {
    if (!PROMPT_NAMES.includes(name)) throw new OpError(`unknown prompt "${name}"`);
    if (typeof text !== 'string') throw new OpError(`${name} text must be a string`);
    if (text.length > MAX_TEXT) throw new OpError(`${name} text is longer than ${MAX_TEXT} characters`);
  }
  return prompts;
}

function validate(input) {
  if (!input || typeof input !== 'object') throw new OpError('library must be an object');
  const { rules, roles } = input;
  if (typeof rules !== 'string') throw new OpError('rules must be a string');
  if (rules.length > MAX_TEXT) throw new OpError(`rules is longer than ${MAX_TEXT} characters`);
  if (!Array.isArray(roles) || roles.length < 1 || roles.length > 20) throw new OpError('roles must be a list of 1 to 20 roles');
  const seen = new Set();
  const clean = roles.map((role) => {
    if (!role || typeof role !== 'object') throw new OpError('each role must be an object');
    const { id, name, job } = role;
    if (typeof id !== 'string' || !/^[a-z0-9-]{1,40}$/.test(id)) throw new OpError(`role id "${id}" must be 1 to 40 characters of a-z, 0-9 and -`);
    if (seen.has(id)) throw new OpError(`duplicate role id "${id}"`);
    seen.add(id);
    if (typeof name !== 'string' || !name.trim()) throw new OpError(`role ${id}: name must not be empty`);
    if (name.length > 80) throw new OpError(`role ${id}: name is longer than 80 characters`);
    if (typeof job !== 'string') throw new OpError(`role ${id}: job must be a string`);
    if (job.length > MAX_TEXT) throw new OpError(`role ${id}: job is longer than ${MAX_TEXT} characters`);
    if (role.pictures !== undefined && typeof role.pictures !== 'boolean') throw new OpError(`role ${id}: pictures must be true or false`);
    return role.pictures ? { id, name, job, pictures: true } : { id, name, job };
  });
  const prompts = validatePrompts(input.prompts);
  return prompts ? { rules, roles: clean, prompts } : { rules, roles: clean };
}

export class Library {
  constructor(file) {
    this.file = file;
  }

  // The user's library, with anything missing filled from the defaults (and written back).
  get() {
    const raw = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : null;
    const { library, changed } = fillLibrary(raw);
    return changed ? this.#write(library) : library;
  }

  // A save that leaves out prompts keeps the stored ones.
  save(input) {
    const library = validate(input);
    return this.#write(fillLibrary({ ...library, prompts: library.prompts ?? this.get().prompts }).library);
  }

  #write(library) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(library, null, 2)}\n`);
    fs.renameSync(tmp, this.file);
    return library;
  }
}
