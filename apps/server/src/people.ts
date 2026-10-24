import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import { cleanName, nameKey, validateName } from './names.js';

export interface Person {
  slug: string;
  /** Display name; also a reserved name. */
  name: string;
  /** Other reserved names that claim this person. */
  aliases: string[];
  /** Markdown body fed to the model once the claim is approved. */
  info: string;
}

export interface PersonInput {
  name: string;
  aliases: string[];
  info: string;
}

export class PeopleError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
  }
}

export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/;
const PERSON_FILE = 'person.md';
const GATES_FILE = 'gates.json';
const TRASH_DIR = '.trash';

const Frontmatter = z.object({
  name: z.string().min(1),
  aliases: z.array(z.string()).default([]),
});

export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/æ/g, 'ae')
    .replace(/ø/g, 'o')
    .replace(/å/g, 'a')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return slug || 'person';
}

export function parsePersonFile(slug: string, text: string): Person {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) throw new PeopleError('missing frontmatter (--- name: ... ---)');
  const fm = Frontmatter.safeParse(YAML.parse(match[1]!) ?? {});
  if (!fm.success) throw new PeopleError(`bad frontmatter: ${z.prettifyError(fm.error)}`);
  return {
    slug,
    name: cleanName(fm.data.name),
    aliases: fm.data.aliases.map(cleanName).filter(Boolean),
    info: match[2]!.trim(),
  };
}

export function serializePerson(p: PersonInput): string {
  const fm = YAML.stringify({ name: p.name, aliases: p.aliases }).trimEnd();
  return `---\n${fm}\n---\n\n${p.info.trim()}\n`;
}

function writeAtomic(file: string, content: string) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

/**
 * Person folders on disk are the source of truth:
 *   <dir>/<slug>/person.md   frontmatter (name, aliases) + info
 *   <dir>/<slug>/gates.json  this person's custom gates (Phase 4)
 */
export class PeopleStore {
  private people = new Map<string, Person>();
  private reserved = new Map<string, string>(); // name key -> slug
  /** Problems found while loading, shown in admin. */
  errors: string[] = [];

  constructor(readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true });
    this.load();
  }

  load(): void {
    const people = new Map<string, Person>();
    const reserved = new Map<string, string>();
    const errors: string[] = [];

    // Sorted so that on a name clash, the alphabetically first folder wins, every time.
    const entries = fs.readdirSync(this.dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const slug = entry.name;
      if (!SLUG_PATTERN.test(slug)) {
        errors.push(`${slug}: folder name must be lowercase letters, digits and dashes`);
        continue;
      }
      const file = path.join(this.dir, slug, PERSON_FILE);
      let person: Person;
      try {
        person = parsePersonFile(slug, fs.readFileSync(file, 'utf8'));
      } catch (err) {
        errors.push(`${slug}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      const keys = [...new Set([person.name, ...person.aliases].map(nameKey))];
      const clash = keys.find((k) => reserved.has(k));
      if (clash) {
        errors.push(`${slug}: name "${clash}" is already used by ${reserved.get(clash)}, skipped`);
        continue;
      }
      keys.forEach((k) => reserved.set(k, slug));
      people.set(slug, person);
    }

    this.people = new Map([...people].sort(([, a], [, b]) => a.name.localeCompare(b.name, 'nb')));
    this.reserved = reserved;
    this.errors = errors;
  }

  list(): Person[] {
    return [...this.people.values()];
  }

  get(slug: string): Person | undefined {
    return this.people.get(slug);
  }

  /** The person whose name or alias matches, if the name is reserved. */
  findByName(name: string): Person | undefined {
    const slug = this.reserved.get(nameKey(name));
    return slug ? this.people.get(slug) : undefined;
  }

  /** Creates (no slug) or updates a person. Returns the saved person. */
  save(input: PersonInput, slug?: string): Person {
    const clean: PersonInput = {
      name: cleanName(input.name),
      aliases: [...new Set(input.aliases.map(cleanName).filter(Boolean))],
      info: input.info.trim(),
    };
    for (const n of [clean.name, ...clean.aliases]) {
      const err = validateName(n);
      if (err) throw new PeopleError(`"${n}": ${err}`);
    }

    if (slug !== undefined) {
      if (!this.people.has(slug)) throw new PeopleError('No such person.', 404);
    } else {
      const base = slugify(clean.name);
      slug = base;
      for (let i = 2; this.people.has(slug) || fs.existsSync(path.join(this.dir, slug)); i++) slug = `${base}-${i}`;
    }

    for (const n of [clean.name, ...clean.aliases]) {
      const owner = this.reserved.get(nameKey(n));
      if (owner && owner !== slug) {
        throw new PeopleError(`"${n}" is already used by ${this.people.get(owner)?.name ?? owner}.`, 409);
      }
    }

    const folder = path.join(this.dir, slug);
    fs.mkdirSync(folder, { recursive: true });
    writeAtomic(path.join(folder, PERSON_FILE), serializePerson(clean));
    const gates = path.join(folder, GATES_FILE);
    if (!fs.existsSync(gates)) writeAtomic(gates, '[]\n');

    this.load();
    const saved = this.people.get(slug);
    if (!saved) throw new PeopleError(`Saved, but failed to reload: ${this.errors.find((e) => e.startsWith(slug!))}`);
    return saved;
  }

  /** Moves the folder to .trash/ rather than deleting it, in case of a mis-tap. */
  delete(slug: string): void {
    if (!SLUG_PATTERN.test(slug) || !this.people.has(slug)) throw new PeopleError('No such person.', 404);
    const trash = path.join(this.dir, TRASH_DIR);
    fs.mkdirSync(trash, { recursive: true });
    fs.renameSync(path.join(this.dir, slug), path.join(trash, `${slug}-${Date.now()}`));
    this.load();
  }
}
