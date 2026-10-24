import { SseParser } from './sse';

export interface HistoryItem {
  role: 'user' | 'assistant';
  content: string;
}

export const MAX_INPUT_CHARS = 500;

export class ChatError extends Error {}

const NETWORK_ERROR = 'The spirits could not reach the server. Check your connection and try again.';

/**
 * Sends a message and streams the reply. Resolves when the reply is complete;
 * rejects with ChatError on server or network failure, or AbortError if aborted.
 */
export async function sendChat(
  message: string,
  history: HistoryItem[],
  onToken: (text: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({ message, history }),
      signal,
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new ChatError(NETWORK_ERROR);
  }

  if (!res.ok || !res.body) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new ChatError(body?.error ?? NETWORK_ERROR);
  }

  let finished = false;
  let failure: string | null = null;
  const parser = new SseParser(({ event, data }) => {
    if (event === 'token') onToken((JSON.parse(data) as { text: string }).text);
    else if (event === 'done') finished = true;
    else if (event === 'error') failure = (JSON.parse(data) as { message: string }).message;
  });

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  const cancel = () => void reader.cancel().catch(() => {});
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      parser.push(value);
    }
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new ChatError(NETWORK_ERROR);
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
  signal?.throwIfAborted();
  parser.push('\n\n');

  if (failure) throw new ChatError(failure);
  if (!finished) throw new ChatError(NETWORK_ERROR);
}
