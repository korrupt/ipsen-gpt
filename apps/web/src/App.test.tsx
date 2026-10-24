import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { mockFetch, sse, streamResponse, tokens } from './test-utils';

afterEach(() => vi.unstubAllGlobals());

const input = () => screen.getByRole('textbox', { name: /message ipsengpt/i });
const sendButton = () => screen.getByRole('button', { name: /send message/i });

describe('App', () => {
  it('shows the empty state and a disabled send button', () => {
    render(<App />);
    expect(screen.getByText(/what can i haunt for you/i)).toBeTruthy();
    expect(sendButton()).toHaveProperty('disabled', true);
  });

  it('caps input at 500 characters and shows a counter near the limit', async () => {
    render(<App />);
    const el = input() as HTMLTextAreaElement;
    expect(el.maxLength).toBe(500);
    await userEvent.click(el);
    await userEvent.paste('x'.repeat(450));
    expect(screen.getByTestId('char-count').textContent).toBe('450 / 500');
  });

  it('sends on Enter, streams the reply and shows thinking state on the portrait', async () => {
    const { response, release } = streamResponse([tokens('Greetings, '), tokens('user.') + sse('done', {})], {
      hold: true,
    });
    const fetch = mockFetch(async () => response);
    render(<App />);

    await userEvent.type(input(), 'Hello ghost{Enter}');
    expect(screen.getByTestId('msg-user').textContent).toBe('Hello ghost');
    await waitFor(() => expect(screen.getByTestId('msg-assistant').textContent).toContain('Greetings,'));
    expect(screen.getByTestId('header-portrait').className).toContain('portrait--thinking');
    expect(screen.getByRole('button', { name: /stop generating/i })).toBeTruthy();
    expect((input() as HTMLTextAreaElement).value).toBe('');

    await act(async () => release());
    await waitFor(() => expect(screen.getByTestId('msg-assistant').textContent).toBe('Greetings, user.'));
    expect(screen.getByTestId('header-portrait').className).not.toContain('portrait--thinking');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('Shift+Enter inserts a newline instead of sending', async () => {
    const fetch = mockFetch(async () => streamResponse([sse('done', {})]).response);
    render(<App />);
    await userEvent.type(input(), 'line1{Shift>}{Enter}{/Shift}line2');
    expect((input() as HTMLTextAreaElement).value).toBe('line1\nline2');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('sends previous exchanges as history', async () => {
    let n = 0;
    const fetch = mockFetch(async () => streamResponse([tokens(`reply${++n}`), sse('done', {})]).response);
    render(<App />);
    await userEvent.type(input(), 'first{Enter}');
    await waitFor(() => expect(screen.getByText('reply1')).toBeTruthy());
    await waitFor(() => expect(sendButton()).toBeTruthy());
    await userEvent.type(input(), 'second{Enter}');
    await waitFor(() => expect(screen.getByText('reply2')).toBeTruthy());
    const body = JSON.parse(fetch.mock.calls[1]![1].body as string);
    expect(body).toEqual({
      message: 'second',
      history: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'reply1' },
      ],
    });
  });

  it('shows an in-character error with a retry that re-sends the question', async () => {
    let call = 0;
    const fetch = mockFetch(async () =>
      ++call === 1
        ? streamResponse([sse('error', { message: 'Lost contact with the other side.' })]).response
        : streamResponse([tokens('Back from the dead.'), sse('done', {})]).response,
    );
    render(<App />);
    await userEvent.type(input(), 'hello{Enter}');
    await waitFor(() => expect(screen.getByText('Lost contact with the other side.')).toBeTruthy());

    await userEvent.click(screen.getByRole('button', { name: /try again/i }));
    await waitFor(() => expect(screen.getByText('Back from the dead.')).toBeTruthy());
    expect(screen.queryByText(/lost contact/i)).toBeNull();
    expect(screen.getAllByTestId('msg-user')).toHaveLength(1);
    expect(JSON.parse(fetch.mock.calls[1]![1].body as string)).toEqual({ message: 'hello', history: [] });
  });

  it('stop aborts the request and keeps the partial reply', async () => {
    mockFetch(async (_url, init) => streamResponse([tokens('Partial')], { hold: true, signal: init.signal }).response);
    render(<App />);
    await userEvent.type(input(), 'hi{Enter}');
    await waitFor(() => expect(screen.getByTestId('msg-assistant').textContent).toContain('Partial'));
    await userEvent.click(screen.getByRole('button', { name: /stop generating/i }));
    await waitFor(() => expect(sendButton()).toBeTruthy());
    expect(screen.getByTestId('msg-assistant').textContent).toBe('Partial');
  });
});
