import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { PeopleStore } from './people.js';

const Trigger = z.discriminatedUnion('type', [
  /** Before a new guest can chat (person gates: when the claim is approved). */
  z.object({ type: z.literal('session_start') }),
  /** Once the guest has sent `count` messages. */
  z.object({ type: z.literal('after_messages'), count: z.number().int().positive() }),
  /** Offered to break a curse (Phase 6). */
  z.object({ type: z.literal('curse_break') }),
  /** When a guest reaches this secrets-game level (2 and up); blocks chat until passed. */
  z.object({ type: z.literal('secret_level'), level: z.number().int().positive() }),
  /** Only when the admin forces it. */
  z.object({ type: z.literal('admin_forced') }),
  /** At `at`, for every live session, until `deadline_minutes` later. */
  z.object({
    type: z.literal('timed_global'),
    at: z.iso.datetime({ offset: true, local: false }),
    deadline_minutes: z.number().positive(),
  }),
]);

export type GateTrigger = z.infer<typeof Trigger>;

/** photo: the guest sends a photo of `target`. text: the guest writes, in the chat, a message that does `target`. */
export const GATE_KINDS = ['photo', 'text'] as const;
export type GateKind = (typeof GATE_KINDS)[number];

export const GATE_ID = /^[a-z0-9][a-z0-9-]{0,47}$/;

const GateDefSchema = z.object({
  id: z.string().regex(GATE_ID, 'lowercase letters, digits and dashes'),
  kind: z.enum(GATE_KINDS).default('photo'),
  /** Photo: what must be in it. Text: what the message must do. Used in the model's check. */
  target: z.string().trim().min(1).max(300),
  /** What SadGPT demands, in character. */
  guest_prompt: z.string().trim().min(1).max(1000),
  refusal_lines: z.array(z.string().trim().min(1).max(500)).default([]),
  points: z.number().int().min(0).default(0),
  trigger: Trigger,
});

export interface GateDef {
  /** Unique across files: "global/<id>" or "<person slug>/<id>". */
  key: string;
  id: string;
  /** Null for global gates, else the person the gate applies to. */
  personSlug: string | null;
  kind: GateKind;
  target: string;
  guestPrompt: string;
  refusalLines: string[];
  points: number;
  trigger: GateTrigger;
}

export interface GateDefSet {
  defs: GateDef[];
  /** Problems found while loading, shown in admin. */
  errors: string[];
}

export const GLOBAL_SCOPE = 'global';

/** Parses one gates.json. Invalid gates are skipped with an error; the rest still load. */
export function parseGateFile(text: string, personSlug: string | null, label: string): GateDefSet {
  const defs: GateDef[] = [];
  const errors: string[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { defs, errors: [`${label}: not valid JSON (${err instanceof Error ? err.message : String(err)})`] };
  }
  if (!Array.isArray(raw)) return { defs, errors: [`${label}: must be a JSON array of gates`] };

  const seen = new Set<string>();
  raw.forEach((item, i) => {
    const parsed = GateDefSchema.safeParse(item);
    const name = typeof (item as { id?: unknown })?.id === 'string' ? (item as { id: string }).id : `#${i + 1}`;
    if (!parsed.success) {
      errors.push(`${label} gate ${name}: ${z.prettifyError(parsed.error).replace(/\n/g, ' ')}`);
      return;
    }
    const g = parsed.data;
    if (seen.has(g.id)) {
      errors.push(`${label} gate ${g.id}: duplicate id, skipped`);
      return;
    }
    seen.add(g.id);
    defs.push({
      key: `${personSlug ?? GLOBAL_SCOPE}/${g.id}`,
      id: g.id,
      personSlug,
      kind: g.kind,
      target: g.target,
      guestPrompt: g.guest_prompt,
      refusalLines: g.refusal_lines,
      points: g.points,
      trigger: g.trigger,
    });
  });
  return { defs, errors };
}

/**
 * Reads the global gates file and every person's gates.json. Files are re-read
 * on every call (they're tiny), so edits apply without a restart, like the persona.
 */
export function loadGateDefs(gatesPath: string, people: PeopleStore): GateDefSet {
  const out: GateDefSet = { defs: [], errors: [] };
  const add = (file: string, personSlug: string | null, label: string) => {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return; // no gates is fine
      out.errors.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    const set = parseGateFile(text, personSlug, label);
    out.defs.push(...set.defs);
    out.errors.push(...set.errors);
  };
  add(gatesPath, null, path.basename(gatesPath));
  for (const p of people.list()) add(path.join(people.dir, p.slug, 'gates.json'), p.slug, `${p.slug}/gates.json`);
  return out;
}

// --- Editing ----------------------------------------------------------------

/** A gate as the admin edits it (camelCase); `id` is fixed once created. */
export interface GateDefInput {
  id: string;
  kind: GateKind;
  target: string;
  guestPrompt: string;
  refusalLines: string[];
  points: number;
  trigger: GateTrigger;
}

export class GateDefError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
  }
}

/** "global/pumpkin" -> { personSlug: null, id: "pumpkin" }. */
export function parseGateKey(key: string): { personSlug: string | null; id: string } | null {
  const i = key.indexOf('/');
  if (i <= 0) return null;
  const scope = key.slice(0, i);
  const id = key.slice(i + 1);
  if (!GATE_ID.test(id)) return null;
  return { personSlug: scope === GLOBAL_SCOPE ? null : scope, id };
}

