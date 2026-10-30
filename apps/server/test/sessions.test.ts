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
    expect(store().claimCandidates(session).map((p) => p.slug)).toEqual([ola]);
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

describe('shared aliases', () => {
  let berg: string;
  let hansen: string;
  beforeEach(() => {
    berg = env.services.people.save({ name: 'Vanessa Berg', aliases: ['Vanessa'], info: '' }).slug;
    hansen = env.services.people.save({ name: 'Vanessa Hansen', aliases: ['Vanessa'], info: '' }).slug;
  });
  const candidates = (id: string) => store().claimCandidates(store().get(id)!).map((p) => p.slug);

  it('a shared alias makes one claim that could be either person', () => {
    const { session } = store().create('vanessa');
    expect(session.state).toBe('pending_claim');
    expect(candidates(session.id)).toEqual([berg, hansen]);
    // The full name still points at one person.
    expect(candidates(store().create('Vanessa Hansen').session.id)).toEqual([hansen]);
  });

  it('the admin must pick who, and only from the matching people', () => {
    const { session } = store().create('Vanessa');
    expect(() => store().approveClaim(session.id)).toThrow(/Pick who they are: Vanessa Berg or Vanessa Hansen/);
    expect(() => store().approveClaim(session.id, ola)).toThrow(/Pick who they are/);
    expect(store().approveClaim(session.id, hansen)).toMatchObject({ state: 'claimed', name: 'Vanessa Hansen', personSlug: hansen });
  });

  it('once one is claimed, other claims narrow to the rest; claims only for the taken one end', () => {
    const a = store().create('Vanessa').session;
    const b = store().create('Vanessa').session;
    const onlyHansen = store().create('vanessa hansen').session;
    store().approveClaim(a.id, hansen);
    expect(candidates(b.id)).toEqual([berg]);
    expect(store().get(onlyHansen.id)).toMatchObject({ name: null, notice: NOTICES.claimedByOther });
    // With one left, approving needs no pick.
    expect(store().approveClaim(b.id)).toMatchObject({ name: 'Vanessa Berg' });
    // Both taken: the alias is taken too.
    expect(nameErr(() => store().create('Vanessa'))).toBe('taken');
  });

  it('a claim whose name stops matching anyone is turned away; one that still matches someone stays', () => {
    const { session } = store().create('Vanessa');
    env.services.people.delete(berg);
    store().personDeleted(berg);
    expect(candidates(session.id)).toEqual([hansen]);
    const updated = env.services.people.save({ name: 'Vanessa Hansen', aliases: [], info: '' }, hansen);
    store().personUpdated(updated);
    expect(store().get(session.id)).toMatchObject({ state: 'guest', name: null, notice: NOTICES.claimRejected });
  });
});

describe('joining by invite', () => {
  it('without a session: a new session, already claimed, under the display name', () => {
    const { token, session } = store().joinAs(ola);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(store().byToken(token!)?.id).toBe(session.id);
    expect(session).toMatchObject({ state: 'claimed', name: 'Ola Nordmann', personSlug: ola, claimCode: null });
  });

  it('with a session (named, pending or nameless): that session becomes the person and keeps its history', () => {
    for (const name of ['Kari', 'Ola', null]) {
      const { session } = name ? store().create(name) : store().create('Temp');
      if (!name) store().releaseName(session.id);
      store().addExchange(session.id, 'hi', 'boo');
      const joined = store().joinAs(ola, session.id);
      expect(joined.token).toBeNull();
      expect(joined.session).toMatchObject({ id: session.id, state: 'claimed', name: 'Ola Nordmann' });
      expect(store().recentMessages(session.id, 10)).toHaveLength(2);
      store().end(session.id);
    }
  });

  it('moves the person from whoever held them, and ends other claims for them', () => {
    const holder = store().create('Per').session;
    store().assignPerson(holder.id, ola);
    const { session } = store().joinAs(ola);
    expect(store().get(holder.id)).toMatchObject({ name: null, personSlug: null, notice: NOTICES.claimedByOther });
    expect(store().holderOf(ola)?.id).toBe(session.id);
  });

  it('an ended current session gets a new one instead', () => {
    const old = store().create('Kari').session;
    store().end(old.id);
    const joined = store().joinAs(ola, old.id);
    expect(joined.token).not.toBeNull();
    expect(joined.session.id).not.toBe(old.id);
  });

  it('refuses a person that does not exist', () => {
    expect(() => store().joinAs('nobody')).toThrow(/No such person/);
    expect(store().list()).toHaveLength(0);
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
