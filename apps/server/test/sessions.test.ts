import { beforeEach, describe, expect, it } from 'vitest';
import { CLAIM_CODE_PATTERN } from '../src/claimCodes.js';
import { NameError, NOTICES } from '../src/sessions.js';
import { makeEnv, type TestEnv } from './helpers.js';

let env: TestEnv;
let ola: string;

beforeEach(() => {
  env = makeEnv();
  ola = env.services.people.save({ name: 'Ola Nordmann', aliases: ['Ola'], info: 'Ola info' }).slug;
});

const store = () => env.services.sessions;
const nameErr = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof NameError ? e.code : 'other';
  }
  return null;
};

describe('naming', () => {
  it('free names make a guest; names are unique case-insensitively', () => {
    const { session } = store().create('  Kari ');
    expect(session).toMatchObject({ name: 'Kari', state: 'guest', claimCode: null });
    expect(nameErr(() => store().create('KARI'))).toBe('taken');
    expect(nameErr(() => store().create('<x>'))).toBe('invalid');
  });

  it('a session cannot rename itself', () => {
    const { session } = store().create('Kari');
    expect(nameErr(() => store().setName(session.id, 'Other'))).toBe('already_named');
  });

  it('reserved names (name or alias) start a pending claim with a code', () => {
    const { session } = store().create('ola');
    expect(session.state).toBe('pending_claim');
    expect(session.name).toBe('ola');
    expect(session.claimCode).toMatch(CLAIM_CODE_PATTERN);
    expect(session.claimPersonSlug).toBe(ola);
    expect(session.personSlug).toBeNull();
  });

  it('several guests can claim the same person in parallel, with distinct codes', () => {
    const a = store().create('Ola').session;
    const b = store().create('ola nordmann').session;
    expect(b.state).toBe('pending_claim');
    expect(a.claimCode).not.toBe(b.claimCode);
    expect(store().pendingClaims().map((s) => s.id)).toEqual([a.id, b.id]);
  });

  it('finds claims by loosely typed code', () => {
    const a = store().create('Ola').session;
    store().create('Ola Nordmann');
    const typed = a.claimCode!.toLowerCase().replace('-', ' ');
    expect(store().pendingClaims(typed).map((s) => s.id)).toEqual([a.id]);
  });
});

describe('claims', () => {
  it('approve: claimant becomes the person, under the display name; rival claims are turned away', () => {
    const a = store().create('ola').session;
    const b = store().create('Ola').session;
    const approved = store().approveClaim(a.id);
    expect(approved).toMatchObject({ state: 'claimed', name: 'Ola Nordmann', personSlug: ola, claimCode: null });

    const rival = store().get(b.id)!;
    expect(rival).toMatchObject({ state: 'guest', name: null, claimCode: null, notice: NOTICES.claimedByOther });
    expect(store().pendingClaims()).toEqual([]);
  });

  it('once claimed, the person and all their names are taken', () => {
    store().approveClaim(store().create('Ola').session.id);
    expect(nameErr(() => store().create('ola'))).toBe('taken');
    expect(nameErr(() => store().create('OLA NORDMANN'))).toBe('taken');
  });

  it('reject: claimant must pick a new name, keeps their session and history', () => {
    const { session } = store().create('Ola');
    store().addExchange(session.id, 'hi', 'boo');
    const rejected = store().rejectClaim(session.id);
    expect(rejected).toMatchObject({ state: 'guest', name: null, notice: NOTICES.claimRejected });
    expect(store().recentMessages(session.id, 10)).toHaveLength(2);
    expect(store().setName(session.id, 'Kari')).toMatchObject({ name: 'Kari', state: 'guest', notice: null });
  });

  it('approving a claim releases a guest squatting on the display name', () => {
    // The person file is created after someone already took the display name.
    const squatter = store().create('Kari Hansen').session;
    const kari = env.services.people.save({ name: 'Kari Hansen', aliases: ['Kari'], info: '' }).slug;
    const claimant = store().create('Kari').session;
    store().approveClaim(claimant.id);
    expect(store().get(claimant.id)).toMatchObject({ name: 'Kari Hansen', personSlug: kari });
    expect(store().get(squatter.id)).toMatchObject({ name: null, notice: NOTICES.nameReleased });
  });

  it('cannot approve or reject something that is not a pending claim', () => {
    const { session } = store().create('Kari');
    expect(() => store().approveClaim(session.id)).toThrow(/No pending claim/);
    expect(() => store().rejectClaim('nope')).toThrow(/No pending claim/);
  });
});

