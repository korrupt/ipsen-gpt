import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockFetch, sse, streamResponse, tokens } from '../test-utils';
import { sendChat } from './chatApi';
import { ApiError, getToken, SessionGoneError, setToken } from './session';

beforeEach(() => setToken('tok123'));
afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('sendChat', () => {
  it('posts only the message, with the bearer token, and streams tokens', async () => {
    const fetch = mockFetch(async () => streamResponse([tokens('Boo', '!'), sse('done', {})]).response);
    const got: string[] = [];
    await sendChat('hi', (t) => got.push(t));
    expect(got).toEqual(['Boo', '!']);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('/api/chat');
    expect(JSON.parse(init.body as string)).toEqual({ message: 'hi' });
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok123');
  });

  it('rejects with the server error event message', async () => {
    mockFetch(async () => streamResponse([tokens('B'), sse('error', { message: 'Lost contact.' })]).response);
    await expect(sendChat('hi', () => {})).rejects.toThrow(new ApiError('Lost contact.', 200));
  });

  it('rejects with the JSON error and code on 4xx', async () => {
    mockFetch(async () => Response.json({ error: 'Slow down', code: 'x' }, { status: 429 }));
    const err = await sendChat('hi', () => {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ message: 'Slow down', status: 429, code: 'x' });
  });

  it('on 401 forgets the token and reports the session as gone', async () => {
    mockFetch(async () => Response.json({ error: 'session_invalid' }, { status: 401 }));
    await expect(sendChat('hi', () => {})).rejects.toBeInstanceOf(SessionGoneError);
    expect(getToken()).toBeNull();
  });

  it('rejects with a network error when fetch fails or the stream ends early', async () => {
    mockFetch(async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(sendChat('hi', () => {})).rejects.toBeInstanceOf(ApiError);
    mockFetch(async () => streamResponse([tokens('half')]).response);
    await expect(sendChat('hi', () => {})).rejects.toBeInstanceOf(ApiError);
  });
});
