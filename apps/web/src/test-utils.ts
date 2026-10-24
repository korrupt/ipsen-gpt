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
