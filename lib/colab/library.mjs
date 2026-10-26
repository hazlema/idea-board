// The global role library: shared rules plus the roles an agent can play.
// It lives in the user's config directory, so every board shares it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OpError } from '../board.mjs';
import { DEFAULT_AUDIT_TEXT } from '../audit.mjs';
import { PRUNE_SYSTEM_PROMPT } from '../prune.mjs';

export function configDir(platform = process.platform, env = process.env, home = os.homedir()) {
  if (platform === 'win32') return env.APPDATA || path.win32.join(home, 'AppData', 'Roaming');
  if (platform === 'darwin') return path.posix.join(home, 'Library', 'Application Support');
  return env.XDG_CONFIG_HOME || path.posix.join(home, '.config');
}

export const libraryFile = () => path.join(configDir(), 'idea-board', 'colab.json');

export const DEFAULT_LIBRARY = {
  rules: `Every turn must contribute at least one meaningful creative idea. This may be
a new mechanic, character, ability, interaction, or an unexpected combination
of existing mechanics. The agent may also remove or combine existing elements
if doing so creates a more interesting gameplay experience.

Numerical tuning and balance corrections may accompany the creative
contribution, but cannot be its sole purpose.

Prioritize ideas that interact with existing systems over isolated additions.
Remember the game must be fun, compelling and mildly addictive!`,
  roles: [
    {
      id: 'creative',
      name: 'Creative Director & Lore',
      job: 'You own the vision: theme, tone, world, characters and story, and above all the hook that makes this fun, compelling and mildly addictive. You push for bold, surprising ideas and make sure mechanics and lore feed each other.',
    },
    {
      id: 'qa',
      name: 'QA & Playtester',
      job: "You play the game in your head as a real player would. Find what is boring, confusing, exploitable or not worth the effort, and say so plainly. For every problem you raise, offer a fix that keeps or adds fun. You are the one most willing to cut or merge ideas (with rule_out and a reason).",
    },
    {
      id: 'foreman',
      name: 'Foreman',
      job: "You keep the design coherent and moving. Merge duplicates, settle contradictions, keep the Brief to current decisions only (rewrite it, don't append logs), and keep the board tidy. You take the last turn of each round: end your message with a score from 1 to 10 for coherence, novelty, feasibility and likely fun, plus the one thing the next round should focus on.",
    },
    {
      id: 'systems',
      name: 'Systems Designer',
      job: 'You design the core mechanics and how they interact: loops, progression, economy and risk versus reward. You prefer systems that create interesting decisions over rules that only add detail.',
    },
  ],
};

const MAX_TEXT = 20000;

// The editable pass texts, and what a pass uses when the library has none of its own.
export const PASS_DEFAULTS = { audit: DEFAULT_AUDIT_TEXT, prune: PRUNE_SYSTEM_PROMPT };
export const passText = (library, name) => library.passes?.[name]?.trim() ? library.passes[name] : PASS_DEFAULTS[name];

function validatePasses(passes) {
  if (passes === undefined) return undefined;
  if (!passes || typeof passes !== 'object' || Array.isArray(passes)) throw new OpError('passes must be an object');
  const clean = {};
  for (const [name, text] of Object.entries(passes)) {
    if (!Object.hasOwn(PASS_DEFAULTS, name)) throw new OpError(`unknown pass "${name}"`);
    if (typeof text !== 'string') throw new OpError(`${name} text must be a string`);
    if (text.length > MAX_TEXT) throw new OpError(`${name} text is longer than ${MAX_TEXT} characters`);
    if (text.trim()) clean[name] = text;
  }
  return Object.keys(clean).length ? clean : undefined;
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
  const passes = validatePasses(input.passes);
  return passes ? { rules, roles: clean, passes } : { rules, roles: clean };
}

export class Library {
  constructor(file) {
    this.file = file;
  }

  get() {
    if (!fs.existsSync(this.file)) return this.#write(structuredClone(DEFAULT_LIBRARY));
    return JSON.parse(fs.readFileSync(this.file, 'utf8'));
  }

  save(input) {
    return this.#write(validate(input));
  }

  #write(library) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(library, null, 2)}\n`);
    fs.renameSync(tmp, this.file);
    return library;
  }
}
