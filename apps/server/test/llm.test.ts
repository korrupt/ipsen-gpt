import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startMockOllama, type MockOllama } from '../src/dev/mock-ollama.js';
import { probe, type Backend } from '../src/llm.js';
import type { ChatMessage } from '../src/ollama.js';
import { createServices } from '../src/services.js';
import { adminCookie, makeConfig, makeEnv, newGuest, parseSse, tempDir, tokenText, type TestEnv } from './helpers.js';

let primary: MockOllama;
let fallback: MockOllama;
const msgs: ChatMessage[] = [{ role: 'user', content: 'hi' }];
const DEAD_URL = 'http://127.0.0.1:1';

beforeAll(async () => {
  primary = await startMockOllama({ tokenDelayMs: 1 });
  fallback = await startMockOllama({ tokenDelayMs: 1 });
});
afterAll(async () => {
  await primary.close();
  await fallback.close();
});
beforeEach(() => {
  primary.setMode({ kind: 'reply', text: 'from primary' });
  fallback.setMode({ kind: 'reply', text: 'from fallback' });
  primary.requests.length = 0;
  fallback.requests.length = 0;
});

const env = (o: Record<string, string> = {}) =>
  makeEnv({
    OLLAMA_URL: primary.url,
    OLLAMA_MODEL: 'big:8b',
    OLLAMA_FALLBACK_URL: fallback.url,
    OLLAMA_FALLBACK_MODEL: 'small:1b',
    OLLAMA_CONNECT_TIMEOUT_MS: '200',
    OLLAMA_PRIMARY_RETRY_MS: '30000',
    ...o,
  });

async function ask(e: TestEnv): Promise<{ text: string; backend: Backend | null }> {
  let backend: Backend | null = null;
  let text = '';
  for await (const d of e.services.llm.chat(msgs, undefined, (b) => (backend = b))) text += d;
  return { text, backend };
}

const failure = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e);

describe('primary/fallback switching', () => {
  it('uses the primary model when it is healthy', async () => {
    const e = env();
    expect(await ask(e)).toEqual({ text: 'from primary', backend: 'primary' });
    expect(primary.requests[0]).toMatchObject({ model: 'big:8b', think: false });
    expect(fallback.requests).toHaveLength(0);
  });

  it('falls back within the same request when the primary is unreachable', async () => {
    const e = env({ OLLAMA_URL: DEAD_URL });
    expect(await ask(e)).toEqual({ text: 'from fallback', backend: 'fallback' });
    expect(fallback.requests[0]).toMatchObject({ model: 'small:1b', think: false, options: { num_ctx: 4096 } });
    expect(e.logged).toContain('Primary model failed, using fallback');
  });

  it('falls back when the primary does not answer within the connect timeout (~3 s in prod)', async () => {
    const e = env();
    primary.setMode({ kind: 'hang' });
    const t0 = Date.now();
    expect((await ask(e)).backend).toBe('fallback');
    expect(Date.now() - t0).toBeLessThan(1500);
  });

  it('falls back on primary HTTP errors (e.g. model not pulled)', async () => {
    const e = env();
    primary.setMode({ kind: 'http_error', status: 404 });
    expect((await ask(e)).backend).toBe('fallback');
  });

  it('skips a failed primary for the retry window, then tries it again', async () => {
    const e = env();
    primary.setMode({ kind: 'http_error', status: 500 });
    await ask(e);
    expect(primary.requests).toHaveLength(1);

    primary.setMode({ kind: 'reply', text: 'from primary' });
    e.tick(10_000);
    expect((await ask(e)).backend).toBe('fallback');
    expect(primary.requests).toHaveLength(1); // not even tried

    e.tick(20_001);
    expect((await ask(e)).backend).toBe('primary');
    expect(e.services.llm.lastUsed).toBe('primary');
  });

  it('with retry window 0, retries the primary on every request', async () => {
    const e = env({ OLLAMA_PRIMARY_RETRY_MS: '0' });
    primary.setMode({ kind: 'http_error', status: 500 });
    await ask(e);
    await ask(e);
    expect(primary.requests).toHaveLength(2);
  });

  it('force fallback never contacts the primary', async () => {
    const e = env();
    e.services.settings.set('forceFallback', true);
    expect((await ask(e)).backend).toBe('fallback');
    expect(primary.requests).toHaveLength(0);
  });

  it('does not switch models in the middle of a reply', async () => {
    const e = env();
    primary.setMode({ kind: 'truncate' });
    const err = await failure(ask(e));
    expect(err).toMatchObject({ kind: 'stream' });
    expect(fallback.requests).toHaveLength(0);
  });

  it('fails when both models are down', async () => {
    const e = env({ OLLAMA_URL: DEAD_URL, OLLAMA_FALLBACK_URL: 'http://127.0.0.1:2' });
    expect(await failure(ask(e))).toMatchObject({ kind: 'unreachable' });
  });

  it('without a fallback configured, primary errors surface directly', async () => {
    const e = env({ OLLAMA_URL: DEAD_URL, OLLAMA_FALLBACK_URL: '' });
    expect(await failure(ask(e))).toMatchObject({ kind: 'unreachable' });
    expect(e.services.llm.plan()).toEqual(['primary']);
  });

  it('a client abort neither falls back nor marks the primary down', async () => {
    const e = env();
    primary.setMode({ kind: 'hang' });
    const ac = new AbortController();
    const gen = e.services.llm.chat(msgs, ac.signal);
    const pending = gen.next();
    ac.abort();
    expect(await failure(pending)).toMatchObject({ kind: 'aborted' });
    expect(fallback.requests).toHaveLength(0);
    expect(e.services.llm.plan()).toEqual(['primary', 'fallback']);
  });

  it('guests get a normal reply over HTTP when the PC is off', async () => {
    const e = env({ OLLAMA_URL: DEAD_URL });
    const { token } = await newGuest(e, 'Kari');
    const res = await request(e.app).post('/api/chat').set('authorization', `Bearer ${token}`).send({ message: 'hi' });
    expect(tokenText(parseSse(res.text))).toBe('from fallback');
  });
});

