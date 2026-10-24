import { vi } from 'vitest';

export const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

export const tokens = (...parts: string[]) => parts.map((t) => sse('token', { text: t })).join('');

/** A Response whose body streams the given chunks; pending chunks wait for `release()`. */
export function streamResponse(chunks: string[], { hold = false, signal }: { hold?: boolean; signal?: AbortSignal | null } = {}) {
  let release!: () => void;
  const released = new Promise<void>((r) => (release = r));
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      // Like real fetch: aborting errors the body stream.
      signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
      const [first, ...rest] = chunks;
      if (first) controller.enqueue(enc.encode(first));
      if (hold) await released;
      if (signal?.aborted) return;
      for (const c of rest) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  return { response: new Response(body, { headers: { 'content-type': 'text/event-stream' } }), release };
}

export function mockFetch(impl: (url: string, init: RequestInit) => Promise<Response>) {
  const fn = vi.fn(impl);
  vi.stubGlobal('fetch', fn);
  return fn;
}

type Handler = (init: RequestInit, url: string) => Response | Promise<Response>;

/**
 * Routes fetch calls by "METHOD /path" to handlers, like a tiny fake server.
 * Unrouted calls fail the test loudly.
 */
export function fakeServer(routes: Record<string, Handler>) {
  return mockFetch(async (url, init) => {
    const key = `${init?.method ?? 'GET'} ${url.split('?')[0]}`;
    const handler = routes[key];
    if (!handler) throw new Error(`Unrouted fetch: ${key}`);
    return handler(init ?? {}, url);
  });
}

export const json = (body: unknown, status = 200) => Response.json(body, { status });

export const guestSession = (over: Record<string, unknown> = {}) => ({
  name: 'Kari',
  state: 'guest',
  claimCode: null,
  notice: null,
  ...over,
});
