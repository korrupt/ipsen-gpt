import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import { slugify } from './people.js';
import type { Session } from './sessions.js';
import type { Settings } from './settings.js';

export interface Persona {
  /** The file name without `.md`, e.g. "sadgpt". */
  id: string;
  name: string;
  /** One line for the admin dropdown. */
  description: string;
  /** The character: voice, quirks, examples. */
  body: string;
}

export interface PersonaInput {
  name: string;
  description: string;
  body: string;
}

export const PERSONA_ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
/** Shared by every persona and put first in the prompt: length, safety, language, points. */
export const RULES_FILE = '_rules.md';
const TRASH_DIR = '.trash';
/** Taken by the admin routes /personas/active and /personas/rules. */
const RESERVED_IDS = new Set(['active', 'rules']);

export const LIMITS = { name: 60, description: 200, body: 20_000, rules: 20_000 } as const;

// An empty `description:` is null in YAML; treat it as no description.
const Frontmatter = z.object({
  name: z.string().trim().min(1),
  description: z
    .string()
    .trim()
    .nullish()
    .transform((v) => v ?? ''),
});

export class PersonaError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
  }
}

export function parsePersonaFile(id: string, text: string): Persona {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) throw new PersonaError('missing frontmatter (--- name: ... ---)');
  const fm = Frontmatter.safeParse(YAML.parse(match[1]!) ?? {});
  if (!fm.success) throw new PersonaError(`bad frontmatter: ${z.prettifyError(fm.error)}`);
  const body = match[2]!.trim();
  if (!body) throw new PersonaError('the character text is empty');
  return { id, name: fm.data.name, description: fm.data.description, body };
}

export function serializePersona(p: PersonaInput): string {
  const fm = YAML.stringify({ name: p.name, description: p.description }).trimEnd();
  return `---\n${fm}\n---\n${p.body.trim()}\n`;
}

function writeAtomic(file: string, content: string) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

