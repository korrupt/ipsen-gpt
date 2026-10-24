import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App, CLAIM_POLL_MS, SESSION_ENDED_NOTICE } from './App';
import { getToken, setToken } from './lib/session';
import { fakeServer, guestSession, json, sse, streamResponse, tokens } from './test-utils';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  localStorage.clear();
});

const input = () => screen.getByRole('textbox', { name: /message ipsengpt/i });
const sendButton = () => screen.getByRole('button', { name: /send message/i });
const nameInput = () => screen.getByRole('textbox', { name: /your name/i });

/**
 * Advances fake time one poll interval at a time until `check` passes. Robust
 * to the poll interval being registered a moment after the screen renders.
 * (Not waitFor: its own timeout timer is faked too and would expire instantly.)
 */
async function afterPolling(check: () => void, maxPolls = 5) {
  for (let i = 1; ; i++) {
    await act(() => vi.advanceTimersByTimeAsync(CLAIM_POLL_MS));
    try {
      check();
      return;
    } catch (err) {
      if (i >= maxPolls) throw err;
    }
  }
}

/** Starts the app as a returning guest with an existing session. */
function asReturningGuest(routes: Parameters<typeof fakeServer>[0] = {}, session = guestSession(), messages: unknown[] = []) {
  setToken('tok');
  return fakeServer({ 'GET /api/session': () => json({ session, messages }), ...routes });
}

describe('name picking', () => {
  it('new visitors pick a name, get a token, and land in the chat', async () => {
    const fetch = fakeServer({
      'POST /api/session': () => json({ token: 'new-token', session: guestSession() }, 201),
    });
    render(<App />);
    await userEvent.type(nameInput(), 'Kari{Enter}');
    await waitFor(() => expect(input()).toBeTruthy());
    expect(getToken()).toBe('new-token');
    expect(screen.getByTestId('header-user').textContent).toBe('Kari');
    expect(JSON.parse(fetch.mock.calls[0]![1].body as string)).toEqual({ name: 'Kari' });
  });

  it('shows why a name was refused', async () => {
    fakeServer({ 'POST /api/session': () => json({ error: 'That name is taken.', code: 'taken' }, 409) });
    render(<App />);
    await userEvent.type(nameInput(), 'Kari{Enter}');
    expect((await screen.findByRole('alert')).textContent).toBe('That name is taken.');
    expect(getToken()).toBeNull();
  });

  it('returning guests resume with their history from the server', async () => {
    asReturningGuest({}, guestSession(), [
      { role: 'user', content: 'earlier question' },
      { role: 'assistant', content: 'earlier answer' },
    ]);
    render(<App />);
    expect(await screen.findByText('earlier answer')).toBeTruthy();
    expect(screen.getByText('earlier question')).toBeTruthy();
  });

  it('a rejected claim shows the notice and re-picks with PUT on the same session', async () => {
    const fetch = asReturningGuest(
      { 'PUT /api/session/name': () => json({ session: guestSession({ name: 'Per' }) }) },
      guestSession({ name: null, notice: 'Pick another one.' }),
    );
    render(<App />);
    expect((await screen.findByRole('status')).textContent).toBe('Pick another one.');
    await userEvent.type(nameInput(), 'Per{Enter}');
    await waitFor(() => expect(input()).toBeTruthy());
    expect(fetch.mock.calls.some(([url, init]) => url === '/api/session/name' && init.method === 'PUT')).toBe(true);
  });

  it('an unknown token falls back to the name picker', async () => {
    setToken('stale');
    fakeServer({ 'GET /api/session': () => json({ error: 'session_invalid' }, 401) });
    render(<App />);
    expect(await screen.findByRole('textbox', { name: /your name/i })).toBeTruthy();
    expect(getToken()).toBeNull();
  });
});

describe('pending claim', () => {
  it('shows the claim code, enlarges it on tap, and switches to the claimed name on approval', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let session = guestSession({ name: 'Ola', state: 'pending_claim', claimCode: 'BAT-427' });
    asReturningGuest({ 'GET /api/session': () => json({ session, messages: [] }) });
    render(<App />);

    const banner = await screen.findByRole('button', { name: /claim code bat-427/i });
    await userEvent.click(banner);
    expect(screen.getByTestId('claim-code-big').textContent).toBe('BAT-427');
    await userEvent.click(screen.getByRole('dialog'));
    expect(screen.queryByRole('dialog')).toBeNull();

    session = guestSession({ name: 'Ola Nordmann', state: 'claimed' });
    await afterPolling(() => expect(screen.getByTestId('header-user').textContent).toBe('Ola Nordmann'));
    expect(screen.queryByText('BAT-427')).toBeNull();
  });

  it('goes back to the name picker when the claim is rejected', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let session = guestSession({ name: 'Ola', state: 'pending_claim', claimCode: 'BAT-427' });
    asReturningGuest({ 'GET /api/session': () => json({ session, messages: [] }) });
    render(<App />);
    await screen.findByText('BAT-427');
    session = guestSession({ name: null, notice: 'Not confirmed.' });
    await afterPolling(() => expect(screen.getByRole('status').textContent).toBe('Not confirmed.'));
  });
});

