import crypto from 'node:crypto';
import type { Db } from './db.js';

export type PointSource = 'gate' | 'admin' | 'secret';

export interface LedgerEntry {
  id: number;
  sessionId: string;
  amount: number;
  reason: string;
  source: PointSource;
  gateId: string | null;
  createdAt: number;
}

export interface Standing {
  rank: number;
  sessionId: string;
  name: string;
  points: number;
}

export interface Reward {
  id: string;
  threshold: number;
  prize: string;
  /** False: guests see the goal, but the prize as "???". */
  revealed: boolean;
  winnerId: string | null;
  winnerName: string | null;
  wonAt: number | null;
  createdAt: number;
}

export interface RewardInput {
  threshold: number;
  prize: string;
  revealed?: boolean;
}

export class PointsError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
  }
}

/** What a guest may see about a reward. */
export function rewardView(r: Reward) {
  return { id: r.id, threshold: r.threshold, prize: r.revealed ? r.prize : null, winner: r.winnerName };
}

interface RewardRow {
  id: string;
  threshold: number;
  prize: string;
  revealed: number;
  winner_id: string | null;
  winner_name: string | null;
  won_at: number | null;
  created_at: number;
}

const toReward = (r: RewardRow): Reward => ({
  id: r.id,
  threshold: r.threshold,
  prize: r.prize,
  revealed: r.revealed === 1,
  winnerId: r.winner_id,
  winnerName: r.winner_name,
  wonAt: r.won_at,
  createdAt: r.created_at,
});

/** Sessions that compete: named and not ended. */
const COMPETING = 's.name IS NOT NULL AND s.ended_at IS NULL';

/**
 * The points ledger, leaderboard and "first to N points" rewards. A score is the
 * sum of a session's ledger rows. A reward goes, for good, to the first competing
 * session whose running total reached its threshold; that's worked out from the
 * ledger's history, so a reward added late still goes to whoever got there first.
 */
export class PointsStore {
  /** Hears whose score changed and which rewards were just won (after the change is stored). */
  onChange: (change: { sessionIds: string[]; won: Reward[] }) => void = () => {};

  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  // --- Ledger ---------------------------------------------------------------

  /** Adds (or with a negative amount, takes) points. Gate payouts are once per gate. */
  award(sessionId: string, amount: number, reason: string, source: PointSource, gateId: string | null = null): LedgerEntry {
    if (!Number.isInteger(amount) || amount === 0) throw new PointsError('Points must be a whole number, not 0.');
    const why = reason.trim();
    if (!why) throw new PointsError('Say why (guests see the reason).');
    if (!this.db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(sessionId)) throw new PointsError('Session not found', 404);
    const { entry, won } = this.db.transaction(() => {
      const r = this.db
        .prepare(
          `INSERT INTO points (session_id, amount, reason, source, gate_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (gate_id) DO NOTHING RETURNING *`,
        )
        .get(sessionId, amount, why.slice(0, 200), source, gateId, this.now()) as LedgerRow | undefined;
      if (!r) throw new PointsError('That gate has already paid out.', 409);
      return { entry: toEntry(r), won: this.settle() };
    })();
    this.onChange({ sessionIds: [sessionId], won });
    return entry;
  }

  total(sessionId: string): number {
    const r = this.db.prepare('SELECT COALESCE(SUM(amount), 0) AS t FROM points WHERE session_id = ?').get(sessionId) as { t: number };
    return r.t;
  }

  /** Newest first, with the session's current name. */
  recent(limit = 50): (LedgerEntry & { sessionName: string | null })[] {
    const rows = this.db
      .prepare(
        `SELECT p.*, s.name AS session_name FROM points p JOIN sessions s ON s.id = p.session_id
         ORDER BY p.created_at DESC, p.id DESC LIMIT ?`,
      )
      .all(limit) as (LedgerRow & { session_name: string | null })[];
    return rows.map((r) => ({ ...toEntry(r), sessionName: r.session_name }));
  }

  // --- Leaderboard ----------------------------------------------------------

  /** Competing sessions with points, best first; a tie goes to whoever got there first. */
  leaderboard(limit?: number): Standing[] {
    const rows = this.db
      .prepare(
        `SELECT s.id AS session_id, s.name AS name, SUM(p.amount) AS points, MAX(p.created_at) AS reached
         FROM points p JOIN sessions s ON s.id = p.session_id
         WHERE ${COMPETING}
         GROUP BY s.id HAVING SUM(p.amount) != 0
         ORDER BY points DESC, reached ASC, s.created_at ASC
         ${limit ? 'LIMIT ?' : ''}`,
      )
      .all(...(limit ? [limit] : [])) as { session_id: string; name: string; points: number }[];
    return rows.map((r, i) => ({ rank: i + 1, sessionId: r.session_id, name: r.name, points: r.points }));
  }

