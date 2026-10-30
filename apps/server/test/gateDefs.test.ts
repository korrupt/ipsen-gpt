import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { GateDefStore, parseGateKey, type GateDefInput } from '../src/gateDefs.js';
import { PeopleStore } from '../src/people.js';
import { adminCookie, gateJson, makeEnv, tempDir, writeGates, writePerson } from './helpers.js';

const input = (over: Partial<GateDefInput> = {}): GateDefInput => ({
  id: 'haiku',
  kind: 'text',
  target: 'a haiku about pumpkins',
  guestPrompt: 'Write me a haiku about pumpkins.',
  refusalLines: [],
  points: 5,
  trigger: { type: 'admin_forced' },
  ...over,
});

function setup({ shipped = [gateJson('pumpkin', { type: 'admin_forced' })] }: { shipped?: unknown[] } = {}) {
  const dir = tempDir();
  const people = new PeopleStore(path.join(dir, 'people'));
  writePerson(people.dir, 'ola', 'Ola Nordmann', [], '');
  people.load();
  const seed = path.join(dir, 'content', 'gates.json');
  writeGates(seed, shipped);
  const gatesPath = path.join(dir, 'data', 'gates.json');
  const store = new GateDefStore(gatesPath, people, seed);
  const raw = (file = gatesPath) => JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>[];
  return { dir, people, store, seed, gatesPath, raw, olaFile: path.join(people.dir, 'ola', 'gates.json') };
}

describe('parseGateKey', () => {
  it('splits scope and id', () => {
    expect(parseGateKey('global/pumpkin')).toEqual({ personSlug: null, id: 'pumpkin' });
    expect(parseGateKey('ola/carrot')).toEqual({ personSlug: 'ola', id: 'carrot' });
    expect(parseGateKey('pumpkin')).toBeNull();
    expect(parseGateKey('global/Not Valid')).toBeNull();
  });
});

describe('GateDefStore', () => {
  it('copies the shipped gates on first start only', () => {
    const { store, raw } = setup();
    expect(store.seed()).toBe(true);
    expect(raw().map((g) => g.id)).toEqual(['pumpkin']);
    store.delete('global/pumpkin');
    expect(store.seed()).toBe(false);
    expect(raw()).toEqual([]);
  });

  it('does not seed a file onto itself', () => {
    const { people, seed } = setup();
    expect(new GateDefStore(seed, people, seed).seed()).toBe(false);
    expect(new GateDefStore(seed, people, seed).shipped()).toEqual([]);
  });

  it('creates gates for everyone and for one person, in snake_case', () => {
    const { store, raw, olaFile } = setup();
    store.seed();
    const def = store.create(null, input());
    expect(def).toMatchObject({ key: 'global/haiku', kind: 'text', personSlug: null, points: 5 });
    expect(raw().at(-1)).toEqual({
      id: 'haiku',
      kind: 'text',
      target: 'a haiku about pumpkins',
      guest_prompt: 'Write me a haiku about pumpkins.',
      refusal_lines: [],
      points: 5,
      trigger: { type: 'admin_forced' },
    });
    expect(store.create('ola', input()).key).toBe('ola/haiku');
    expect(raw(olaFile).map((g) => g.id)).toEqual(['haiku']);
    expect(store.load().defs.map((d) => d.key)).toEqual(['global/pumpkin', 'global/haiku', 'ola/haiku']);
  });

  it('refuses duplicates, bad fields and unknown people', () => {
    const { store } = setup();
    store.create(null, input());
    expect(() => store.create(null, input())).toThrow(/already a gate "haiku"/);
    expect(() => store.create(null, input({ id: 'Bad Id' }))).toThrow(/^id:/);
    expect(() => store.create(null, input({ id: 'x', target: '  ' }))).toThrow(/^target:/);
    expect(() => store.create(null, input({ id: 'x', points: -1 }))).toThrow(/^points:/);
    expect(() => store.create(null, input({ id: 'x', trigger: { type: 'after_messages', count: 0 } }))).toThrow(/^trigger/);
    expect(() => store.create(null, input({ id: 'x', trigger: { type: 'nope' } as never }))).toThrow(/^trigger/);
    expect(() => store.create('nobody', input())).toThrow(/No such person/);
  });

  it('edits a gate in place; the id stays', () => {
    const { store, raw } = setup();
    store.seed();
    store.create(null, input());
    const def = store.update('global/haiku', null, { ...input(), kind: 'photo', target: 'a pumpkin pie', points: 8 });
    expect(def).toMatchObject({ key: 'global/haiku', kind: 'photo', target: 'a pumpkin pie', points: 8 });
    expect(raw().map((g) => g.id)).toEqual(['pumpkin', 'haiku']);
    expect(() => store.update('global/nope', null, input())).toThrow(/No such gate/);
  });

  it('moves a gate between everyone and a person', () => {
    const { store, raw, olaFile } = setup();
    store.create(null, input());
    expect(store.update('global/haiku', 'ola', input()).key).toBe('ola/haiku');
    expect(raw()).toEqual([]);
    expect(raw(olaFile).map((g) => g.id)).toEqual(['haiku']);

    store.create(null, input());
    expect(() => store.update('ola/haiku', null, input())).toThrow(/already a gate "haiku" for everyone/);
    expect(raw(olaFile).map((g) => g.id)).toEqual(['haiku']);
  });

  it('deletes, and keeps entries it cannot parse untouched', () => {
    const { store, gatesPath, raw } = setup();
    writeGates(gatesPath, [{ id: 'broken', target: 5 }, gateJson('keep', { type: 'admin_forced' })]);
    expect(store.load().errors).toHaveLength(1);
    store.create(null, input());
    store.delete('global/keep');
    expect(raw().map((g) => g.id)).toEqual(['broken', 'haiku']);
    expect(raw()[0]).toEqual({ id: 'broken', target: 5 });
    expect(() => store.delete('global/keep')).toThrow(/No such gate/);
  });

  it('refuses to edit a file that is not a JSON array', () => {
    const { store, gatesPath } = setup();
    fs.mkdirSync(path.dirname(gatesPath), { recursive: true });
    fs.writeFileSync(gatesPath, '{ nope');
    expect(() => store.create(null, input())).toThrow(/not valid JSON/);
  });

  it('adds back or resets a shipped gate', () => {
    const { store, raw } = setup();
    store.seed();
    store.update('global/pumpkin', null, { ...input(), target: 'edited' });
    expect(store.restore('pumpkin').target).toBe('a pumpkin');
    store.delete('global/pumpkin');
    expect(store.restore('pumpkin').key).toBe('global/pumpkin');
    expect(raw().map((g) => g.id)).toEqual(['pumpkin']);
    expect(() => store.restore('nope')).toThrow(/No shipped gate/);
  });
});

