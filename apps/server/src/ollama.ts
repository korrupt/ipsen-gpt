import type { Config } from './config.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export type OllamaErrorKind =
  /** Nothing answered, not even a health check: the machine is gone (e.g. PC asleep, tunnel hanging). */
  | 'connect_timeout'
  /** Ollama is up but produced no first token in time (busy or queued). */
  | 'first_token_timeout'
  | 'unreachable'
  | 'http'
  | 'stream'
  | 'aborted';

export class OllamaError extends Error {
  constructor(
    message: string,
    readonly kind: OllamaErrorKind,
  ) {
    super(message);
    this.name = 'OllamaError';
  }
}

interface ChatChunk {
  message?: { content?: string };
  done?: boolean;
  error?: string;
}

/**
 * Whether anything answers GET /api/version within `timeoutMs` (Ollama does,
 * even while busy generating). Only "silent" means dead: a refused or failed
 * check is left for the chat request itself to report.
 */
async function healthCheck(url: string, timeoutMs: number, signal: AbortSignal): Promise<'answered' | 'silent' | 'error'> {
  const timer = AbortSignal.timeout(timeoutMs);
  try {
    const res = await fetch(`${url}/api/version`, { signal: AbortSignal.any([signal, timer]) });
    await res.body?.cancel();
    return 'answered';
  } catch {
    return timer.aborted ? 'silent' : 'error';
  }
}

const isAbortError = (err: unknown) => err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');

/**
 * Streams an assistant reply from Ollama's /api/chat, yielding content deltas.
 *
 * Ollama only answers once the first token is ready, so a slow start can mean
 * "busy" or "dead". A health check sent alongside the request tells them apart:
 *  - refused connection                                  -> `unreachable` (immediately)
 *  - health check silent for connectTimeoutMs            -> `connect_timeout`
 *  - alive, but no first token within firstTokenTimeoutMs -> `first_token_timeout`
 * All of these happen before any output, so the caller can switch to a fallback.
 */
export async function* streamChat(
  cfg: Config['ollama'],
  messages: ChatMessage[],
  signal?: AbortSignal,
): AsyncGenerator<string, void, void> {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });

  /** True until the first token (or an empty but complete reply) arrives. */
  let waiting = true;
  let timedOut: 'dead' | 'slow' | 'reply' | null = null;
  const timeout = (reason: NonNullable<typeof timedOut>) => {
    timedOut ??= reason;
    controller.abort();
  };

  void healthCheck(cfg.url, cfg.connectTimeoutMs, controller.signal).then((result) => {
    if (result === 'silent' && waiting) timeout('dead');
  });
  const firstTokenTimer = setTimeout(() => waiting && timeout('slow'), cfg.firstTokenTimeoutMs);
  const replyTimer = setTimeout(() => timeout('reply'), cfg.replyTimeoutMs);
  const gotFirstToken = () => {
    waiting = false;
    clearTimeout(firstTokenTimer);
  };

  const fail = (err: unknown): never => {
    if (err instanceof OllamaError) throw err;
    if (signal?.aborted) throw new OllamaError('Request aborted by client', 'aborted');
    if (isAbortError(err) && timedOut === 'dead') {
      throw new OllamaError(`Ollama did not answer a health check within ${cfg.connectTimeoutMs} ms`, 'connect_timeout');
    }
    if (isAbortError(err) && timedOut === 'slow') {
      throw new OllamaError(`Ollama is up but sent nothing within ${cfg.firstTokenTimeoutMs} ms`, 'first_token_timeout');
    }
    if (isAbortError(err) && timedOut === 'reply') {
      throw new OllamaError(`Reply exceeded ${cfg.replyTimeoutMs} ms`, 'stream');
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new OllamaError(
      waiting ? `Ollama unreachable: ${msg}` : `Stream failed: ${msg}`,
      waiting ? 'unreachable' : 'stream',
    );
  };

  try {
    let res: Response;
    try {
      res = await fetch(`${cfg.url}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: cfg.model,
          messages,
          stream: true,
          think: false,
          options: { num_ctx: cfg.numCtx, temperature: cfg.temperature },
        }),
        signal: controller.signal,
      });
    } catch (err) {
      return fail(err);
    }

    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      throw new OllamaError(`Ollama HTTP ${res.status}: ${text.slice(0, 200)}`, 'http');
    }

    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for await (const bytes of res.body) {
        buffer += decoder.decode(bytes, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          const chunk = JSON.parse(line) as ChatChunk;
          if (chunk.error) throw new OllamaError(`Ollama error: ${chunk.error}`, 'stream');
          const delta = chunk.message?.content;
          if (delta || chunk.done) gotFirstToken();
          if (delta) yield delta;
          if (chunk.done) return;
        }
      }
    } catch (err) {
      return fail(err);
    }
    throw new OllamaError('Stream ended before completion', 'stream');
  } finally {
    waiting = false;
    clearTimeout(firstTokenTimer);
    clearTimeout(replyTimer);
    signal?.removeEventListener('abort', onAbort);
    controller.abort();
  }
}