describe('admin session actions', () => {
  it('assign moves a person from one session to another', () => {
    const first = store().create('Kari').session;
    const second = store().create('Per').session;
    store().assignPerson(first.id, ola);
    expect(store().get(first.id)).toMatchObject({ state: 'claimed', name: 'Ola Nordmann' });
    store().assignPerson(second.id, ola);
    expect(store().get(second.id)).toMatchObject({ state: 'claimed', name: 'Ola Nordmann', personSlug: ola });
    expect(store().get(first.id)).toMatchObject({ state: 'guest', name: null, personSlug: null });
    expect(store().holderOf(ola)?.id).toBe(second.id);
  });

  it('release name frees it for others', () => {
    const { session } = store().create('Kari');
    store().releaseName(session.id);
    expect(store().get(session.id)).toMatchObject({ name: null, notice: NOTICES.nameReleased });
    expect(store().create('kari').session.name).toBe('kari');
  });

  it('end invalidates the token and frees the name', () => {
    const { token, session } = store().create('Kari');
    store().end(session.id);
    expect(store().byToken(token)).toBeUndefined();
    expect(store().get(session.id)).toBeUndefined();
    expect(store().list()).toHaveLength(0);
    expect(store().create('Kari').session.state).toBe('guest');
    expect(() => store().end(session.id)).toThrow(/not found/);
  });

  it('ending a pending claim frees its code', () => {
    const { session } = store().create('Ola');
    store().end(session.id);
    expect(store().pendingClaims()).toEqual([]);
  });
});

describe('person changes', () => {
  it('deleting a person turns claimants away and leaves the holder as a plain guest', () => {
    const holder = store().create('Kari').session;
    store().assignPerson(holder.id, ola);
    const claimant = store().create('Per').session; // not a claimant, untouched
    env.services.people.delete(ola);
    store().personDeleted(ola);
    expect(store().get(holder.id)).toMatchObject({ state: 'guest', name: 'Ola Nordmann', personSlug: null });
    expect(store().get(claimant.id)).toMatchObject({ name: 'Per' });
  });

  it('deleting a person rejects pending claims for them', () => {
    const claimant = store().create('Ola').session;
    env.services.people.delete(ola);
    store().personDeleted(ola);
    expect(store().get(claimant.id)).toMatchObject({ state: 'guest', name: null, notice: NOTICES.claimRejected });
  });

  it('renaming a person renames the holder', () => {
    store().approveClaim(store().create('Ola').session.id);
    const updated = env.services.people.save({ name: 'Ola the Great', aliases: ['Ola'], info: '' }, ola);
    store().personUpdated(updated);
    expect(store().holderOf(ola)?.name).toBe('Ola the Great');
  });
});

describe('messages and activity', () => {
  it('returns the most recent messages oldest first', () => {
    const { session } = store().create('Kari');
    for (let i = 0; i < 5; i++) store().addExchange(session.id, `u${i}`, `a${i}`);
    expect(store().recentMessages(session.id, 4).map((m) => m.content)).toEqual(['u3', 'a3', 'u4', 'a4']);
    expect(store().list()[0]?.messageCount).toBe(10);
  });

  it('touch updates last seen at most every 30 s', () => {
    const { token, session } = store().create('Kari');
    env.tick(10_000);
    store().touch(store().byToken(token)!);
    expect(store().get(session.id)!.lastSeenAt).toBe(session.lastSeenAt);
    env.tick(30_000);
    store().touch(store().byToken(token)!);
    expect(store().get(session.id)!.lastSeenAt).toBe(session.lastSeenAt + 40_000);
  });
});
