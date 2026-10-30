import crypto from 'node:crypto';
import { generateClaimCode, normalizeClaimQuery } from './claimCodes.js';
import type { Db } from './db.js';
import { cleanName, nameKey, validateName } from './names.js';
import type { PeopleStore, Person } from './people.js';

export type SessionState = 'guest' | 'pending_claim' | 'claimed';

export interface Session {
  id: string;
  /** Null when the guest must (re)pick a name. */
  name: string | null;
  state: SessionState;
  personSlug: string | null;
  claimCode: string | null;
  /** One-off message for the guest, e.g. why they must pick a new name. */
  notice: string | null;
  /** This session's persona; null: the global one. */
  personaId: string | null;
  createdAt: number;
  lastSeenAt: number;
}

export interface StoredMessage {
  role: 'user' | 'assistant';
  content: string;
  createdAt: number;
}

export class NameError extends Error {
  constructor(
    message: string,
    readonly code: 'invalid' | 'taken' | 'already_named',
  ) {
    super(message);
  }
}

export class SessionError extends Error {
  constructor(
    message: string,
    readonly status: 404 | 409 = 409,
  ) {
    super(message);
  }
}

export const NOTICES = {
  claimRejected: "SadGPT's human didn't confirm that name. Pick another one.",
  claimedByOther: 'Someone else was confirmed under that name. Pick another one.',
  nameReleased: 'Your name was released. Pick a new one.',
} as const;

const TOUCH_INTERVAL_MS = 30_000;

interface Row {
  id: string;
  name: string | null;
  state: SessionState;
  person_slug: string | null;
  claim_code: string | null;
  notice: string | null;
  persona_id: string | null;
  created_at: number;
  last_seen_at: number;
}

const toSession = (r: Row): Session => ({
  id: r.id,
  name: r.name,
  state: r.state,
  personSlug: r.person_slug,
  claimCode: r.claim_code,
  notice: r.notice,
  personaId: r.persona_id,
  createdAt: r.created_at,
  lastSeenAt: r.last_seen_at,
});

export const hashToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex');
export const newToken = () => crypto.randomBytes(32).toString('base64url');

const LIVE = 'ended_at IS NULL';

export class SessionStore {
  constructor(
    private readonly db: Db,
    private readonly people: PeopleStore,
    private readonly now: () => number = Date.now,
  ) {}

  // --- Lookup ---------------------------------------------------------------

  get(id: string): Session | undefined {
    const row = this.db.prepare(`SELECT * FROM sessions WHERE id = ? AND ${LIVE}`).get(id) as Row | undefined;
    return row && toSession(row);
  }

  byToken(token: string): Session | undefined {
    const row = this.db
      .prepare(`SELECT * FROM sessions WHERE token_hash = ? AND ${LIVE}`)
      .get(hashToken(token)) as Row | undefined;
    return row && toSession(row);
  }

  list(): (Session & { messageCount: number })[] {
    const rows = this.db
      .prepare(
        `SELECT s.*, (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS message_count
         FROM sessions s WHERE ${LIVE} ORDER BY s.last_seen_at DESC`,
      )
      .all() as (Row & { message_count: number })[];
    return rows.map((r) => ({ ...toSession(r), messageCount: r.message_count }));
  }

  /** Pending claims, oldest first; `query` matches the code loosely ("bat427"). */
  pendingClaims(query = ''): Session[] {
    const q = normalizeClaimQuery(query);
    const rows = this.db
      .prepare(`SELECT * FROM sessions WHERE state = 'pending_claim' AND ${LIVE} ORDER BY created_at`)
      .all() as Row[];
    return rows.map(toSession).filter((s) => !q || normalizeClaimQuery(s.claimCode ?? '').includes(q));
  }

  /**
   * Who a pending claim could be approved as: the people its name matches
   * (several for a shared alias) that no live session holds yet. Worked out
   * from the name each time, so edits to people apply to waiting claims too.
   */
  claimCandidates(s: Session): Person[] {
    if (s.state !== 'pending_claim' || s.name === null) return [];
    return this.people.findByName(s.name).filter((p) => !this.holderOf(p.slug));
  }

  /** The live session that holds this person, if any. */
  holderOf(slug: string): Session | undefined {
    const row = this.db
      .prepare(`SELECT * FROM sessions WHERE person_slug = ? AND ${LIVE}`)
      .get(slug) as Row | undefined;
    return row && toSession(row);
  }

  /** Ids of live sessions that have a name: who a global gate goes to. */
  liveNamedIds(): string[] {
    return (this.db.prepare(`SELECT id FROM sessions WHERE name IS NOT NULL AND ${LIVE}`).all() as { id: string }[]).map(
      (r) => r.id,
    );
  }

