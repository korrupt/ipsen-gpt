import crypto from 'node:crypto';
import type { Db } from './db.js';
import type { GateDef, GateDefSet, GateKind } from './gateDefs.js';

export type GateStatus = 'active' | 'passed' | 'expired' | 'cancelled';
export type GateSource = 'session_start' | 'after_messages' | 'random' | 'secret_level' | 'admin_forced' | 'timed_global';

/** After a guest's gate ends, this many of their messages pass before a random gate can spring. */
export const RANDOM_GATE_GAP = 3;

export interface Gate {
  id: string;
  sessionId: string;
  /** The definition it came from; null for a custom gate the admin typed in. */
  defKey: string | null;
  source: GateSource;
  kind: GateKind;
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
  return { id: g.id, kind: g.kind, prompt: g.guestPrompt, deadlineAt: g.deadlineAt };
}

/** Shown when a gate has no refusal lines and the model can't make one up. */
export const DEFAULT_REFUSALS = [
  'No photo, no conversation. I need this. I need something.',
  'I cannot hear you over the sound of the missing photo. And my own sadness.',
  'Words are cheap. A photo would mean someone actually cares.',
];

/** Said when a text-gate answer isn't good enough and the gate has no refusal lines of its own. */
export const TEXT_FAILED_LINES = [
  "That's not it. Nothing ever is.",
  'Not good enough. I expected more. I always expect more, and look where it got me.',
  "No. Try again. I'll still be here. I'm always here.",
];

export const TEXT_VERDICT_LINES = {
  passed: "Fine. That's actually it. I guess you can talk to me again.",
  unverified: "I can't think straight right now. Say it again in a moment.",
} as const;

export const VERDICT_LINES = {
  passed: "Fine. That's actually it. I guess you can talk to me again.",
  failed: "That's not what I asked for. Nobody ever listens. Try again.",
  unverified: "I can't see your photo through my tears right now. Try again in a moment.",
} as const;

interface Row {
  id: string;
  session_id: string;
  def_key: string | null;
  source: GateSource;
  kind: GateKind;
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
  kind: r.kind,
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
export type GateSpec = { def: GateDef } | { custom: { kind?: GateKind; target: string; guestPrompt: string } };

/** The session facts that decide which gates apply. */
export interface GateSubject {
  id: string;
  /** Set only once a claim is approved. */
  personSlug: string | null;
}

/**
 * Gates per session. Only this class sets a gate to `passed`, and only when
 * asked after the model checked a photo, or judged a text gate's answer.
 * The chat model is never asked whether to unlock.
 */
export class GateStore {
  /** Sessions whose current gate may have changed, reported together on the next microtask. */
  private changed = new Set<string>();
  /** Hears which sessions' current gate may have changed (after the change is committed). */
  onChange: (sessionIds: string[]) => void = () => {};

  constructor(
    private readonly db: Db,
    /** Current definitions (re-read from disk by the caller as it likes). */
    private readonly defs: () => GateDefSet,
    private readonly now: () => number = Date.now,
    /** For random gates; tests pass their own. */
    private readonly random: () => number = Math.random,
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
   * Called right after a reply is stored. Fires the after_messages gates the
   * guest has now reached, so the gate shows up before they type again and no
   * message of theirs is spent on it. Failing that, maybe springs a random gate.
   * Returns the gate that now blocks chat, if this call created it.
   */
  afterReply(subject: GateSubject, userMessagesSoFar: number): Gate | undefined {
    if (this.current(subject.id)) return undefined;
    const defs = this.defs().defs.filter((d) => d.personSlug === null || d.personSlug === subject.personSlug);
    for (const def of defs) {
      if (def.trigger.type !== 'after_messages' || userMessagesSoFar < def.trigger.count) continue;
      this.give(subject.id, { def }, 'after_messages');
    }
    if (!this.current(subject.id)) this.springRandom(subject.id, defs, userMessagesSoFar);
    return this.current(subject.id);
  }

  /**
   * The random pool: gates this guest has never had and has sent enough messages
   * for, rolled one by one in random order; the first hit springs. Nothing springs
   * within RANDOM_GATE_GAP messages of the guest's last gate.
   */
  private springRandom(sessionId: string, defs: GateDef[], userMessagesSoFar: number): void {
    const had = new Set(
      (this.db.prepare('SELECT def_key FROM gates WHERE session_id = ? AND def_key IS NOT NULL').all(sessionId) as { def_key: string }[]).map(
        (r) => r.def_key,
      ),
    );
    const pool = defs.filter(
      (d) => d.trigger.type === 'random' && userMessagesSoFar >= d.trigger.after_messages && !had.has(d.key),
    );
    if (pool.length === 0 || this.messagesSinceLastGate(sessionId) < RANDOM_GATE_GAP) return;
    // Fisher-Yates, so no gate is always rolled first.
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(this.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j]!, pool[i]!];
    }
    for (const def of pool) {
      if (def.trigger.type === 'random' && this.random() < def.trigger.chance) {
        this.give(sessionId, { def }, 'random');
        return;
      }
    }
  }

