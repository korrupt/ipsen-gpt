import type { GateView } from './photos';
import { authHeaders, checkResponse, SessionGoneError } from './session';
import { SseParser } from './sse';

/** Whether guests can chat right now, and if not, what they are told. */
export interface ChatStatus {
  open: boolean;
  reason: 'paused' | 'disconnected' | null;
  message: string | null;
}

export const OPEN: ChatStatus = { open: true, reason: null, message: null };

export interface LiveHandlers {
  onStatus: (status: ChatStatus) => void;
  /** The gate blocking chat now, or null. */
  onGate: (gate: GateView | null) => void;
  onSessionGone: () => void;
}

/** Waits between reconnects: 1 s, 2 s, 4 s ... up to 15 s; back to 1 s after a good connection. */
export const RETRY_MS = [1000, 2000, 4000, 8000, 15000];

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true });
  });

/**
 * Keeps GET /api/events open and reconnects when it drops (phone locked,
 * network blip, server restart). Every event is a full snapshot, so nothing is
 * lost in between. Uses fetch, not EventSource, so the token stays in a header
 * instead of the URL. Returns a function that stops it.
 */
export function connectEvents(handlers: LiveHandlers): () => void {
  const stop = new AbortController();
  void (async () => {
    let attempt = 0;
    while (!stop.signal.aborted) {
      try {
        const res = await fetch('/api/events', { headers: { ...authHeaders(), accept: 'text/event-stream' }, signal: stop.signal });
        await checkResponse(res);
        if (!res.body) throw new Error('no body');
        const parser = new SseParser(({ event, data }) => {
          attempt = 0;
          if (event === 'status') handlers.onStatus(JSON.parse(data) as ChatStatus);
          else if (event === 'gate') handlers.onGate((JSON.parse(data) as { gate: GateView | null }).gate);
        });
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          parser.push(value);
        }
      } catch (err) {
        if (stop.signal.aborted) return;
        if (err instanceof SessionGoneError) {
          handlers.onSessionGone();
          return;
        }
      }
      await sleep(RETRY_MS[Math.min(attempt++, RETRY_MS.length - 1)]!, stop.signal);
    }
  })();
  return () => stop.abort();
}
