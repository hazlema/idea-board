// The starting texts: defaults.json, shipped with the app. It fills whatever the user's own
// library is missing, and Reset to default puts its text back.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const DEFAULTS_FILE = fileURLToPath(new URL('../defaults.json', import.meta.url));
export const PROMPT_NAMES = ['chat', 'turn', 'answer', 'audit', 'prune'];

const TEXTS = ['shared', ...PROMPT_NAMES];
const MAX_TEXT = 20000;
const MAX_NAME = 80;
const MAX_ROLES = 20;

// The first word of the name, made safe for an id; a clash gets -2, -3…
export function roleId(name, taken) {
  const base = (name.toLowerCase().match(/[a-z0-9]+/)?.[0] ?? 'role').slice(0, 37);
  let id = base;
  for (let n = 2; taken.has(id); n += 1) id = `${base}-${n}`;
  return id;
}

export function readDefaults(file) {
  const fail = (why) => { throw new Error(`${file}: ${why}`); };
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  } catch (error) {
    fail(`can't read it (${error.message})`);
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    fail(`not valid JSON (${error.message})`);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) fail('must be an object');
  for (const key of Object.keys(data)) if (key !== 'roles' && !TEXTS.includes(key)) fail(`unknown key "${key}"`);
  const text = (key, value) => {
    if (value === undefined) fail(`${key} is missing`);
    if (typeof value !== 'string' || !value.trim()) fail(`${key} must not be empty`);
    if (value.length > MAX_TEXT) fail(`${key} is longer than ${MAX_TEXT} characters`);
    return value;
  };
  for (const key of TEXTS) text(key, data[key]);
  const { roles } = data;
  const entries = roles && typeof roles === 'object' && !Array.isArray(roles) ? Object.entries(roles) : [];
  if (entries.length < 1 || entries.length > MAX_ROLES) fail(`roles must list 1 to ${MAX_ROLES} roles`);
  const taken = new Set();
  return {
    shared: data.shared,
    roles: entries.map(([name, job]) => {
      if (!name.trim()) fail('a role name must not be empty');
      if (name.length > MAX_NAME) fail(`role "${name}": name is longer than ${MAX_NAME} characters`);
      text(`role "${name}"`, job);
      const id = roleId(name, taken);
      taken.add(id);
      return { id, name, job };
    }),
    prompts: Object.fromEntries(PROMPT_NAMES.map((name) => [name, data[name]])),
  };
}

let cached = null;

// The shipped defaults (or IDEA_BOARD_DEFAULTS, for tests), read once.
export function defaults() {
  cached ??= readDefaults(process.env.IDEA_BOARD_DEFAULTS || DEFAULTS_FILE);
  return cached;
}
