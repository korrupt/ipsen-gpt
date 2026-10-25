import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startBlackhole, startMockOllama, type MockOllama } from '../src/dev/mock-ollama.js';
import { OllamaError, streamChat, type ChatMessage } from '../src/ollama.js';
import { makeConfig, refusedUrl } from './helpers.js';

let mock: MockOllama;
const msgs: ChatMessage[] = [
  { role: 'system', content: 'sys' },
  { role: 'user', content: 'hi' },
];

beforeAll(async () => {
  mock = await startMockOllama({ tokenDelayMs: 1 });
});
afterAll(() => mock.close());
beforeEach(() => {
  mock.setMode({ kind: 'reply' });
  mock.requests.length = 0;
});

const cfg = (o: Record<string, string> = {}) => makeConfig({ OLLAMA_URL: mock.url, ...o }).ollama;

async function collect(gen: AsyncGenerator<string>): Promise<string> {
  let out = '';
  for await (const d of gen) out += d;
  return out;
}

async function expectKind(p: Promise<unknown>, kind: OllamaError['kind']) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(OllamaError);
  expect((err as OllamaError).kind).toBe(kind);
}

describe('streamChat', () => {
  it('streams the full reply', async () => {
    mock.setMode({ kind: 'reply', text: 'Boo, said the ghost.' });
    expect(await collect(streamChat(cfg(), msgs))).toBe('Boo, said the ghost.');
  });

  it('always sends think:false, num_ctx and streaming', async () => {
    await collect(streamChat(cfg({ OLLAMA_NUM_CTX: '2048', OLLAMA_MODEL: 'm:1' }), msgs));
    expect(mock.requests[0]).toMatchObject({
      model: 'm:1',
      stream: true,
      think: false,
      options: { num_ctx: 2048 },
      messages: msgs,
    });
  });

  it('fails fast with connect_timeout when the machine accepts connections but is dead', async () => {
    const dead = await startBlackhole();
    const t0 = Date.now();
    await expectKind(
      collect(streamChat(cfg({ OLLAMA_URL: dead.url, OLLAMA_CONNECT_TIMEOUT_MS: '200', OLLAMA_FIRST_TOKEN_TIMEOUT_MS: '5000' }), msgs)),
      'connect_timeout',
    );
    expect(Date.now() - t0).toBeLessThan(1000); // the health check, not the 5 s first-token limit
    await dead.close();
  });

  it('waits past the connect timeout for a busy but alive Ollama', async () => {
    mock.setMode({ kind: 'delay', ms: 600, text: 'Sorry, busy.' });
    const out = await collect(
      streamChat(cfg({ OLLAMA_CONNECT_TIMEOUT_MS: '200', OLLAMA_FIRST_TOKEN_TIMEOUT_MS: '3000' }), msgs),
    );
    expect(out).toBe('Sorry, busy.');
  });

  it('fails with first_token_timeout when Ollama is alive but never starts replying', async () => {
    mock.setMode({ kind: 'hang' });
    const t0 = Date.now();
    await expectKind(
      collect(streamChat(cfg({ OLLAMA_CONNECT_TIMEOUT_MS: '100', OLLAMA_FIRST_TOKEN_TIMEOUT_MS: '500' }), msgs)),
      'first_token_timeout',
    );
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(450);
    expect(elapsed).toBeLessThan(1500);
  });

  it('the first-token limit does not cut off a reply that has started', async () => {
    mock.setMode({ kind: 'reply', text: Array.from({ length: 40 }, (_, i) => `w${i}`).join(' ') });
    const slow = await startMockOllama({ tokenDelayMs: 20, mode: { kind: 'reply', text: Array.from({ length: 40 }, (_, i) => `w${i}`).join(' ') } });
    const out = await collect(streamChat(cfg({ OLLAMA_URL: slow.url, OLLAMA_FIRST_TOKEN_TIMEOUT_MS: '300' }), msgs));
    expect(out.split(' ')).toHaveLength(40); // ~800 ms total, well past 300 ms
    await slow.close();
  });

  it('fails with unreachable when nothing listens', async () => {
    await expectKind(collect(streamChat(cfg({ OLLAMA_URL: await refusedUrl() }), msgs)), 'unreachable');
  });

  it('fails with http on a non-2xx response', async () => {
    mock.setMode({ kind: 'http_error', status: 404 });
    await expectKind(collect(streamChat(cfg(), msgs)), 'http');
  });

  it('fails with stream on an error chunk', async () => {
    mock.setMode({ kind: 'stream_error' });
    await expectKind(collect(streamChat(cfg(), msgs)), 'stream');
  });

  it('fails with stream when the connection drops before done', async () => {
    mock.setMode({ kind: 'truncate' });
    await expectKind(collect(streamChat(cfg(), msgs)), 'stream');
  });

  it('reports aborted when the caller aborts', async () => {
    const ac = new AbortController();
    const gen = streamChat(cfg(), msgs, ac.signal);
    const first = await gen.next();
    expect(first.done).toBe(false);
    ac.abort();
    await expectKind(collect(gen), 'aborted');
  });
});