/** Every persona file in `dir`, sorted by name, plus the ones that failed to load. */
function readDir(dir: string): { personas: Persona[]; errors: string[] } {
  const personas: Persona[] = [];
  const errors: string[] = [];
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.md') && f !== RULES_FILE);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { personas, errors };
    return { personas, errors: [`${dir}: ${err instanceof Error ? err.message : String(err)}`] };
  }
  for (const file of files.sort()) {
    const id = file.slice(0, -3);
    if (!PERSONA_ID.test(id)) {
      errors.push(`${file}: file name must be lowercase letters, digits and dashes`);
      continue;
    }
    try {
      personas.push(parsePersonaFile(id, fs.readFileSync(path.join(dir, file), 'utf8')));
    } catch (err) {
      errors.push(`${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  personas.sort((a, b) => a.name.localeCompare(b.name, 'nb'));
  return { personas, errors };
}

/**
 * Personas are files in `dir` (`<id>.md`), editable in admin and re-read on every
 * use, so edits apply without a restart. `dir` is party data (a volume in
 * production); `seedDir` holds the defaults shipped with the app, copied in when
 * `dir` has no personas yet and available to restore one by one.
 * Which persona a guest gets: their session's own, else the global one the admin
 * picked, else `defaultId`.
 */
export class PersonaStore {
  constructor(
    readonly dir: string,
    private readonly defaultId: string,
    private readonly settings: Settings,
    readonly seedDir: string | null = null,
  ) {}

  /** First run: copies the shipped defaults (and the shared rules) into an empty folder. */
  seed(): string[] {
    if (!this.seedDir || this.seedDir === this.dir) return [];
    fs.mkdirSync(this.dir, { recursive: true });
    if (readDir(this.dir).personas.length > 0) return [];
    const copied: string[] = [];
    for (const file of fs.existsSync(this.seedDir) ? fs.readdirSync(this.seedDir) : []) {
      if (!file.endsWith('.md') || fs.existsSync(path.join(this.dir, file))) continue;
      fs.copyFileSync(path.join(this.seedDir, file), path.join(this.dir, file));
      copied.push(file);
    }
    return copied;
  }

  /** All personas, sorted by name, plus files that failed to load. */
  load(): { personas: Persona[]; errors: string[] } {
    return readDir(this.dir);
  }

  /** The shipped defaults, for "add" and "reset to default" in admin. */
  defaults(): Persona[] {
    return this.seedDir && this.seedDir !== this.dir ? readDir(this.seedDir).personas : [];
  }

  get(id: string): Persona | undefined {
    if (!PERSONA_ID.test(id)) return undefined;
    try {
      return parsePersonaFile(id, fs.readFileSync(path.join(this.dir, `${id}.md`), 'utf8'));
    } catch {
      return undefined;
    }
  }

  /** The global persona's id: the admin's pick if it still exists, else the default. */
  activeId(): string {
    const picked = this.settings.get('personaId');
    return picked && this.get(picked) ? picked : this.defaultId;
  }

  setActive(id: string | null): void {
    if (id !== null && !this.get(id)) throw new PersonaError('No such persona.', 404);
    this.settings.set('personaId', id);
  }

  // --- Editing --------------------------------------------------------------

  /** Creates (no id; the id comes from the name) or updates a persona. */
  save(input: PersonaInput, id?: string): Persona {
    const clean = this.check(input);
    if (id !== undefined) {
      if (!this.get(id)) throw new PersonaError('No such persona.', 404);
    } else {
      const base = slugify(clean.name).slice(0, 40);
      id = base;
      for (let i = 2; RESERVED_IDS.has(id) || fs.existsSync(path.join(this.dir, `${id}.md`)); i++) id = `${base}-${i}`;
    }
    fs.mkdirSync(this.dir, { recursive: true });
    writeAtomic(path.join(this.dir, `${id}.md`), serializePersona(clean));
    return this.get(id)!;
  }

  /** Moves the file to .trash/ rather than deleting it, in case of a mis-tap. The last one can't go. */
  delete(id: string): void {
    if (!this.get(id)) throw new PersonaError('No such persona.', 404);
    if (this.load().personas.length <= 1) throw new PersonaError("That's the last persona; SadGPT needs at least one.", 409);
    const trash = path.join(this.dir, TRASH_DIR);
    fs.mkdirSync(trash, { recursive: true });
    fs.renameSync(path.join(this.dir, `${id}.md`), path.join(trash, `${id}-${Date.now()}.md`));
  }

  /** Puts back the shipped version of a default persona, adding it if it was deleted. */
  restoreDefault(id: string): Persona {
    const original = this.defaults().find((p) => p.id === id);
    if (!original) throw new PersonaError('No shipped default with that id.', 404);
    fs.mkdirSync(this.dir, { recursive: true });
    writeAtomic(path.join(this.dir, `${id}.md`), serializePersona(original));
    return this.get(id)!;
  }

  rules(): string {
    try {
      return fs.readFileSync(path.join(this.dir, RULES_FILE), 'utf8').trim();
    } catch {
      return '';
    }
  }

  /** The shared rules; empty is allowed (each persona then carries its own). */
  saveRules(text: string): string {
    const clean = text.trim();
    if (clean.length > LIMITS.rules) throw new PersonaError(`Keep the rules under ${LIMITS.rules} characters.`);
    fs.mkdirSync(this.dir, { recursive: true });
    writeAtomic(path.join(this.dir, RULES_FILE), clean ? `${clean}\n` : '');
    return this.rules();
  }

  // --- Prompts --------------------------------------------------------------

  /** The persona a session gets right now. Throws if none can be loaded. */
  resolve(session: Pick<Session, 'personaId'> | null): Persona {
    const candidates = [session?.personaId, this.settings.get('personaId'), this.defaultId];
    for (const id of candidates) {
      const p = id ? this.get(id) : undefined;
      if (p) return p;
    }
    const first = this.load().personas[0];
    if (first) return first;
    throw new PersonaError(`No usable persona in ${this.dir}`);
  }

  /**
   * The system prompt's start for a session: the shared rules, then the character.
   * `custom` (a persona written for the person this session belongs to) is used
   * unless the session has its own persona picked.
   */
  promptFor(session: Pick<Session, 'personaId'> | null, custom: string | null = null): string {
    const rules = this.rules();
    const body = custom && !session?.personaId ? custom : this.resolve(session).body;
    return rules ? `${rules}\n\n${body}` : body;
  }

  private check(input: PersonaInput): PersonaInput {
    const name = input.name.trim();
    const description = input.description.trim().replace(/\s+/g, ' ');
    const body = input.body.trim();
    if (!name) throw new PersonaError('Give the persona a name.');
    if (name.length > LIMITS.name) throw new PersonaError(`Keep the name under ${LIMITS.name} characters.`);
    if (description.length > LIMITS.description) throw new PersonaError(`Keep the description under ${LIMITS.description} characters.`);
    if (!body) throw new PersonaError('Describe the character.');
    if (body.length > LIMITS.body) throw new PersonaError(`Keep the character under ${LIMITS.body} characters.`);
    return { name, description, body };
  }
}
