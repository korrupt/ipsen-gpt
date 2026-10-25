import crypto from 'node:crypto';
import type { Db } from './db.js';
import type { GateDef, GateDefSet } from './gateDefs.js';

export type GateStatus = 'active' | 'passed' | 'expired' | 'cancelled';
export type GateSource = 'session_start' | 'after_messages' | 'admin_forced' | 'timed_global';

export interface Gate {
  id: string;
  sessionId: string;
  /** The definition it came from; null for a custom gate the admin typed in. */
  defKey: string | null;
  source: GateSource;
  target: string;
  guestPrompt: string;
  refusalLines: string[];
  points: number;
  status: GateStatus;
  /** How many chat messages were refused while this gate was active. */
  refusals: number;
  createdAt: number;
  deadlineAt: number | null;
  resolvedAt: number | null;
}

export class GateError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 409,
  ) {
    super(message);
  }
}

/** What a guest may see about their gate. */
export function gateView(g: Gate) {
  return { id: g.id, prompt: g.guestPrompt, deadlineAt: g.deadlineAt };
}

/** Shown when a gate has no refusal lines and the model can't make one up. */
export const DEFAULT_REFUSALS = [
  'No photo, no conversation. The spirits are very clear on this.',
  'I cannot hear you over the sound of the missing photo.',
  'Words are cheap, mortal. Pixels are not.',
];

export const VERDICT_LINES = {
  passed: 'The spirits accept your offering. You may speak again.',
  failed: 'That is not what I asked for, mortal. Try again.',
  unverified: 'My ghostly eyes are clouded right now and I cannot judge your photo. Try again in a moment.',
} as const;

interface Row {
  id: string;
  session_id: string;
  def_key: string | null;
  source: GateSource;
  target: string;
  guest_prompt: string;
  refusal_lines: string;
  points: number;
  status: GateStatus;
  refusals: number;
  created_at: number;
  deadline_at: number | null;
  resolved_at: number | null;
}

const toGate = (r: Row): Gate => ({
  id: r.id,
  sessionId: r.session_id,
  defKey: r.def_key,
  source: r.source,
  target: r.target,
  guestPrompt: r.guest_prompt,
  refusalLines: JSON.parse(r.refusal_lines) as string[],
  points: r.points,
  status: r.status,
  refusals: r.refusals,
  createdAt: r.created_at,
  deadlineAt: r.deadline_at,
  resolvedAt: r.resolved_at,
});

/** A gate to hand out: a definition, or a one-off the admin typed in. */
export type GateSpec = { def: GateDef } | { custom: { target: string; guestPrompt: string } };

/** The session facts that decide which gates apply. */
export interface GateSubject {
  id: string;
  /** Set only once a claim is approved. */
  personSlug: string | null;
}

/**
 * Gates per session. Only this class sets a gate to `passed`, and only when
 * the photo route asks it to after a verified photo. Nothing said in chat can.
 */
export class GateStore {
  constructor(
    private readonly db: Db,
    /** Current definitions (re-read from disk by the caller as it likes). */
    private readonly defs: () => GateDefSet,
    private readonly now: () => number = Date.now,
  ) {}

  // --- Lookup ---------------------------------------------------------------

  get(id: string): Gate | undefined {
    this.expire();
    const row = this.db.prepare('SELECT * FROM gates WHERE id = ?').get(id) as Row | undefined;
    return row && toGate(row);
  }

  /** The gate the guest faces now: the oldest active one. */
  current(sessionId: string): Gate | undefined {
    this.expire();
    const row = this.db
      .prepare(`SELECT * FROM gates WHERE session_id = ? AND status = 'active' ORDER BY created_at, rowid LIMIT 1`)
      .get(sessionId) as Row | undefined;
    return row && toGate(row);
  }

  /** All of a session's gates, newest first. */
  forSession(sessionId: string): Gate[] {
    this.expire();
    return (
      this.db.prepare('SELECT * FROM gates WHERE session_id = ? ORDER BY created_at DESC, rowid DESC').all(sessionId) as Row[]
    ).map(toGate);
  }

  /** Active gates on live sessions, oldest first, with the session's name. */
  activeGates(): (Gate & { sessionName: string | null })[] {
    this.expire();
    const rows = this.db
      .prepare(
        `SELECT g.*, s.name AS session_name FROM gates g JOIN sessions s ON s.id = g.session_id
         WHERE g.status = 'active' AND s.ended_at IS NULL ORDER BY g.created_at, g.rowid`,
      )
      .all() as (Row & { session_name: string | null })[];
    return rows.map((r) => ({ ...toGate(r), sessionName: r.session_name }));
  }

  // --- Triggers -------------------------------------------------------------

  /** A new guest: global session_start gates. */
  sessionStarted(sessionId: string): void {
    for (const def of this.defs().defs) {
      if (def.personSlug === null && def.trigger.type === 'session_start') this.give(sessionId, { def }, 'session_start');
    }
  }

