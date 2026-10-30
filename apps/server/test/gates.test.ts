import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { parseGateFile } from '../src/gateDefs.js';
import { GateError, GateStore } from '../src/gates.js';
import { gateJson, makeEnv, writeGates, type TestEnv } from './helpers.js';

describe('gate definitions', () => {
  it('parses gates.json (snake_case) into keyed definitions', () => {
    const { defs, errors } = parseGateFile(
      JSON.stringify([
        gateJson('pumpkin', { type: 'session_start' }, { refusal_lines: ['No.'], points: 10 }),
        gateJson('hat', { type: 'after_messages', count: 3 }),
      ]),
      null,
      'gates.json',
    );
    expect(errors).toEqual([]);
    expect(defs).toEqual([
      {
        key: 'global/pumpkin',
        id: 'pumpkin',
        personSlug: null,
        kind: 'photo',
        target: 'a pumpkin',
        guestPrompt: 'Show me a pumpkin!',
        refusalLines: ['No.'],
        points: 10,
        trigger: { type: 'session_start' },
      },
      expect.objectContaining({ key: 'global/hat', trigger: { type: 'after_messages', count: 3 } }),
    ]);
  });

  it('person gates are keyed by the person', () => {
    const { defs } = parseGateFile(JSON.stringify([gateJson('carrot', { type: 'admin_forced' })]), 'ola', 'ola/gates.json');
    expect(defs[0]).toMatchObject({ key: 'ola/carrot', personSlug: 'ola' });
  });

  it('skips bad gates with a readable error and keeps the good ones', () => {
    const { defs, errors } = parseGateFile(
      JSON.stringify([
        gateJson('ok', { type: 'admin_forced' }),
        gateJson('Bad Id', { type: 'admin_forced' }),
        gateJson('no-count', { type: 'after_messages' }),
        gateJson('nope', { type: 'when_the_moon_is_full' }),
        { ...gateJson('empty-target', { type: 'admin_forced' }), target: '  ' },
        gateJson('ok', { type: 'session_start' }),
      ]),
      null,
      'gates.json',
    );
    expect(defs.map((d) => d.key)).toEqual(['global/ok']);
    expect(errors).toHaveLength(5);
    expect(errors[0]).toMatch(/^gates\.json gate Bad Id: /);
    expect(errors[4]).toBe('gates.json gate ok: duplicate id, skipped');
  });

  it('timed gates need a time with a timezone, so the server clock (UTC in Docker) cannot misread it', () => {
    const at = (value: string) =>
      parseGateFile(JSON.stringify([gateJson('t', { type: 'timed_global', at: value, deadline_minutes: 10 })]), null, 'g')
        .defs.length;
    expect(at('2026-10-31T22:30:00+01:00')).toBe(1);
    expect(at('2026-10-31T21:30:00Z')).toBe(1);
    expect(at('2026-10-31T22:30:00')).toBe(0);
    expect(at('22:30')).toBe(0);
  });

  it('reports broken files instead of crashing', () => {
    expect(parseGateFile('{ nope', null, 'gates.json').errors[0]).toMatch(/^gates\.json: not valid JSON/);
    expect(parseGateFile('{}', null, 'gates.json').errors).toEqual(['gates.json: must be a JSON array of gates']);
  });

  it('loads the global file and person files; a missing file means no gates', () => {
    const e = makeEnv();
    expect(e.services.gateDefs()).toEqual({ defs: [], errors: [] });
    const ola = e.services.people.save({ name: 'Ola', aliases: [], info: '' }).slug;
    writeGates(e.config.gatesPath, [gateJson('pumpkin', { type: 'session_start' })]);
    writeGates(path.join(e.config.peopleDir, ola, 'gates.json'), [gateJson('carrot', { type: 'admin_forced' })]);
    expect(e.services.gateDefs().defs.map((d) => d.key)).toEqual(['global/pumpkin', `${ola}/carrot`]);
    // Re-read on every use: edits apply without a restart.
    writeGates(e.config.gatesPath, []);
    expect(e.services.gateDefs().defs.map((d) => d.key)).toEqual([`${ola}/carrot`]);
  });
});