  /** A guest's own score and place (null while they have no points or don't compete). */
  standing(sessionId: string): { points: number; rank: number | null } {
    const rank = this.leaderboard().find((s) => s.sessionId === sessionId)?.rank ?? null;
    return { points: this.total(sessionId), rank };
  }

  // --- Rewards --------------------------------------------------------------

  rewards(): Reward[] {
    return (
      this.db
        .prepare(
          `SELECT r.*, s.name AS winner_name FROM rewards r LEFT JOIN sessions s ON s.id = r.winner_id
           ORDER BY r.threshold, r.created_at`,
        )
        .all() as RewardRow[]
    ).map(toReward);
  }

  reward(id: string): Reward | undefined {
    return this.rewards().find((r) => r.id === id);
  }

  addReward(input: RewardInput): Reward {
    const { threshold, prize } = this.checkReward(input);
    const id = crypto.randomUUID();
    const won = this.db.transaction(() => {
      this.db
        .prepare('INSERT INTO rewards (id, threshold, prize, revealed, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, threshold, prize, input.revealed ? 1 : 0, this.now());
      return this.settle();
    })();
    this.onChange({ sessionIds: [], won });
    return this.reward(id)!;
  }

  /** The threshold can only change until someone has won the reward. */
  updateReward(id: string, patch: Partial<RewardInput>): Reward {
    const current = this.reward(id);
    if (!current) throw new PointsError('No such reward.', 404);
    const next = this.checkReward({ ...current, ...patch });
    if (next.threshold !== current.threshold && current.winnerId) {
      throw new PointsError(`Already won by ${current.winnerName ?? 'someone'}; the goal can't change now.`, 409);
    }
    const won = this.db.transaction(() => {
      this.db
        .prepare('UPDATE rewards SET threshold = ?, prize = ?, revealed = ? WHERE id = ?')
        .run(next.threshold, next.prize, (patch.revealed ?? current.revealed) ? 1 : 0, id);
      return this.settle();
    })();
    this.onChange({ sessionIds: [], won });
    return this.reward(id)!;
  }

  deleteReward(id: string): void {
    if (this.db.prepare('DELETE FROM rewards WHERE id = ?').run(id).changes === 0) throw new PointsError('No such reward.', 404);
    this.onChange({ sessionIds: [], won: [] });
  }

  /** Gives every unwon reward that someone has reached to the first one who did. Returns the newly won. */
  private settle(): Reward[] {
    const open = this.db.prepare('SELECT id, threshold FROM rewards WHERE winner_id IS NULL ORDER BY threshold').all() as {
      id: string;
      threshold: number;
    }[];
    const firstToReach = this.db.prepare(
      `WITH running AS (
         SELECT p.session_id, p.created_at, p.id,
                SUM(p.amount) OVER (PARTITION BY p.session_id ORDER BY p.created_at, p.id) AS total
         FROM points p JOIN sessions s ON s.id = p.session_id WHERE ${COMPETING})
       SELECT session_id, created_at FROM running WHERE total >= ? ORDER BY created_at, id LIMIT 1`,
    );
    const won: string[] = [];
    for (const r of open) {
      const first = firstToReach.get(r.threshold) as { session_id: string; created_at: number } | undefined;
      if (!first) continue;
      this.db.prepare('UPDATE rewards SET winner_id = ?, won_at = ? WHERE id = ?').run(first.session_id, first.created_at, r.id);
      won.push(r.id);
    }
    return won.map((id) => this.reward(id)!);
  }

  private checkReward(input: RewardInput): { threshold: number; prize: string } {
    if (!Number.isInteger(input.threshold) || input.threshold <= 0) throw new PointsError('The goal must be a whole number of points above 0.');
    const prize = input.prize.trim();
    if (!prize) throw new PointsError('Describe the prize (guests only see it once you reveal it).');
    return { threshold: input.threshold, prize: prize.slice(0, 200) };
  }
}

interface LedgerRow {
  id: number;
  session_id: string;
  amount: number;
  reason: string;
  source: PointSource;
  gate_id: string | null;
  created_at: number;
}

const toEntry = (r: LedgerRow): LedgerEntry => ({
  id: r.id,
  sessionId: r.session_id,
  amount: r.amount,
  reason: r.reason,
  source: r.source,
  gateId: r.gate_id,
  createdAt: r.created_at,
});
