import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startMockOllama, type MockOllama } from '../src/dev/mock-ollama.js';
import { DISCONNECTED_MESSAGE } from '../src/llm.js';
import { adminCookie, gateJson, makeEnv, newGuest, writeGates, type TestEnv } from './helpers.js';

let model: MockOllama;
beforeAll(async () => {
  model = await startMockOllama({ tokenDelayMs: 1 });
});
afterAll(async () => {
  await model.close();
});

const servers: Server[] = [];
const streams: AbortController[] = [];
afterEach(async () => {
  for (const s of streams.splice(0)) s.abort();
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

const env = (gates: unknown[] = []) =>
  makeEnv({ OLLAMA_URL: model.url, OLLAMA_MODEL: 'mock' }, (config) => writeGates(config.gatesPath, gates));

async function listen(e: TestEnv): Promise<string> {
  const server = e.app.listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise((r) => server.once('listening', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

interface Live {
  /** Resolves with the data of the next `event` (skipping others). */
  next(event: string): Promise<unknown>;
  close(): void;
}

/** Opens /api/events like the guest app does: fetch with the token in a header. */
async function connect(base: string, token: string): Promise<Live> {
  const ac = new AbortController();
  streams.push(ac);
  const res = await fetch(`${base}/api/events`, { headers: { authorization: `Bearer ${token}` }, signal: ac.signal });
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toMatch(/^text\/event-stream/);
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  const queue: { event: string; data: unknown }[] = [];
  let buffer = '';
  const next = async (event: string): Promise<unknown> => {
    for (;;) {
      const i = queue.findIndex((q) => q.event === event);
      if (i >= 0) return queue.splice(0, i + 1).at(-1)!.data;
      const { value, done } = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`no "${event}" event within 2 s`)), 2000)),
      ]);
      if (done) throw new Error('stream ended');
      buffer += value;
      let end: number;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, end).split('\n');
        buffer = buffer.slice(end + 2);
        const name = block.find((l) => l.startsWith('event: '))?.slice(7);
        const data = block.find((l) => l.startsWith('data: '))?.slice(6);
        if (name && data) queue.push({ event: name, data: JSON.parse(data) });
      }
    }
  };
  return { next, close: () => ac.abort() };
}

const OPEN = { open: true, reason: null, message: null };

describe('GET /api/events', () => {
  it('needs a valid session', async () => {
    const e = env();
    expect((await request(e.app).get('/api/events')).status).toBe(401);
    expect((await request(e.app).get('/api/events').set('authorization', 'Bearer nope')).status).toBe(401);
  });

  it('starts with the current chat status and gate', async () => {
    const e = env([gateJson('pumpkin', { type: 'session_start' })]);
    const { token, body } = await newGuest(e, 'Kari');
    const live = await connect(await listen(e), token);
    expect(await live.next('status')).toEqual(OPEN);
    expect(await live.next('gate')).toEqual({ gate: { id: body.gate.id, prompt: 'Show me a pumpkin!', deadlineAt: null } });
  });

  it('pushes a gate the admin forces at once, and its removal when cancelled', async () => {
    const e = env([gateJson('candle', { type: 'admin_forced' })]);
    const { token } = await newGuest(e, 'Kari');
    const live = await connect(await listen(e), token);
    expect(await live.next('gate')).toEqual({ gate: null });

    const cookie = await adminCookie(e);
    await request(e.app).post('/api/admin/gates/force').set('cookie', cookie).send({ all: true, key: 'global/candle' });
    const forced = (await live.next('gate')) as { gate: { id: string; prompt: string } };
    expect(forced.gate.prompt).toBe('Show me a candle!');

    await request(e.app).post(`/api/admin/gates/${forced.gate.id}/cancel`).set('cookie', cookie);
    expect(await live.next('gate')).toEqual({ gate: null });
  });

  it('only tells the guest it concerns', async () => {
    const e = env();
    const kari = await newGuest(e, 'Kari');
    const per = await newGuest(e, 'Per');
    const base = await listen(e);
    const kariLive = await connect(base, kari.token);
    const perLive = await connect(base, per.token);
    await kariLive.next('gate');
    await perLive.next('gate');
    const perId = e.services.sessions.byToken(per.token)!.id;
    e.services.gates.force([perId], { custom: { target: 'a cat', guestPrompt: 'Cat!' } }, null);
    expect(await perLive.next('gate')).toMatchObject({ gate: { prompt: 'Cat!' } });
    await expect(kariLive.next('gate')).rejects.toThrow(/no "gate" event/);
  });

  it('pushes pause, resume and a lost PC to everyone', async () => {
    const e = env();
    const { token } = await newGuest(e, 'Kari');
    const live = await connect(await listen(e), token);
    expect(await live.next('status')).toEqual(OPEN);

    const cookie = await adminCookie(e);
    await request(e.app).put('/api/admin/system/pause').set('cookie', cookie).send({ reason: 'Speeches!' });
    expect(await live.next('status')).toEqual({ open: false, reason: 'paused', message: 'Speeches!' });
    await request(e.app).delete('/api/admin/system/pause').set('cookie', cookie);
    expect(await live.next('status')).toEqual(OPEN);

    (e.services.llm as unknown as { update(p: object): void }).update({ reachable: false });
    expect(await live.next('status')).toEqual({ open: false, reason: 'disconnected', message: DISCONNECTED_MESSAGE });
    await e.services.llm.check(); // the PC is back
    expect(await live.next('status')).toEqual(OPEN);
  });

  it('pushes an after_messages gate the moment it fires', async () => {
    const e = env([gateJson('hat', { type: 'after_messages', count: 1 })]);
    const { token } = await newGuest(e, 'Kari');
    const live = await connect(await listen(e), token);
    expect(await live.next('gate')).toEqual({ gate: null });
    await request(e.app).post('/api/chat').set('authorization', `Bearer ${token}`).send({ message: 'hi' });
    expect(await live.next('gate')).toMatchObject({ gate: { prompt: 'Show me a hat!' } });
  });

  it('stops sending to a closed stream and counts open ones', async () => {
    const e = env();
    const { token } = await newGuest(e, 'Kari');
    const base = await listen(e);
    const a = await connect(base, token);
    const b = await connect(base, token);
    await a.next('status');
    await b.next('status');
    expect(e.services.events.connections).toBe(2);
    a.close();
    for (let i = 0; i < 50 && e.services.events.connections > 1; i++) await new Promise((r) => setTimeout(r, 10));
    expect(e.services.events.connections).toBe(1);
  });
});
