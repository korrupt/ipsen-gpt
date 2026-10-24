import { ApiError, authHeaders, checkResponse, NETWORK_ERROR } from './session';
import { SseParser } from './sse';

export const MAX_INPUT_CHARS = 500;

/**
 * Sends a message and streams the reply. Resolves when the reply is complete.
 * Rejects with SessionGoneError (401), ApiError (other failures) or an
 * AbortError if aborted.
 */
export async function sendChat(message: string, onToken: (text: string) => void, signal?: AbortSignal): Promise<void> {
  let res: Response;
  try {
    res = await fetch('/api/chat', {
      method: 'POST',
      headers: { ...authHeaders(), 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({ message }),
      signal,
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new ApiError(NETWORK_ERROR, 0);
  }
  await checkResponse(res);
  if (!res.body) throw new ApiError(NETWORK_ERROR, 0);

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
    throw new ApiError(NETWORK_ERROR, 0);
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
  signal?.throwIfAborted();
  parser.push('\n\n');

  if (failure) throw new ApiError(failure, 200);
  if (!finished) throw new ApiError(NETWORK_ERROR, 0);
}
