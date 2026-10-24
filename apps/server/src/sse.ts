import type { Response } from 'express';

/**
 * Routes that stream SSE. Nginx must not buffer these
 * (deploy/droplet/nginx/ipsengpt.conf; checked by test/deploy-config.test.ts).
 */
export const SSE_ROUTES = ['/api/chat', '/api/events'] as const;

export interface SseStream {
  send(event: string, data: unknown): void;
  close(): void;
  /** True once the client has gone away or close() was called. */
  readonly closed: boolean;
}

/**
 * Switches `res` into an SSE stream. Sends a comment heartbeat so proxies
 * (Nginx) and phones don't drop idle connections.
 */
export function openSse(res: Response, heartbeatMs: number): SseStream {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  res.write(': connected\n\n');

  let closed = false;
  const heartbeat = setInterval(() => {
    if (!closed) res.write(': ping\n\n');
  }, heartbeatMs);
  const markClosed = () => {
    closed = true;
    clearInterval(heartbeat);
  };
  res.on('close', markClosed);

  return {
    send(event, data) {
      if (closed) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    close() {
      if (closed) return;
      markClosed();
      res.end();
    },
    get closed() {
      return closed;
    },
  };
}
