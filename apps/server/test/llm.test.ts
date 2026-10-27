import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startBlackhole, startMockOllama, type MockOllama } from '../src/dev/mock-ollama.js';
import { DISCONNECTED_MESSAGE, probe, type ChatStatus } from '../src/llm.js';
import type { ChatMessage } from '../src/ollama.js';
import { createServices } from '../src/services.js';
import { adminCookie, makeConfig, makeEnv, newGuest, parseSse, refusedUrl, tempDir, tokenText, type TestEnv } from './helpers.js';

let model: MockOllama;
const msgs: ChatMessage[] = [{ role: 'user', content: 'hi' }];
let DEAD_URL: string;

beforeAll(async () => {
  model = await startMockOllama({ tokenDelayMs: 1 });
  DEAD_URL = await refusedUrl();
});
afterAll(async () => {
  await model.close();
});
beforeEach(() => {
  model.setMode({ kind: 'reply', text: 'from the PC' });
  model.requests.length = 0;
});

const env = (o: Record<string, string> = {}) =>
  makeEnv({
    OLLAMA_URL: model.url,
    // The mock has "mock:latest" pulled.
    OLLAMA_MODEL: 'mock',
    OLLAMA_CONNECT_TIMEOUT_MS: '200',
    OLLAMA_FIRST_TOKEN_TIMEOUT_MS: '800',
    ...o,
  });

async function ask(e: TestEnv): Promise<string> {
  let text = '';
  for await (const d of e.services.llm.chat(msgs)) text += d;
  return text;
}

const failure = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e);

/** Every status change the guests would be sent. */
function statusLog(e: TestEnv): ChatStatus[] {
  const seen: ChatStatus[] = [];
  e.services.llm.onStatusChange = (s) => seen.push(s);
  return seen;
}

const chat = (e: TestEnv, token: string) =>
  request(e.app).post('/api/chat').set('authorization', `Bearer ${token}`).send({ message: 'hi' });

describe('the model', () => {
  it('streams a reply with the configured model and options', async () => {
    const e = env();
    expect(await ask(e)).toBe('from the PC');
    expect(model.requests[0]).toMatchObject({ model: 'mock', think: false, options: { num_ctx: 4096 } });
  });

  it('a busy PC that answers within the first-token limit is not "down"', async () => {
    const e = env();
    model.setMode({ kind: 'delay', ms: 500, text: 'slow but fine' }); // > 200 ms connect timeout
    expect(await ask(e)).toBe('slow but fine');
    expect(e.services.llm.connected).toBe(true);
  });

  it('a PC too busy to start in time fails the reply but keeps chat open', async () => {
    const e = env();
    model.setMode({ kind: 'hang' });
    expect(await failure(ask(e))).toMatchObject({ kind: 'first_token_timeout' });
    expect(e.services.llm.status().open).toBe(true);
  });

  it('an unreachable PC fails the reply and closes chat at once', async () => {
    const e = env({ OLLAMA_URL: DEAD_URL });
    const seen = statusLog(e);
    expect(await failure(ask(e))).toMatchObject({ kind: 'unreachable' });
    expect(e.services.llm.status()).toEqual({ open: false, reason: 'disconnected', message: DISCONNECTED_MESSAGE });
    expect(seen).toEqual([{ open: false, reason: 'disconnected', message: DISCONNECTED_MESSAGE }]);
    expect(e.logged).toContain('Model unreachable, chat closed until it is back');
  });

  it('a dead PC behind a live tunnel is detected by the health check, not the first-token limit', async () => {
    const dead = await startBlackhole();
    const e = env({ OLLAMA_URL: dead.url });
    const t0 = Date.now();
    expect(await failure(ask(e))).toMatchObject({ kind: 'connect_timeout' });
    expect(Date.now() - t0).toBeLessThan(700);
    expect(e.services.llm.connected).toBe(false);
    await dead.close();
  });

  it('HTTP errors and broken streams fail the reply without closing chat', async () => {
    const e = env();
    model.setMode({ kind: 'http_error', status: 500 });
    expect(await failure(ask(e))).toMatchObject({ kind: 'http' });
    model.setMode({ kind: 'truncate' });
    expect(await failure(ask(e))).toMatchObject({ kind: 'stream' });
    expect(e.services.llm.connected).toBe(true);
  });

  it('a client abort does not close chat', async () => {
    const e = env();
    model.setMode({ kind: 'hang' });
    const ac = new AbortController();
    const pending = e.services.llm.chat(msgs, ac.signal).next();
    ac.abort();
    expect(await failure(pending)).toMatchObject({ kind: 'aborted' });
    expect(e.services.llm.connected).toBe(true);
  });
});

