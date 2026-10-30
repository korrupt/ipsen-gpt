import type { Config } from './config.js';
import { OllamaError, streamChat, type ChatMessage, type ChatOptions } from './ollama.js';
import type { Settings } from './settings.js';

export interface ProbeResult {
  url: string;
  model: string;
  reachable: boolean;
  /** Whether the configured model is pulled on that Ollama. */
  hasModel: boolean;
  error: string | null;
}

/** Shown to guests while the PC can't be reached. */
export const DISCONNECTED_MESSAGE = 'SadGPT has gone quiet and needs a moment alone. Hang on, it will be back shortly.';

/** Whether guests can chat right now, and if not, what they are told. */
export type ChatStatus =
  | { open: true; reason: null; message: null }
  | { open: false; reason: 'paused' | 'disconnected'; message: string };

export interface ModelState extends ProbeResult {
  /** When the model was last checked; null before the first check. */
  checkedAt: number | null;
}

/** Errors that mean the PC is gone (not merely busy or confused). */
const DOWN_KINDS = new Set(['connect_timeout', 'unreachable']);
const isDown = (err: unknown) => err instanceof OllamaError && DOWN_KINDS.has(err.kind);

/**
 * The one model (the PC's Ollama, over the tunnel). Keeps track of whether it
 * is reachable, from a check every few seconds (index.ts) and from every real
 * request, and whether the admin paused chat. Calls `onStatusChange` when what
 * guests see changes.
 */
export class Llm {
  private model: ModelState;
  onStatusChange: (status: ChatStatus) => void = () => {};

  constructor(
    private readonly cfg: Config['ollama'],
    private readonly settings: Settings,
    private readonly log: (msg: string, err?: unknown) => void,
    private readonly now: () => number = Date.now,
  ) {
    // Assume it's up until a check or a request says otherwise, so a restart doesn't close chat.
    this.model = { url: cfg.url, model: cfg.model, reachable: true, hasModel: true, error: null, checkedAt: null };
  }

  get connected(): boolean {
    return this.model.reachable && this.model.hasModel;
  }

  status(): ChatStatus {
    const pauseReason = this.settings.get('pauseReason');
    if (pauseReason) return { open: false, reason: 'paused', message: pauseReason };
    if (!this.connected) return { open: false, reason: 'disconnected', message: DISCONNECTED_MESSAGE };
    return { open: true, reason: null, message: null };
  }

  /** Probes the model now. Never throws. */
  async check(): Promise<ModelState> {
    const result = await probe(this.cfg.url, this.cfg.model, this.cfg.connectTimeoutMs);
    if (this.connected && !(result.reachable && result.hasModel)) this.log(`Model check failed, chat closed: ${result.error}`);
    this.update(result);
    return this.model;
  }

  modelState(): ModelState {
    return { ...this.model };
  }

  /** Pauses chat for everyone with a reason guests see, or resumes it (null). */
  pause(reason: string | null): void {
    const before = this.status();
    this.settings.set('pauseReason', reason);
    this.emitIfChanged(before);
  }

  /** Streams reply deltas from the model. */
  async *chat(messages: ChatMessage[], signal?: AbortSignal): AsyncGenerator<string, void, void> {
    const gen = streamChat(this.cfg, messages, signal);
    let first: IteratorResult<string, void>;
    try {
      first = await gen.next();
    } catch (err) {
      if (isDown(err)) this.markDown(err);
      throw err;
    }
    this.markUp();
    if (!first.done) yield first.value;
    yield* gen;
  }

  /**
   * A complete reply for photo verification. Null when the model is known to be
   * unreachable; throws OllamaError if it fails now.
   */
  async vision(
    messages: ChatMessage[],
    opts: ChatOptions & { timeoutMs: number },
    signal?: AbortSignal,
  ): Promise<string | null> {
    if (!this.connected) return null;
    let text = '';
    try {
      for await (const delta of streamChat({ ...this.cfg, replyTimeoutMs: opts.timeoutMs }, messages, signal, opts)) {
        text += delta;
      }
    } catch (err) {
      // Only "the PC is gone" closes chat; a bad image or a slow verdict says nothing about its health.
      if (isDown(err)) this.markDown(err);
      throw err;
    }
    this.markUp();
    return text;
  }

  private markDown(err: unknown) {
    if (this.connected) this.log('Model unreachable, chat closed until it is back', err);
    this.update({ reachable: false, error: err instanceof Error ? err.message : String(err) });
  }

  private markUp() {
    if (!this.model.reachable) this.update({ reachable: true, hasModel: true, error: null });
  }

  private update(patch: Partial<ProbeResult>) {
    const before = this.status();
    this.model = { ...this.model, ...patch, checkedAt: this.now() };
    this.emitIfChanged(before);
  }

  private emitIfChanged(before: ChatStatus) {
    const after = this.status();
    if (after.open !== before.open || after.message !== before.message) this.onStatusChange(after);
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
    const hasModel = names.some((n) => wanted.includes(n));
    return { url, model, reachable: true, hasModel, error: hasModel ? null : `Model ${model} is not pulled` };
  } catch (err) {
    return { url, model, reachable: false, hasModel: false, error: err instanceof Error ? err.message : String(err) };
  }
}