describe('gate store', () => {
  let e: TestEnv;
  let kari: string;
  const gates = () => e.services.gates;
  const setGates = (list: unknown[]) => writeGates(e.config.gatesPath, list);
  const newSession = (name: string) => e.services.sessions.create(name).session.id;

  beforeEach(() => {
    e = makeEnv();
    kari = newSession('Kari');
  });

  it('session_start gates fire for new guests, once', () => {
    setGates([gateJson('pumpkin', { type: 'session_start' }), gateJson('forced', { type: 'admin_forced' })]);
    gates().sessionStarted(kari);
    gates().sessionStarted(kari);
    expect(gates().forSession(kari).map((g) => [g.defKey, g.source, g.status])).toEqual([
      ['global/pumpkin', 'session_start', 'active'],
    ]);
    expect(gates().current(kari)).toMatchObject({ target: 'a pumpkin', guestPrompt: 'Show me a pumpkin!', points: 5 });
  });

  it("a person's session_start gates fire when a session becomes that person, not for everyone", () => {
    const ola = e.services.people.save({ name: 'Ola', aliases: [], info: '' }).slug;
    writeGates(path.join(e.config.peopleDir, ola, 'gates.json'), [gateJson('carrot', { type: 'session_start' })]);
    gates().sessionStarted(kari);
    expect(gates().current(kari)).toBeUndefined();
    gates().personAttached(kari, ola);
    expect(gates().current(kari)?.defKey).toBe(`${ola}/carrot`);
  });

  it('after_messages gates fire right after the reply to that many messages', () => {
    setGates([gateJson('hat', { type: 'after_messages', count: 2 })]);
    const subject = { id: kari, personSlug: null };
    expect(gates().afterReply(subject, 1)).toBeUndefined();
    const hat = gates().afterReply(subject, 2);
    expect(hat).toMatchObject({ defKey: 'global/hat', source: 'after_messages' });
    expect(gates().current(kari)?.id).toBe(hat!.id);
    // Already facing it: nothing new fires.
    expect(gates().afterReply(subject, 3)).toBeUndefined();
    // Passed gates don't come back.
    gates().pass(hat!.id);
    expect(gates().afterReply(subject, 9)).toBeUndefined();
    expect(gates().current(kari)).toBeUndefined();
  });

  it('an after_messages gate waits while another gate is active', () => {
    setGates([gateJson('hat', { type: 'after_messages', count: 1 })]);
    const [cat] = gates().force([kari], { custom: { target: 'a cat', guestPrompt: 'Cat!' } }, null);
    expect(gates().afterReply({ id: kari, personSlug: null }, 1)).toBeUndefined();
    gates().pass(cat!.id);
    expect(gates().afterReply({ id: kari, personSlug: null }, 2)?.defKey).toBe('global/hat');
  });

  it("person after_messages gates only apply to that person's holder", () => {
    const ola = e.services.people.save({ name: 'Ola', aliases: [], info: '' }).slug;
    writeGates(path.join(e.config.peopleDir, ola, 'gates.json'), [gateJson('carrot', { type: 'after_messages', count: 1 })]);
    expect(gates().afterReply({ id: kari, personSlug: null }, 5)).toBeUndefined();
    expect(gates().afterReply({ id: kari, personSlug: ola }, 5)?.defKey).toBe(`${ola}/carrot`);
  });

  it('reports which sessions changed, once per batch and after the change is stored', async () => {
    const reports: string[][] = [];
    gates().onChange = (ids) => reports.push(ids.map((id) => `${id}:${gates().current(id)?.guestPrompt ?? 'none'}`));
    const per = e.services.sessions.create('Per').session.id;
    const forced = gates().force([kari, per], { custom: { target: 'a cat', guestPrompt: 'Cat!' } }, 60_000);
    expect(reports).toEqual([]); // not inside the transaction
    await Promise.resolve();
    expect(reports).toEqual([[`${kari}:Cat!`, `${per}:Cat!`]]);

    gates().cancel(forced[0]!.id);
    await Promise.resolve();
    expect(reports.at(-1)).toEqual([`${kari}:none`]);

    // Deadlines expire on the next look (the 5 s tick in production).
    e.tick(60_000);
    gates().tick(() => [], () => undefined);
    await Promise.resolve();
    expect(reports.at(-1)).toEqual([`${per}:none`]);
  });

  it('the oldest active gate is the one the guest faces', () => {
    const [a] = gates().force([kari], { custom: { target: 'a cat', guestPrompt: 'Cat!' } }, null);
    e.tick(1);
    gates().force([kari], { custom: { target: 'a dog', guestPrompt: 'Dog!' } }, null);
    expect(gates().current(kari)?.target).toBe('a cat');
    gates().pass(a!.id);
    expect(gates().current(kari)?.target).toBe('a dog');
  });

  it('admin can force a definition again, but triggers never repeat', () => {
    setGates([gateJson('pumpkin', { type: 'session_start' })]);
    const def = e.services.gateDefs().defs[0]!;
    gates().sessionStarted(kari);
    gates().pass(gates().current(kari)!.id);
    gates().force([kari], { def }, null);
    gates().sessionStarted(kari);
    expect(gates().forSession(kari).map((g) => [g.source, g.status])).toEqual([
      ['admin_forced', 'active'],
      ['session_start', 'passed'],
    ]);
  });

  it('forced gates can go to several sessions at once, with a deadline', () => {
    const bob = newSession('Bob');
    const made = gates().force([kari, bob], { custom: { target: 'a ghost', guestPrompt: 'Boo?' } }, 10 * 60_000);
    expect(made).toHaveLength(2);
    expect(made[0]!.deadlineAt).toBe(made[0]!.createdAt + 600_000);
    e.tick(10 * 60_000 - 1);
    expect(gates().current(bob)?.status).toBe('active');
    e.tick(1);
    expect(gates().current(bob)).toBeUndefined();
    expect(gates().forSession(bob)[0]).toMatchObject({ status: 'expired', resolvedAt: made[0]!.deadlineAt });
  });

  it('only active gates can be passed or cancelled', () => {
    const [g] = gates().force([kari], { custom: { target: 'x', guestPrompt: 'x' } }, null);
    expect(gates().cancel(g!.id).status).toBe('cancelled');
    expect(() => gates().pass(g!.id)).toThrow(GateError);
    expect(() => gates().pass('nope')).toThrow(/No such gate/);
  });

  it('counts refusals so refusal lines can rotate', () => {
    const [g] = gates().force([kari], { custom: { target: 'x', guestPrompt: 'x' } }, null);
    expect([gates().refused(g!.id), gates().refused(g!.id), gates().refused(g!.id)]).toEqual([0, 1, 2]);
  });

  it('the active list shows live sessions only', () => {
    const bob = newSession('Bob');
    gates().force([kari, bob], { custom: { target: 'x', guestPrompt: 'x' } }, null);
    e.services.sessions.end(bob);
    expect(gates().activeGates().map((g) => g.sessionName)).toEqual(['Kari']);
  });
});

