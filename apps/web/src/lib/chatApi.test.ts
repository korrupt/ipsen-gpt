import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockFetch, sse, streamResponse, tokens } from '../test-utils';
import { ChatError, sendChat } from './chatApi';

afterEach(() => vi.unstubAllGlobals());

describe('sendChat', () => {
  it('posts message + history and streams tokens', async () => {
    const fetch = mockFetch(async () => streamResponse([tokens('Boo', '!'), sse('done', {})]).response);
    const got: string[] = [];
    await sendChat('hi', [{ role: 'user', content: 'old' }], (t) => got.push(t));
    expect(got).toEqual(['Boo', '!']);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('/api/chat');
    expect(JSON.parse(init.body as string)).toEqual({ message: 'hi', history: [{ role: 'user', content: 'old' }] });
  });

  it('rejects with the server error event message', async () => {
    mockFetch(async () => streamResponse([tokens('B'), sse('error', { message: 'Lost contact.' })]).response);
    await expect(sendChat('hi', [], () => {})).rejects.toThrow(new ChatError('Lost contact.'));
  });

  it('rejects with the JSON error on 400', async () => {
    mockFetch(async () => Response.json({ error: 'Message is empty' }, { status: 400 }));
    await expect(sendChat('hi', [], () => {})).rejects.toThrow('Message is empty');
  });

  it('rejects with a network error when fetch fails', async () => {
    mockFetch(async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(sendChat('hi', [], () => {})).rejects.toBeInstanceOf(ChatError);
  });

  it('treats a stream that ends without done as a failure', async () => {
    mockFetch(async () => streamResponse([tokens('half')]).response);
    await expect(sendChat('hi', [], () => {})).rejects.toBeInstanceOf(ChatError);
  });
});