describe('probe', () => {
  it('reports reachability and whether the model is pulled', async () => {
    expect(await probe(primary.url, 'mock')).toMatchObject({ reachable: true, hasModel: true, error: null });
    expect(await probe(primary.url, 'mock:latest')).toMatchObject({ reachable: true, hasModel: true });
    expect(await probe(primary.url, 'qwen3-vl:8b')).toMatchObject({ reachable: true, hasModel: false });
    expect(await probe(DEAD_URL, 'mock')).toMatchObject({ reachable: false, hasModel: false });
  });
});

describe('admin system API', () => {
  it('shows model status and recent errors', async () => {
    const e = env({ OLLAMA_URL: DEAD_URL });
    await ask(e);
    const res = await request(e.app).get('/api/admin/system').set('cookie', await adminCookie(e));
    expect(res.body.llm).toMatchObject({
      forceFallback: false,
      lastUsed: 'fallback',
      primary: { url: DEAD_URL, model: 'big:8b', reachable: false },
      fallback: { url: fallback.url, model: 'small:1b', reachable: true },
    });
    expect(res.body.llm.primarySkippedUntil).toBeGreaterThan(0);
    expect(res.body.errors[0]).toMatchObject({ message: 'Primary model failed, using fallback' });
    expect(res.body.errors[0].detail).toMatch(/unreachable/i);
  });

  it('toggles force-fallback, which survives a restart', async () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'db.sqlite');
    const e = env({ DB_PATH: dbPath });
    const cookie = await adminCookie(e);
    const on = await request(e.app).post('/api/admin/system/force-fallback').set('cookie', cookie).send({ enabled: true });
    expect(on.body).toEqual({ forceFallback: true });
    expect((await ask(e)).backend).toBe('fallback');
    e.services.db.close();

    const restarted = createServices(makeConfig({ DB_PATH: dbPath, OLLAMA_FALLBACK_URL: fallback.url }), { write: () => {} });
    expect(restarted.settings.get('forceFallback')).toBe(true);
    restarted.db.close();
    expect(fs.existsSync(dbPath)).toBe(true);
  });

  it('refuses to force a fallback that is not configured, and validates input', async () => {
    const e = env({ OLLAMA_FALLBACK_URL: '' });
    const cookie = await adminCookie(e);
    const post = (body: object) => request(e.app).post('/api/admin/system/force-fallback').set('cookie', cookie).send(body);
    expect((await post({ enabled: true })).status).toBe(409);
    expect((await post({ enabled: 'yes' })).status).toBe(400);
    expect((await post({ enabled: false })).status).toBe(200);
    expect((await request(e.app).get('/api/admin/system')).status).toBe(401);
  });
});