describe('chat', () => {
  it('caps input at 500 characters and shows a counter near the limit', async () => {
    asReturningGuest();
    render(<App />);
    const el = (await screen.findByRole('textbox', { name: /message ipsengpt/i })) as HTMLTextAreaElement;
    expect(el.maxLength).toBe(500);
    expect(sendButton()).toHaveProperty('disabled', true);
    await userEvent.click(el);
    await userEvent.paste('x'.repeat(450));
    expect(screen.getByTestId('char-count').textContent).toBe('450 / 500');
  });

  it('sends on Enter, streams the reply and shows thinking state on the portrait', async () => {
    const { response, release } = streamResponse([tokens('Greetings, '), tokens('user.') + sse('done', {})], { hold: true });
    asReturningGuest({ 'POST /api/chat': () => response });
    render(<App />);

    await userEvent.type(await screen.findByRole('textbox', { name: /message ipsengpt/i }), 'Hello ghost{Enter}');
    expect(screen.getByTestId('msg-user').textContent).toBe('Hello ghost');
    await waitFor(() => expect(screen.getByTestId('msg-assistant').textContent).toContain('Greetings,'));
    expect(screen.getByTestId('header-portrait').className).toContain('portrait--thinking');
    expect(screen.getByRole('button', { name: /stop generating/i })).toBeTruthy();
    expect((input() as HTMLTextAreaElement).value).toBe('');

    await act(async () => release());
    await waitFor(() => expect(screen.getByTestId('msg-assistant').textContent).toBe('Greetings, user.'));
    expect(screen.getByTestId('header-portrait').className).not.toContain('portrait--thinking');
  });

  it('Shift+Enter inserts a newline instead of sending', async () => {
    const fetch = asReturningGuest();
    render(<App />);
    await userEvent.type(await screen.findByRole('textbox', { name: /message ipsengpt/i }), 'line1{Shift>}{Enter}{/Shift}line2');
    expect((input() as HTMLTextAreaElement).value).toBe('line1\nline2');
    expect(fetch.mock.calls.filter(([url]) => url === '/api/chat')).toHaveLength(0);
  });

  it('shows an in-character error with a retry that re-sends the question', async () => {
    let call = 0;
    const fetch = asReturningGuest({
      'POST /api/chat': () =>
        ++call === 1
          ? streamResponse([sse('error', { message: 'Lost contact with the other side.' })]).response
          : streamResponse([tokens('Back from the dead.'), sse('done', {})]).response,
    });
    render(<App />);
    await userEvent.type(await screen.findByRole('textbox', { name: /message ipsengpt/i }), 'hello{Enter}');
    await waitFor(() => expect(screen.getByText('Lost contact with the other side.')).toBeTruthy());

    await userEvent.click(screen.getByRole('button', { name: /try again/i }));
    await waitFor(() => expect(screen.getByText('Back from the dead.')).toBeTruthy());
    expect(screen.queryByText(/lost contact/i)).toBeNull();
    expect(screen.getAllByTestId('msg-user')).toHaveLength(1);
    const chatCalls = fetch.mock.calls.filter(([url]) => url === '/api/chat');
    expect(JSON.parse(chatCalls[1]![1].body as string)).toEqual({ message: 'hello' });
  });

  it('shows rate-limit messages as an error reply', async () => {
    asReturningGuest({ 'POST /api/chat': () => json({ error: 'Slow down, mortal.' }, 429) });
    render(<App />);
    await userEvent.type(await screen.findByRole('textbox', { name: /message ipsengpt/i }), 'hi{Enter}');
    expect(await screen.findByText('Slow down, mortal.')).toBeTruthy();
  });

  it('when the admin ends the session, returns to the name picker with a notice', async () => {
    asReturningGuest({ 'POST /api/chat': () => json({ error: 'session_invalid' }, 401) });
    render(<App />);
    await userEvent.type(await screen.findByRole('textbox', { name: /message ipsengpt/i }), 'hi{Enter}');
    expect((await screen.findByRole('status')).textContent).toBe(SESSION_ENDED_NOTICE);
    expect(getToken()).toBeNull();
  });

  it('stop aborts the request and keeps the partial reply', async () => {
    asReturningGuest({
      'POST /api/chat': (init) => streamResponse([tokens('Partial')], { hold: true, signal: init.signal }).response,
    });
    render(<App />);
    await userEvent.type(await screen.findByRole('textbox', { name: /message ipsengpt/i }), 'hi{Enter}');
    await waitFor(() => expect(screen.getByTestId('msg-assistant').textContent).toContain('Partial'));
    await userEvent.click(screen.getByRole('button', { name: /stop generating/i }));
    await waitFor(() => expect(sendButton()).toBeTruthy());
    expect(screen.getByTestId('msg-assistant').textContent).toBe('Partial');
  });
});
