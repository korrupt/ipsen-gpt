import crypto from 'node:crypto';
import type { Db } from './db.js';

/** An unused invite link for a person. */
export interface Invite {
  token: string;
  personSlug: string;
  createdAt: number;
}

interface Row {
  token: string;
  person_slug: string;
  created_at: number;
}

const toInvite = (r: Row): Invite => ({ token: r.token, personSlug: r.person_slug, createdAt: r.created_at });

/**
 * Single-use invite links (`/#invite=<token>`). Opening one makes the guest that
 * person straight away, without a claim code. The token is kept in plain text so
 * the admin can show the link again; it is dead once used or replaced.
 */
export class InviteStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  /** Makes a new link for this person; their previous unused link stops working. */
  create(personSlug: string): Invite {
    const token = crypto.randomBytes(16).toString('base64url');
    const createdAt = this.now();
    this.db.transaction(() => {
      this.revoke(personSlug);
      this.db
        .prepare('INSERT INTO invites (token, person_slug, created_at) VALUES (?, ?, ?)')
        .run(token, personSlug, createdAt);
    })();
    return { token, personSlug, createdAt };
  }

  /** Kills this person's unused link, if any. */
  revoke(personSlug: string): void {
    this.db.prepare('DELETE FROM invites WHERE person_slug = ? AND used_at IS NULL').run(personSlug);
  }

  forPerson(personSlug: string): Invite | undefined {
    const row = this.db
      .prepare('SELECT * FROM invites WHERE person_slug = ? AND used_at IS NULL')
      .get(personSlug) as Row | undefined;
    return row && toInvite(row);
  }

  /**
   * Uses the link: `join` attaches its person to a session, and the link is
   * marked used in the same transaction, so it works exactly once. Returns null
   * (and calls nothing) for an unknown, used or replaced link.
   */
  redeem<T extends { session: { id: string } }>(token: string, join: (personSlug: string) => T): T | null {
    return this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM invites WHERE token = ? AND used_at IS NULL').get(token) as Row | undefined;
      if (!row) return null;
      const result = join(row.person_slug);
      this.db.prepare('UPDATE invites SET used_at = ?, used_by = ? WHERE token = ?').run(this.now(), result.session.id, token);
      return result;
    })();
  }
}