describe('timed global gates', () => {
  let e: TestEnv;
  const start = 1_700_000_000_000; // makeEnv's clock
  const at = (ms: number) => new Date(start + ms).toISOString();

  beforeEach(() => {
    e = makeEnv();
  });

  it('fire at their time for every named live session, with a deadline, exactly once', () => {
    writeGates(e.config.gatesPath, [gateJson('pumpkin', { type: 'timed_global', at: at(60_000), deadline_minutes: 10 })]);
    const kari = e.services.sessions.create('Kari').session.id;
    const bob = e.services.sessions.create('Bob').session.id;
    e.services.sessions.releaseName(bob); // no name: not at the party right now
    e.services.tick();
    expect(e.services.gates.current(kari)).toBeUndefined();

    e.tick(60_000);
    e.services.tick();
    const g = e.services.gates.current(kari)!;
    expect(g).toMatchObject({ source: 'timed_global', deadlineAt: start + 60_000 + 600_000 });
    expect(e.services.gates.current(bob)).toBeUndefined();

    e.services.gates.pass(g.id);
    e.tick(1000);
    e.services.tick();
    expect(e.services.gates.current(kari)).toBeUndefined();
  });

  it('do not fire again after a restart', () => {
    const dir = path.dirname(e.config.gatesPath);
    const dbPath = path.join(dir, 'db.sqlite');
    const gatesPath = path.join(dir, 'gates.json');
    writeGates(gatesPath, [gateJson('pumpkin', { type: 'timed_global', at: at(0), deadline_minutes: 10 })]);
    const defs = () => ({ defs: e.services.gateDefs().defs, errors: [] });
    let now = start;
    const run = () => {
      const db = openDb(dbPath);
      const store = new GateStore(db, defs, () => now);
      store.tick(() => ['s1'], () => undefined);
      const n = (db.prepare('SELECT COUNT(*) AS n FROM gates').get() as { n: number }).n;
      db.close();
      return n;
    };
    // gates.session_id references sessions; insert one so the gate can be stored.
    const db = openDb(dbPath);
    db.prepare(`INSERT INTO sessions (id, token_hash, name, state, created_at, last_seen_at) VALUES ('s1', 'h', 'K', 'guest', 0, 0)`).run();
    db.close();
    expect(run()).toBe(1);
    now += 1000;
    expect(run()).toBe(1);
  });

  it('are skipped if the whole window passed while the server was down', () => {
    writeGates(e.config.gatesPath, [gateJson('pumpkin', { type: 'timed_global', at: at(-11 * 60_000), deadline_minutes: 10 })]);
    const kari = e.services.sessions.create('Kari').session.id;
    e.services.tick();
    expect(e.services.gates.forSession(kari)).toEqual([]);
  });

  it("a person's timed gate goes only to that person's holder", () => {
    const ola = e.services.people.save({ name: 'Ola', aliases: [], info: '' }).slug;
    writeGates(path.join(e.config.peopleDir, ola, 'gates.json'), [
      gateJson('carrot', { type: 'timed_global', at: at(0), deadline_minutes: 5 }),
    ]);
    const kari = e.services.sessions.create('Kari').session.id;
    const holder = e.services.sessions.create('Someone').session.id;
    e.services.sessions.assignPerson(holder, ola);
    e.services.tick();
    expect(e.services.gates.current(kari)).toBeUndefined();
    expect(e.services.gates.current(holder)?.defKey).toBe(`${ola}/carrot`);
  });
});

it('the example gates file in content/ is valid', () => {
  const file = path.resolve(import.meta.dirname, '../../../content/gates.json');
  const { defs, errors } = parseGateFile(fs.readFileSync(file, 'utf8'), null, 'content/gates.json');
  expect(errors).toEqual([]);
  expect(defs.length).toBeGreaterThan(0);
});
