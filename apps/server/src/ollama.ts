import type { Config } from './config.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export class OllamaError extends Error {
  constructor(
    message: string,
    readonly kind: 'connect_timeout' | 'unreachable' | 'http' | 'stream' | 'aborted',
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
 * Streams an assistant reply from Ollama's /api/chat, yielding content deltas.
 *
 * Fails with `connect_timeout` if no response headers arrive within
 * `connectTimeoutMs`, so the caller can switch to a fallback model.
 */
export async function* streamChat(
  cfg: Config['ollama'],
  messages: ChatMessage[],
  signal?: AbortSignal,
): AsyncGenerator<string, void, void> {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });

  let phase: 'connecting' | 'streaming' = 'connecting';
  const connectTimer = setTimeout(() => controller.abort(), cfg.connectTimeoutMs);
  const replyTimer = setTimeout(() => controller.abort(), cfg.replyTimeoutMs);

  const fail = (err: unknown): never => {
    if (err instanceof OllamaError) throw err;
    if (signal?.aborted) throw new OllamaError('Request aborted by client', 'aborted');
    if (controller.signal.aborted) {
      throw phase === 'connecting'
        ? new OllamaError(`No response from Ollama within ${cfg.connectTimeoutMs} ms`, 'connect_timeout')
        : new OllamaError(`Reply exceeded ${cfg.replyTimeoutMs} ms`, 'stream');
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new OllamaError(
      phase === 'connecting' ? `Ollama unreachable: ${msg}` : `Stream failed: ${msg}`,
      phase === 'connecting' ? 'unreachable' : 'stream',
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
    clearTimeout(connectTimer);
    phase = 'streaming';

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
          if (delta) yield delta;
          if (chunk.done) return;
        }
      }
    } catch (err) {
      return fail(err);
    }
    throw new OllamaError('Stream ended before completion', 'stream');
  } finally {
    clearTimeout(connectTimer);
    clearTimeout(replyTimer);
    signal?.removeEventListener('abort', onAbort);
    controller.abort();
  }
}