const toJson = (g: GateDefInput) => ({
  id: g.id,
  kind: g.kind,
  target: g.target,
  guest_prompt: g.guestPrompt,
  refusal_lines: g.refusalLines,
  points: g.points,
  trigger: g.trigger,
});

const writeAtomic = (file: string, content: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
};

/**
 * Gate definitions on disk, edited from admin: the global file (seeded once from
 * the shipped one, like personas) and each person's gates.json. Edits change the
 * raw JSON in place, so an entry that doesn't parse is kept as it is.
 * Gates already handed out keep their own copy and never change.
 */
export class GateDefStore {
  constructor(
    readonly gatesPath: string,
    private readonly people: PeopleStore,
    /** The shipped gates.json; null or the same file: nothing to seed or restore. */
    readonly seedPath: string | null = null,
  ) {}

  /** First start: copies the shipped gates in. Returns whether it did. */
  seed(): boolean {
    if (!this.seedPath || path.resolve(this.seedPath) === path.resolve(this.gatesPath)) return false;
    if (fs.existsSync(this.gatesPath) || !fs.existsSync(this.seedPath)) return false;
    fs.mkdirSync(path.dirname(this.gatesPath), { recursive: true });
    fs.copyFileSync(this.seedPath, this.gatesPath);
    return true;
  }

  load(): GateDefSet {
    return loadGateDefs(this.gatesPath, this.people);
  }

  /** The shipped global gates (for "add back" and "reset" in admin). */
  shipped(): GateDef[] {
    if (!this.seedPath || path.resolve(this.seedPath) === path.resolve(this.gatesPath)) return [];
    try {
      return parseGateFile(fs.readFileSync(this.seedPath, 'utf8'), null, 'shipped gates.json').defs;
    } catch {
      return [];
    }
  }

  create(personSlug: string | null, input: GateDefInput): GateDef {
    const json = this.check(input);
    const items = this.read(personSlug);
    if (items.some((it) => idOf(it) === json.id)) {
      throw new GateDefError(`There is already a gate "${json.id}" ${personSlug ? 'for that person' : 'for everyone'}.`, 409);
    }
    this.write(personSlug, [...items, json]);
    return this.get(personSlug, json.id)!;
  }

  /** Changes a gate; a different `personSlug` moves it to that person (or to everyone). */
  update(key: string, personSlug: string | null, input: Omit<GateDefInput, 'id'>): GateDef {
    const from = this.locate(key);
    const json = this.check({ ...input, id: from.id });
    if (from.personSlug === personSlug) {
      const items = this.read(personSlug);
      this.write(personSlug, items.map((it) => (idOf(it) === from.id ? json : it)));
    } else {
      const target = this.read(personSlug);
      if (target.some((it) => idOf(it) === from.id)) {
        throw new GateDefError(`There is already a gate "${from.id}" ${personSlug ? 'for that person' : 'for everyone'}.`, 409);
      }
      this.write(personSlug, [...target, json]);
      this.write(from.personSlug, this.read(from.personSlug).filter((it) => idOf(it) !== from.id));
    }
    return this.get(personSlug, from.id)!;
  }

  delete(key: string): void {
    const { personSlug, id } = this.locate(key);
    this.write(personSlug, this.read(personSlug).filter((it) => idOf(it) !== id));
  }

  /** Puts a shipped gate back for everyone, as shipped (replacing an edited one). */
  restore(id: string): GateDef {
    const def = this.shipped().find((d) => d.id === id);
    if (!def) throw new GateDefError('No shipped gate with that id.', 404);
    const json = toJson(def);
    const items = this.read(null);
    const exists = items.some((it) => idOf(it) === id);
    this.write(null, exists ? items.map((it) => (idOf(it) === id ? json : it)) : [...items, json]);
    return this.get(null, id)!;
  }

  private get(personSlug: string | null, id: string): GateDef | undefined {
    return this.load().defs.find((d) => d.personSlug === personSlug && d.id === id);
  }

  private locate(key: string): { personSlug: string | null; id: string } {
    const k = parseGateKey(key);
    if (!k || !this.read(k.personSlug).some((it) => idOf(it) === k.id)) throw new GateDefError('No such gate.', 404);
    return k;
  }

  private check(input: GateDefInput) {
    const parsed = GateDefSchema.safeParse(toJson(input));
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new GateDefError(issue ? `${issue.path.join('.') || 'gate'}: ${issue.message}` : 'Invalid gate');
    }
    const g = parsed.data;
    return toJson({ ...g, guestPrompt: g.guest_prompt, refusalLines: g.refusal_lines });
  }

  private fileFor(personSlug: string | null): string {
    if (personSlug === null) return this.gatesPath;
    if (!this.people.get(personSlug)) throw new GateDefError('No such person.', 404);
    return path.join(this.people.dir, personSlug, 'gates.json');
  }

  /** The file's raw entries; a missing file is empty. A file that isn't a JSON array can't be edited here. */
  private read(personSlug: string | null): unknown[] {
    const file = this.fileFor(personSlug);
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new GateDefError(`${path.basename(path.dirname(file))}/${path.basename(file)} is not valid JSON; fix it by hand first.`, 409);
    }
    if (!Array.isArray(raw)) throw new GateDefError(`${file} must be a JSON array; fix it by hand first.`, 409);
    return raw;
  }

  private write(personSlug: string | null, items: unknown[]): void {
    writeAtomic(this.fileFor(personSlug), `${JSON.stringify(items, null, 2)}\n`);
  }
}

const idOf = (item: unknown) => (typeof (item as { id?: unknown })?.id === 'string' ? (item as { id: string }).id : null);