describe('model checks', () => {
  it('assume the model is up until the first check, so a restart does not close chat', () => {
    expect(env({ OLLAMA_URL: DEAD_URL }).services.llm.status().open).toBe(true);
  });

  it('close chat when the PC goes away and reopen it when it is back, reporting each change once', async () => {
    const e = env();
    const seen = statusLog(e);
    expect(await e.services.llm.check()).toMatchObject({ reachable: true, hasModel: true, checkedAt: expect.any(Number) });
    expect(seen).toEqual([]); // no change

    const dead = env({ OLLAMA_URL: DEAD_URL });
    const deadSeen = statusLog(dead);
    await dead.services.llm.check();
    await dead.services.llm.check();
    expect(deadSeen).toEqual([{ open: false, reason: 'disconnected', message: DISCONNECTED_MESSAGE }]);
    expect(dead.logged.filter((m) => m.startsWith('Model check failed'))).toHaveLength(1);
  });

  it('a successful reply reopens chat without waiting for the next check', async () => {
    const e = env();
    const seen = statusLog(e);
    // Down, as far as the app knows...
    (e.services.llm as unknown as { update(p: object): void }).update({ reachable: false });
    expect(e.services.llm.status().open).toBe(false);
    // ...but a request gets through (e.g. a reply that was already under way).
    expect(await ask(e)).toBe('from the PC');
    expect(e.services.llm.status().open).toBe(true);
    expect(seen.map((s) => s.open)).toEqual([false, true]);
  });

  it('a model that is not pulled counts as disconnected', async () => {
    const e = env({ OLLAMA_MODEL: 'qwen3-vl:8b-instruct' });
    expect(await e.services.llm.check()).toMatchObject({ reachable: true, hasModel: false, error: 'Model qwen3-vl:8b-instruct is not pulled' });
    expect(e.services.llm.status()).toMatchObject({ open: false, reason: 'disconnected' });
  });
});

describe('pause', () => {
  it('closes chat with the admin reason, which wins over "disconnected"', async () => {
    const e = env({ OLLAMA_URL: DEAD_URL });
    const seen = statusLog(e);
    e.services.llm.pause('Speeches! Back in 10 minutes.');
    await e.services.llm.check();
    expect(e.services.llm.status()).toEqual({ open: false, reason: 'paused', message: 'Speeches! Back in 10 minutes.' });
    e.services.llm.pause(null);
    expect(e.services.llm.status()).toMatchObject({ open: false, reason: 'disconnected' });
    expect(seen.map((s) => s.reason)).toEqual(['paused', 'disconnected']);
  });

  it('survives a restart', () => {
    const dbPath = path.join(tempDir(), 'db.sqlite');
    const e = env({ DB_PATH: dbPath });
    e.services.llm.pause('Back soon');
    e.services.db.close();
    const restarted = createServices(makeConfig({ DB_PATH: dbPath }), { write: () => {} });
    expect(restarted.llm.status()).toMatchObject({ open: false, message: 'Back soon' });
    restarted.db.close();
    expect(fs.existsSync(dbPath)).toBe(true);
  });
});

describe('guests while chat is closed', () => {
  it('get a 503 with the reason, and the model is never asked', async () => {
    const e = env();
    const { token } = await newGuest(e, 'Kari');
    e.services.llm.pause('Cake time.');
    const res = await chat(e, token);
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'Cake time.', code: 'chat_closed', status: { open: false, reason: 'paused', message: 'Cake time.' } });
    expect(model.requests).toHaveLength(0);

    e.services.llm.pause(null);
    expect(tokenText(parseSse((await chat(e, token)).text))).toBe('from the PC');
  });

  it('the guest who finds the PC gone gets an error, and the next guest finds chat closed', async () => {
    const e = env({ OLLAMA_URL: DEAD_URL });
    const { token } = await newGuest(e, 'Kari');
    const events = parseSse((await chat(e, token)).text);
    expect(events.at(-1)?.event).toBe('error');
    expect((await chat(e, (await newGuest(e, 'Per')).token)).status).toBe(503);
  });
});

describe('probe', () => {
  it('reports reachability and whether the model is pulled', async () => {
    expect(await probe(model.url, 'mock')).toMatchObject({ reachable: true, hasModel: true, error: null });
    expect(await probe(model.url, 'mock:latest')).toMatchObject({ reachable: true, hasModel: true });
    expect(await probe(model.url, 'qwen3-vl:8b')).toMatchObject({ reachable: true, hasModel: false });
    expect(await probe(DEAD_URL, 'mock')).toMatchObject({ reachable: false, hasModel: false });
  });
});

describe('admin system API', () => {
  it('checks the model live and shows recent errors', async () => {
    const e = env({ OLLAMA_URL: DEAD_URL });
    const res = await request(e.app).get('/api/admin/system').set('cookie', await adminCookie(e));
    expect(res.body).toMatchObject({
      model: { url: DEAD_URL, model: 'mock', reachable: false, checkedAt: expect.any(Number) },
      status: { open: false, reason: 'disconnected' },
      pauseReason: null,
      listeners: 0,
    });
    expect(res.body.errors[0].message).toMatch(/^Model check failed/);
  });

  it('pauses with a reason and resumes', async () => {
    const e = env();
    const cookie = await adminCookie(e);
    const put = (body: object) => request(e.app).put('/api/admin/system/pause').set('cookie', cookie).send(body);
    expect((await put({ reason: '  ' })).status).toBe(400);
    expect((await put({ reason: 'x'.repeat(301) })).status).toBe(400);
    expect((await put({})).status).toBe(400);
    const paused = await put({ reason: ' Speeches! ' });
    expect(paused.body).toEqual({ pauseReason: 'Speeches!', status: { open: false, reason: 'paused', message: 'Speeches!' } });
    const resumed = await request(e.app).delete('/api/admin/system/pause').set('cookie', cookie);
    expect(resumed.body).toEqual({ pauseReason: null, status: { open: true, reason: null, message: null } });
    expect((await request(e.app).put('/api/admin/system/pause').send({ reason: 'x' })).status).toBe(401);
  });
});
