import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { setToken } from './lib/session';
import { fakeServer, guestSession, json, sse, streamResponse, tokens } from './test-utils';

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

const input = () => screen.getByRole('textbox', { name: /message ipsengpt/i }) as HTMLTextAreaElement;
const sendButton = () => screen.getByRole('button', { name: /send message/i });

const CLOSED = { open: false, reason: 'disconnected', message: 'IpsenGPT has lost contact with the spirit world.' };
const OPEN = { open: true, reason: null, message: null };
const PUMPKIN = { id: 'g1', prompt: 'Bring me a pumpkin!', deadlineAt: null };

/** A live-events stream the test can push events into, like the server would. */
function pushableEvents() {
  const enc = new TextEncoder();
  const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  return {
    connections: () => streams.length,
    handler: (init: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          streams.push(controller);
          init.signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
        },
      });
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    },
    push: (event: string, data: unknown) => act(() => streams.at(-1)!.enqueue(enc.encode(sse(event, data)))),
    /** The server went away: the stream ends. */
    end: () => act(() => streams.at(-1)!.close()),
  };
}

function returningGuest(routes: Parameters<typeof fakeServer>[0] = {}) {
  setToken('tok');
  const live = pushableEvents();
  const fetch = fakeServer({
    'GET /api/session': () => json({ session: guestSession(), messages: [] }),
    'GET /api/events': live.handler,
    ...routes,
  });
  return { live, fetch };
}

describe('live events', () => {
  it('connect once chatting, with the token in a header (not the URL)', async () => {
    const { live, fetch } = returningGuest();
    render(<App />);
    await waitFor(() => expect(live.connections()).toBe(1));
    const [url, init] = fetch.mock.calls.find(([u]) => u === '/api/events')!;
    expect(url).toBe('/api/events');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok');
  });

  it('close chat while the PC is gone: the reason shows and nothing can be sent, but typed text is kept', async () => {
    const { live } = returningGuest();
    render(<App />);
    await waitFor(() => expect(live.connections()).toBe(1));
    await userEvent.type(input(), 'are you there?');

    await live.push('status', CLOSED);
    expect(screen.getByTestId('chat-closed').textContent).toBe(CLOSED.message);
    expect(input().disabled).toBe(true);
    expect(input().value).toBe('are you there?');
    expect(sendButton()).toHaveProperty('disabled', true);

    await live.push('status', OPEN);
    expect(screen.queryByTestId('chat-closed')).toBeNull();
    expect(input().disabled).toBe(false);
    expect(sendButton()).toHaveProperty('disabled', false);
  });

  it('show the host’s pause reason', async () => {
    const { live } = returningGuest();
    render(<App />);
    await waitFor(() => expect(live.connections()).toBe(1));
    await live.push('status', { open: false, reason: 'paused', message: 'Speeches! Back in 10 minutes.' });
    expect(screen.getByTestId('chat-closed').textContent).toBe('Speeches! Back in 10 minutes.');
  });

  it('show a gate the moment it starts, and remove it when it ends', async () => {
    const { live } = returningGuest();
    render(<App />);
    await waitFor(() => expect(live.connections()).toBe(1));
    await live.push('gate', { gate: PUMPKIN });
    expect(screen.getByText('Bring me a pumpkin!')).toBeTruthy();
    await live.push('gate', { gate: null });
    expect(screen.queryByText('Bring me a pumpkin!')).toBeNull();
  });

  it('show a gate that arrives with a reply, after the reply', async () => {
    const { live } = returningGuest({
      'POST /api/chat': () => streamResponse([tokens('Fine, ', 'mortal.'), sse('gate', PUMPKIN), sse('done', {})]).response,
    });
    render(<App />);
    await waitFor(() => expect(live.connections()).toBe(1));
    await userEvent.type(input(), 'hello{Enter}');
    expect(await screen.findByText('Fine, mortal.')).toBeTruthy();
    expect(screen.getByText('Bring me a pumpkin!')).toBeTruthy();
  });

  it('a message sent just as chat closed is taken back, not shown as failed', async () => {
    const { live } = returningGuest({
      'POST /api/chat': () => json({ error: 'Cake time.', code: 'chat_closed', status: { open: false, reason: 'paused', message: 'Cake time.' } }, 503),
    });
    render(<App />);
    await waitFor(() => expect(live.connections()).toBe(1));
    await userEvent.type(input(), 'hello{Enter}');
    expect((await screen.findByTestId('chat-closed')).textContent).toBe('Cake time.');
    expect(screen.queryByText('hello')).toBeNull();
    expect(input().disabled).toBe(true);
  });

  it('reconnect when the stream drops, and get the current state again', async () => {
    const { live } = returningGuest();
    render(<App />);
    await waitFor(() => expect(live.connections()).toBe(1));
    await live.end();
    await waitFor(() => expect(live.connections()).toBe(2), { timeout: 2500 });
    await live.push('status', CLOSED);
    expect(screen.getByTestId('chat-closed')).toBeTruthy();
  });

  it('an ended session goes back to the name picker', async () => {
    setToken('tok');
    fakeServer({
      'GET /api/session': () => json({ session: guestSession(), messages: [] }),
      'GET /api/events': () => json({ error: 'session_invalid' }, 401),
    });
    render(<App />);
    expect(await screen.findByRole('textbox', { name: /your name/i })).toBeTruthy();
  });
});
