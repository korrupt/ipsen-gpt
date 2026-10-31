import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startMockOllama, type MockOllama } from '../src/dev/mock-ollama.js';
import { parseGateFile } from '../src/gateDefs.js';
import { RANDOM_GATE_GAP } from '../src/gates.js';
import { gateJson, makeEnv, newGuest, parseSse, writeGates, writePerson, type TestEnv } from './helpers.js';

let mock: MockOllama;
beforeAll(async () => {
  mock = await startMockOllama({ tokenDelayMs: 1 });
});
afterAll(() => mock.close());
beforeEach(() => mock.setMode({ kind: 'reply', text: 'Sad reply.' }));

const random = (id: string, over: object = {}) =>
  gateJson(id, { type: 'random', after_messages: 2, chance: 0.5, ...over });

/** An env whose dice always show `roll` (change it with dice.roll = ...). */
function env(gates: unknown[], dice = { roll: 0 }) {
  const e = makeEnv({ OLLAMA_URL: mock.url, RATE_CHAT_SESSION: '1000/60' }, (c) => writeGates(c.gatesPath, gates), {
    random: () => dice.roll,
  });
  return { e, dice };
}

async function guest(e: TestEnv) {
  const { token } = await newGuest(e, 'Kari');
  return { token, id: e.services.sessions.byToken(token)!.id };
}

/** Sends a message; returns the gate event that came with the reply, if any. */
async function say(e: TestEnv, token: string) {
  const res = await request(e.app).post('/api/chat').set('authorization', `Bearer ${token}`).send({ message: 'hi' });
  e.tick(1000);
  return parseSse(res.text).find((ev) => ev.event === 'gate')?.data as { id: string } | undefined;
}

describe('the random trigger', () => {
  it('needs a chance above 0 and at most 1, and a whole after_messages', () => {
    const parse = (t: object) => parseGateFile(JSON.stringify([gateJson('x', t)]), null, 'g').errors;
    expect(parse({ type: 'random', after_messages: 3, chance: 0.1 })).toEqual([]);
    expect(parse({ type: 'random', after_messages: 3, chance: 0 })).toHaveLength(1);
    expect(parse({ type: 'random', after_messages: 3, chance: 1.5 })).toHaveLength(1);
    expect(parse({ type: 'random', after_messages: 1.5, chance: 0.1 })).toHaveLength(1);
  });
});

describe('random gates', () => {
  it('spring only once the guest has sent enough messages, and arrive with the reply', async () => {
    const { e } = env([random('hat')]);
    const g = await guest(e);
    expect(await say(e, g.token)).toBeUndefined();
    const gate = await say(e, g.token);
    expect(gate).toMatchObject({ prompt: 'Show me a hat!' });
    expect(e.services.gates.current(g.id)).toMatchObject({ source: 'random', defKey: 'global/hat' });
  });

  it('never spring when the dice say no', async () => {
    const { e } = env([random('hat', { chance: 0.3 })], { roll: 0.3 });
    const g = await guest(e);
    for (let i = 0; i < 6; i++) expect(await say(e, g.token)).toBeUndefined();
  });

  it(`leave ${RANDOM_GATE_GAP} messages of peace after a gate, then spring another one, each gate once`, async () => {
    const { e } = env([random('hat'), random('cat')]);
    const g = await guest(e);
    await say(e, g.token);
    const first = await say(e, g.token);
    expect(first).toBeDefined();
    e.services.gates.pass(first!.id);
    e.tick(1000);

    for (let i = 0; i < RANDOM_GATE_GAP - 1; i++) expect(await say(e, g.token)).toBeUndefined();
    const second = await say(e, g.token);
    expect(second).toBeDefined();
    const keys = e.services.gates.forSession(g.id).map((x) => x.defKey).sort();
    expect(keys).toEqual(['global/cat', 'global/hat']);

    e.services.gates.cancel(second!.id);
    e.tick(1000);
    for (let i = 0; i < 6; i++) expect(await say(e, g.token)).toBeUndefined();
  });

  it('a gate forced earlier never comes back at random', async () => {
    const { e } = env([random('hat')]);
    const g = await guest(e);
    const def = e.services.gateDefs().defs[0]!;
    const [forced] = e.services.gates.force([g.id], { def }, null);
    e.services.gates.cancel(forced!.id);
    e.tick(1000);
    for (let i = 0; i < 6; i++) expect(await say(e, g.token)).toBeUndefined();
  });

  it("an after_messages gate wins over the random pool, and a person's random gates are only theirs", async () => {
    const { e } = env([gateJson('fixed', { type: 'after_messages', count: 2 }), random('hat')]);
    writePerson(e.config.peopleDir, 'ola', 'Ola', [], '');
    e.services.people.load();
    writeGates(`${e.config.peopleDir}/ola/gates.json`, [random('carrot', { after_messages: 0, chance: 1 })]);
    const g = await guest(e);
    await say(e, g.token);
    expect(e.services.gates.current(g.id)).toBeUndefined();
    await say(e, g.token);
    expect(e.services.gates.current(g.id)?.defKey).toBe('global/fixed');
    expect(e.services.gates.forSession(g.id).some((x) => x.defKey === 'ola/carrot')).toBe(false);
  });
});