describe('admin gate definitions over HTTP', () => {
  const env = () => {
    const e = makeEnv({ GATES_SEED_PATH: 'shipped.json', GATES_PATH: 'data/gates.json' }, (c) =>
      writeGates(path.join(path.dirname(c.gatesPath), '..', 'shipped.json'), [
        gateJson('pumpkin', { type: 'admin_forced' }),
        gateJson('candle', { type: 'admin_forced' }),
      ]),
    );
    writePerson(e.config.peopleDir, 'ola', 'Ola Nordmann', [], '');
    e.services.people.load();
    return e;
  };
  const body = (over: Record<string, unknown> = {}) => ({
    for: null,
    kind: 'text',
    target: 'a haiku about pumpkins',
    guestPrompt: 'Write me a haiku.',
    refusalLines: ['  No.  ', ''],
    points: 5,
    trigger: { type: 'after_messages', count: 3 },
    ...over,
  });

  it('lists definitions with their shipped state, and creates, edits, moves and deletes', async () => {
    const e = env();
    const cookie = await adminCookie(e);
    const agent = (m: 'get' | 'post' | 'put' | 'delete', url: string) => request(e.app)[m](`/api/admin${url}`).set('cookie', cookie);

    let list = await agent('get', '/gates');
    expect(list.body.definitions.map((d: { key: string; shipped: string }) => [d.key, d.shipped])).toEqual([
      ['global/pumpkin', 'same'],
      ['global/candle', 'same'],
    ]);
    expect(list.body.missingShipped).toEqual([]);

    const created = await agent('post', '/gate-defs').send({ ...body(), id: 'haiku' });
    expect(created.status).toBe(200);
    expect(created.body.definition).toMatchObject({ key: 'global/haiku', kind: 'text', refusalLines: ['No.'], person: null });
    expect((await agent('post', '/gate-defs').send({ ...body(), id: 'haiku' })).status).toBe(409);
    expect((await agent('post', '/gate-defs').send({ ...body({ target: '' }), id: 'x' })).body.error).toMatch(/^target:/);

    const edited = await agent('put', '/gate-defs/global/pumpkin').send(body({ kind: 'photo', target: 'a big pumpkin' }));
    expect(edited.body.definition).toMatchObject({ key: 'global/pumpkin', target: 'a big pumpkin' });
    const moved = await agent('put', '/gate-defs/global/haiku').send(body({ for: 'ola' }));
    expect(moved.body.definition).toMatchObject({ key: 'ola/haiku', person: { slug: 'ola', name: 'Ola Nordmann' } });
    expect((await agent('delete', '/gate-defs/global/candle')).status).toBe(200);
    expect((await agent('delete', '/gate-defs/global/candle')).status).toBe(404);

    list = await agent('get', '/gates');
    expect(list.body.definitions.map((d: { key: string; shipped: string | null }) => [d.key, d.shipped])).toEqual([
      ['global/pumpkin', 'changed'],
      ['ola/haiku', null],
    ]);
    expect(list.body.missingShipped.map((d: { id: string }) => d.id)).toEqual(['candle']);

    expect((await agent('post', '/gate-defs/restore/candle')).body.definition.key).toBe('global/candle');
    expect((await agent('post', '/gate-defs/restore/pumpkin')).body.definition.target).toBe('a pumpkin');
  });

  it('needs a login', async () => {
    const e = env();
    expect((await request(e.app).post('/api/admin/gate-defs').send({ ...body(), id: 'x' })).status).toBe(401);
  });
});