  userMessageCount(sessionId: string): number {
    return (
      this.db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE session_id = ? AND role = 'user'`).get(sessionId) as {
        n: number;
      }
    ).n;
  }

  /** Updates last_seen_at, at most every 30 s per session. */
  touch(s: Session): void {
    const now = this.now();
    if (now - s.lastSeenAt < TOUCH_INTERVAL_MS) return;
    this.db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(now, s.id);
  }

  // --- Guest actions --------------------------------------------------------

  create(rawName: string): { token: string; session: Session } {
    return this.db.transaction(() => {
      const { token, id } = this.insert();
      return { token, session: this.setName(id, rawName) };
    })();
  }

  /**
   * Gives a nameless session a name. Reserved names (a person's name or alias)
   * put the session in pending_claim with a claim code instead.
   */
  setName(id: string, rawName: string): Session {
    const name = cleanName(rawName);
    const invalid = validateName(name);
    if (invalid) throw new NameError(invalid, 'invalid');

    return this.db.transaction(() => {
      const s = this.get(id);
      if (!s) throw new SessionError('Session not found', 404);
      if (s.name !== null) throw new NameError('You already have a name.', 'already_named');

      const key = nameKey(name);
      const matches = this.people.findByName(name);
      if (matches.length) {
        if (matches.every((p) => this.holderOf(p.slug))) throw new NameError('That name is taken.', 'taken');
        this.db
          .prepare(
            `UPDATE sessions SET name = ?, name_key = ?, state = 'pending_claim', claim_code = ?,
               notice = NULL WHERE id = ?`,
          )
          .run(name, key, this.uniqueClaimCode(), id);
      } else {
        if (this.nameHolder(key)) throw new NameError('That name is taken.', 'taken');
        this.db
          .prepare(`UPDATE sessions SET name = ?, name_key = ?, state = 'guest', notice = NULL WHERE id = ?`)
          .run(name, key, id);
      }
      return this.get(id)!;
    })();
  }

  // --- Admin actions --------------------------------------------------------

  /** `slug` picks the person when the claim matches several (a shared alias). */
  approveClaim(id: string, slug?: string): Session {
    return this.db.transaction(() => {
      const s = this.get(id);
      if (!s || s.state !== 'pending_claim') throw new SessionError('No pending claim.');
      const candidates = this.claimCandidates(s);
      if (candidates.length === 0) throw new SessionError('Nobody left to approve that claim as. Reject it.');
      const person = slug === undefined && candidates.length === 1 ? candidates[0] : candidates.find((p) => p.slug === slug);
      if (!person) throw new SessionError(`Pick who they are: ${candidates.map((p) => p.name).join(' or ')}.`);
      return this.attachPerson(id, person);
    })();
  }

  rejectClaim(id: string): Session {
    const s = this.get(id);
    if (!s || s.state !== 'pending_claim') throw new SessionError('No pending claim.');
    this.clearName(id, NOTICES.claimRejected);
    return this.get(id)!;
  }

  /** Assigns (or moves) a person to any session. */
  assignPerson(id: string, slug: string): Session {
    return this.db.transaction(() => {
      if (!this.get(id)) throw new SessionError('Session not found', 404);
      const person = this.people.get(slug);
      if (!person) throw new SessionError('No such person.', 404);
      return this.attachPerson(id, person);
    })();
  }

  /**
   * Joins as a person from an invite link: attaches them to the guest's current
   * session if there is one, otherwise to a new session. `token` is set only for
   * a new session (the guest already has the token of their current one).
   */
  joinAs(slug: string, currentId?: string): { token: string | null; session: Session } {
    return this.db.transaction(() => {
      const person = this.people.get(slug);
      if (!person) throw new SessionError('No such person.', 404);
      if (currentId && this.get(currentId)) return { token: null, session: this.attachPerson(currentId, person) };
      const { token, id } = this.insert();
      return { token, session: this.attachPerson(id, person) };
    })();
  }

  /** null: back to the global persona. */
  setPersona(id: string, personaId: string | null): Session {
    if (!this.get(id)) throw new SessionError('Session not found', 404);
    this.db.prepare('UPDATE sessions SET persona_id = ? WHERE id = ?').run(personaId, id);
    return this.get(id)!;
  }

  releaseName(id: string): Session {
    if (!this.get(id)) throw new SessionError('Session not found', 404);
    this.clearName(id, NOTICES.nameReleased);
    return this.get(id)!;
  }

  end(id: string): void {
    const r = this.db
      .prepare(`UPDATE sessions SET ended_at = ?, claim_code = NULL WHERE id = ? AND ${LIVE}`)
      .run(this.now(), id);
    if (r.changes === 0) throw new SessionError('Session not found', 404);
  }

  /** After a person is deleted: claimants left with nobody are turned away, the holder keeps their name as a plain guest. */
  personDeleted(slug: string): void {
    this.db.transaction(() => {
      this.db
        .prepare(`UPDATE sessions SET state = 'guest', person_slug = NULL WHERE person_slug = ? AND ${LIVE}`)
        .run(slug);
      this.dropHopelessClaims(NOTICES.claimRejected);
    })();
  }

  /**
   * After a person is edited: the holder follows a display-name change if the name
   * is free, and claims whose name no longer matches anyone are turned away.
   */
  personUpdated(person: Person): void {
    this.db.transaction(() => {
      this.peopleReloaded();
      const holder = this.holderOf(person.slug);
      if (!holder || holder.name === person.name) return;
      const key = nameKey(person.name);
      const other = this.nameHolder(key);
      if (other && other.id !== holder.id) return;
      this.db.prepare('UPDATE sessions SET name = ?, name_key = ? WHERE id = ?').run(person.name, key, holder.id);
    })();
  }

  /** After people change on disk: claims whose name no longer matches anyone are turned away. */
  peopleReloaded(): void {
    this.dropHopelessClaims(NOTICES.claimRejected);
  }

  // --- Messages -------------------------------------------------------------

  addExchange(sessionId: string, user: string, assistant: string): void {
    const now = this.now();
    const insert = this.db.prepare('INSERT INTO messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)');
    this.db.transaction(() => {
      insert.run(sessionId, 'user', user, now);
      insert.run(sessionId, 'assistant', assistant, now);
    })();
  }

  /** The last `limit` messages, oldest first. */
  recentMessages(sessionId: string, limit: number): StoredMessage[] {
    const rows = this.db
      .prepare(
        `SELECT role, content, created_at FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?`,
      )
      .all(sessionId, limit) as { role: 'user' | 'assistant'; content: string; created_at: number }[];
    return rows.reverse().map((r) => ({ role: r.role, content: r.content, createdAt: r.created_at }));
  }

  // --- Internals ------------------------------------------------------------

  /** Live non-pending session holding this name key. */
  private nameHolder(key: string): Session | undefined {
    const row = this.db
      .prepare(`SELECT * FROM sessions WHERE name_key = ? AND state != 'pending_claim' AND ${LIVE}`)
      .get(key) as Row | undefined;
    return row && toSession(row);
  }

  /** Turns away pending claims with nobody left to be approved as. */
  private dropHopelessClaims(notice: string): void {
    for (const s of this.pendingClaims()) {
      if (this.claimCandidates(s).length === 0) this.clearName(s.id, notice);
    }
  }

  /** A new nameless session. Must run inside a transaction (the caller names it). */
  private insert(): { token: string; id: string } {
    const token = newToken();
    const id = crypto.randomUUID();
    const now = this.now();
    this.db
      .prepare(`INSERT INTO sessions (id, token_hash, state, created_at, last_seen_at) VALUES (?, ?, 'guest', ?, ?)`)
      .run(id, hashToken(token), now, now);
    return { token, id };
  }

  /** Must run inside a transaction. */
  private attachPerson(id: string, person: Person): Session {
    const key = nameKey(person.name);
    const previous = this.holderOf(person.slug);
    if (previous && previous.id !== id) this.clearName(previous.id, NOTICES.claimedByOther);
    const squatter = this.nameHolder(key);
    if (squatter && squatter.id !== id) this.clearName(squatter.id, NOTICES.nameReleased);

    this.db
      .prepare(
        `UPDATE sessions SET name = ?, name_key = ?, state = 'claimed', person_slug = ?,
           claim_code = NULL, claim_person_slug = NULL, notice = NULL, persona_id = COALESCE(?, persona_id) WHERE id = ?`,
      )
      .run(person.name, key, person.slug, person.persona, id);
    // Claims that could only have been this person are over.
    this.dropHopelessClaims(NOTICES.claimedByOther);
    return this.get(id)!;
  }

  private clearName(id: string, notice: string): void {
    this.db
      .prepare(
        `UPDATE sessions SET name = NULL, name_key = NULL, state = 'guest', person_slug = NULL,
           claim_code = NULL, claim_person_slug = NULL, notice = ? WHERE id = ?`,
      )
      .run(notice, id);
  }

  private uniqueClaimCode(): string {
    const exists = this.db.prepare('SELECT 1 FROM sessions WHERE claim_code = ?');
    for (let i = 0; i < 100; i++) {
      const code = generateClaimCode();
      if (!exists.get(code)) return code;
    }
    throw new SessionError('Could not generate a claim code');
  }
}