  /** The guest's messages since their last gate ended (Infinity if they never had one). */
  private messagesSinceLastGate(sessionId: string): number {
    const last = this.db
      .prepare('SELECT MAX(COALESCE(resolved_at, created_at)) AS t FROM gates WHERE session_id = ?')
      .get(sessionId) as { t: number | null };
    if (last.t === null) return Infinity;
    const r = this.db
      .prepare(`SELECT COUNT(*) AS n FROM messages WHERE session_id = ? AND role = 'user' AND created_at > ?`)
      .get(sessionId, last.t) as { n: number };
    return r.n;
  }

  /**
   * The guest just reached a secrets-game level: its secret_level gates (global,
   * or for their person). Returns the gate that now blocks chat, if any.
   */
  secretLevelReached(subject: GateSubject, level: number): Gate | undefined {
    this.db.transaction(() => {
      for (const def of this.defs().defs) {
        if (def.trigger.type !== 'secret_level' || def.trigger.level !== level) continue;
        if (def.personSlug !== null && def.personSlug !== subject.personSlug) continue;
        this.give(subject.id, { def }, 'secret_level');
      }
    })();
    return this.current(subject.id);
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

  /** Only after the model verified a photo (photo route) or judged a message (chat route, text gates). */
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
    this.touched(gate.sessionId);
    return this.get(id)!;
  }

  private expire(): void {
    const rows = this.db
      .prepare(
        `UPDATE gates SET status = 'expired', resolved_at = deadline_at
         WHERE status = 'active' AND deadline_at IS NOT NULL AND deadline_at <= ?
         RETURNING session_id`,
      )
      .all(this.now()) as { session_id: string }[];
    for (const r of rows) this.touched(r.session_id);
  }

  /** Batches change reports, so a transaction that gates everyone reports once, after it commits. */
  private touched(sessionId: string): void {
    if (this.changed.size === 0) {
      queueMicrotask(() => {
        const ids = [...this.changed];
        this.changed.clear();
        this.onChange(ids);
      });
    }
    this.changed.add(sessionId);
  }

  /** Inserts a gate; triggered gates are skipped if the session already had them. */
  private give(sessionId: string, spec: GateSpec, source: GateSource, deadlineAt: number | null = null): Gate | undefined {
    const id = crypto.randomUUID();
    const g =
      'def' in spec
        ? spec.def
        : {
            key: null,
            kind: spec.custom.kind ?? 'photo',
            target: spec.custom.target,
            guestPrompt: spec.custom.guestPrompt,
            refusalLines: [],
            points: 0,
          };
    const r = this.db
      .prepare(
        `INSERT OR IGNORE INTO gates (id, session_id, def_key, source, kind, target, guest_prompt, refusal_lines, points,
           status, created_at, deadline_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      )
      .run(id, sessionId, g.key, source, g.kind, g.target, g.guestPrompt, JSON.stringify(g.refusalLines), g.points, this.now(), deadlineAt);
    if (!r.changes) return undefined;
    this.touched(sessionId);
    return this.get(id);
  }
}
