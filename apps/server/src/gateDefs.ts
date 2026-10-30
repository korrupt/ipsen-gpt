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

const GateDefSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,47}$/, 'lowercase letters, digits and dashes'),
  /** What must be in the photo; used in the verification prompt. */
  target: z.string().trim().min(1).max(200),
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
