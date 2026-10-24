import type { Config } from './config.js';
import { OllamaError, streamChat, type ChatMessage } from './ollama.js';
import type { Settings } from './settings.js';

export type Backend = 'primary' | 'fallback';

export interface ProbeResult {
  url: string;
  model: string;
  reachable: boolean;
  /** Whether the configured model is pulled on that Ollama. */
  hasModel: boolean;
  error: string | null;
}

export interface LlmStatus {
  forceFallback: boolean;
  /** Backend that served the most recent reply. */
  lastUsed: Backend | null;
  /** While set, the primary is skipped (it failed recently). */
  primarySkippedUntil: number | null;
  primary: ProbeResult;
  fallback: ProbeResult | null;
}

/**
 * Picks the model for each request: the primary (PC over the tunnel) unless it
 * is forced off or failed recently, else the fallback (small model on the
 * droplet). A primary failure before the first token falls through to the
 * fallback within the same request; failures mid-reply are not retried.
 */
export class Llm {
  private primaryDownUntil = 0;
  lastUsed: Backend | null = null;

  constructor(
    private readonly cfg: Config['ollama'],
    private readonly settings: Settings,
    private readonly log: (msg: string, err?: unknown) => void,
    private readonly now: () => number = Date.now,
  ) {}

  get hasFallback(): boolean {
    return this.cfg.fallback !== null;
  }

  endpoint(backend: Backend): Config['ollama'] {
    if (backend === 'fallback' && this.cfg.fallback) return { ...this.cfg, ...this.cfg.fallback };
    return this.cfg;
  }

  /** Backends to try, in order. */
  plan(): Backend[] {
    if (!this.cfg.fallback) return ['primary'];
    if (this.settings.get('forceFallback')) return ['fallback'];
    if (this.now() < this.primaryDownUntil) return ['fallback'];
    return ['primary', 'fallback'];
  }

  /** Streams reply deltas. `onBackend` is called once the serving backend is known. */
  async *chat(
    messages: ChatMessage[],
    signal?: AbortSignal,
    onBackend?: (b: Backend) => void,
  ): AsyncGenerator<string, void, void> {
    const order = this.plan();
    for (const [i, backend] of order.entries()) {
      const gen = streamChat(this.endpoint(backend), messages, signal);
      let first: IteratorResult<string, void>;
      try {
        first = await gen.next();
      } catch (err) {
        const isAbort = err instanceof OllamaError && err.kind === 'aborted';
        if (!isAbort && backend === 'primary') this.markPrimaryDown(err);
        if (isAbort || i === order.length - 1) throw err;
        continue;
      }
      if (backend === 'primary') this.primaryDownUntil = 0;
      this.lastUsed = backend;
      onBackend?.(backend);
      if (!first.done) yield first.value;
      yield* gen;
      return;
    }
  }

  private markPrimaryDown(err: unknown) {
    this.primaryDownUntil = this.now() + this.cfg.primaryRetryMs;
    this.log(this.cfg.fallback ? 'Primary model failed, using fallback' : 'Primary model failed', err);
  }

  async status(): Promise<LlmStatus> {
    const [primary, fallback] = await Promise.all([
      probe(this.cfg.url, this.cfg.model),
      this.cfg.fallback ? probe(this.cfg.fallback.url, this.cfg.fallback.model) : Promise.resolve(null),
    ]);
    return {
      forceFallback: this.settings.get('forceFallback'),
      lastUsed: this.lastUsed,
      primarySkippedUntil: this.now() < this.primaryDownUntil ? this.primaryDownUntil : null,
      primary,
      fallback,
    };
  }
}

/** Asks an Ollama which models it has. Never throws. */
export async function probe(url: string, model: string, timeoutMs = 2000): Promise<ProbeResult> {
  try {
    const res = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { url, model, reachable: false, hasModel: false, error: `HTTP ${res.status}` };
    const body = (await res.json()) as { models?: { name?: string; model?: string }[] };
    const names = (body.models ?? []).flatMap((m) => [m.name, m.model]).filter(Boolean) as string[];
    // "llama3.2:1b" matches "llama3.2:1b"; a bare "name" matches "name:latest".
    const wanted = model.includes(':') ? [model] : [model, `${model}:latest`];
    return { url, model, reachable: true, hasModel: names.some((n) => wanted.includes(n)), error: null };
  } catch (err) {
    return { url, model, reachable: false, hasModel: false, error: err instanceof Error ? err.message : String(err) };
  }
}