  /** A session became a person (claim approved or assigned): that person's session_start gates. */
  personAttached(sessionId: string, personSlug: string): void {
    for (const def of this.defs().defs) {
      if (def.personSlug === personSlug && def.trigger.type === 'session_start') {
        this.give(sessionId, { def }, 'session_start');
      }
    }
  }

  /**
   * Called before a chat message is answered. Fires after_messages gates the
   * guest has reached; returns the gate that blocks this message, if any, and
   * whether it was triggered by this very message.
   */
  beforeChat(subject: GateSubject, userMessagesSoFar: number): { gate: Gate | undefined; triggered: boolean } {
    const before = this.current(subject.id);
    if (!before) {
      for (const def of this.defs().defs) {
        if (def.trigger.type !== 'after_messages' || userMessagesSoFar < def.trigger.count) continue;
        if (def.personSlug !== null && def.personSlug !== subject.personSlug) continue;
        this.give(subject.id, { def }, 'after_messages');
      }
    }
    const gate = this.current(subject.id);
    return { gate, triggered: !before && gate !== undefined };
  }

  /**
   * Fires timed global gates whose time has come and expires gates past their
   * deadline. Run every few seconds. A gate whose whole window passed while the
   * server was down is skipped.
   */
  tick(liveSessionIds: () => string[], holderOf: (slug: string) => string | undefined): void {
    this.expire();
    const now = this.now();
    for (const def of this.defs().defs) {
      if (def.trigger.type !== 'timed_global') continue;
      const at = Date.parse(def.trigger.at);
      if (now < at) continue;
      const fired = this.db
        .prepare('INSERT OR IGNORE INTO gate_timers (def_key, at, fired_at) VALUES (?, ?, ?)')
        .run(def.key, def.trigger.at, now);
      if (fired.changes === 0) continue;
      const deadline = at + def.trigger.deadline_minutes * 60_000;
      if (now >= deadline) continue;
      const holder = def.personSlug ? holderOf(def.personSlug) : undefined;
      const targets = def.personSlug ? (holder ? [holder] : []) : liveSessionIds();
      this.db.transaction(() => {
        for (const id of targets) this.give(id, { def }, 'timed_global', deadline);
      })();
    }
  }

  // --- Admin ----------------------------------------------------------------

  /** `durationMs`: how long guests have before the gate expires; null = until passed or cancelled. */
  force(sessionIds: string[], spec: GateSpec, durationMs: number | null): Gate[] {
    const deadlineAt = durationMs === null ? null : this.now() + durationMs;
    return this.db.transaction(() =>
      sessionIds.map((id) => this.give(id, spec, 'admin_forced', deadlineAt)).filter((g): g is Gate => g !== undefined),
    )();
  }

  cancel(id: string): Gate {
    return this.resolve(id, 'cancelled');
  }

  // --- Outcomes -------------------------------------------------------------

  /** Only the photo route calls this, after the model verified a photo. */
  pass(id: string): Gate {
    return this.resolve(id, 'passed');
  }

  /** Counts a refused chat message; returns the count before this one. */
  refused(id: string): number {
    const row = this.db
      .prepare('UPDATE gates SET refusals = refusals + 1 WHERE id = ? RETURNING refusals')
      .get(id) as { refusals: number } | undefined;
    return (row?.refusals ?? 1) - 1;
  }

  // --- Internals ------------------------------------------------------------

  private resolve(id: string, status: 'passed' | 'cancelled'): Gate {
    const gate = this.get(id);
    if (!gate) throw new GateError('No such gate.', 404);
    if (gate.status !== 'active') throw new GateError(`That gate is already ${gate.status}.`);
    this.db.prepare('UPDATE gates SET status = ?, resolved_at = ? WHERE id = ?').run(status, this.now(), id);
    return this.get(id)!;
  }

  private expire(): void {
    this.db
      .prepare(
        `UPDATE gates SET status = 'expired', resolved_at = deadline_at
         WHERE status = 'active' AND deadline_at IS NOT NULL AND deadline_at <= ?`,
      )
      .run(this.now());
  }

  /** Inserts a gate; triggered gates are skipped if the session already had them. */
  private give(sessionId: string, spec: GateSpec, source: GateSource, deadlineAt: number | null = null): Gate | undefined {
    const id = crypto.randomUUID();
    const g =
      'def' in spec
        ? spec.def
        : { key: null, target: spec.custom.target, guestPrompt: spec.custom.guestPrompt, refusalLines: [], points: 0 };
    const r = this.db
      .prepare(
        `INSERT OR IGNORE INTO gates (id, session_id, def_key, source, target, guest_prompt, refusal_lines, points,
           status, created_at, deadline_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      )
      .run(id, sessionId, g.key, source, g.target, g.guestPrompt, JSON.stringify(g.refusalLines), g.points, this.now(), deadlineAt);
    return r.changes ? this.get(id) : undefined;
  }
}
