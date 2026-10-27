import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeServer, json } from '../test-utils';
import { AdminApp } from './AdminApp';
import { ago } from './api';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const claim = (id: string, code: string, person = 'Ola Nordmann') => ({
  id,
  name: 'ola',
  state: 'pending_claim',
  claimCode: code,
  person: null,
  claimPerson: { slug: 'ola', name: person },
  notice: null,
  createdAt: Date.now(),
  lastSeenAt: Date.now(),
});

const loggedIn = (routes: Parameters<typeof fakeServer>[0] = {}) =>
  fakeServer({
    'GET /api/admin/me': () => json({ ok: true }),
    'GET /api/admin/claims': () => json({ claims: [] }),
    'GET /api/admin/sessions': () => json({ sessions: [] }),
    'GET /api/admin/people': () => json({ people: [], errors: [] }),
    ...routes,
  });

describe('admin login', () => {
  it('shows the login form when logged out and enters the dashboard on success', async () => {
    let authed = false;
    const fetch = fakeServer({
      'GET /api/admin/me': () => (authed ? json({ ok: true }) : json({ error: 'Not logged in' }, 401)),
      'POST /api/admin/login': (init) => {
        authed = JSON.parse(init.body as string).password === 'secret-pass';
        return authed ? json({ ok: true }) : json({ error: 'Wrong password' }, 401);
      },
      'GET /api/admin/claims': () => json({ claims: [] }),
    });
    render(<AdminApp />);
    const pw = await screen.findByLabelText('Password');
    await userEvent.type(pw, 'nope{Enter}');
    expect((await screen.findByRole('alert')).textContent).toBe('Wrong password');

    await userEvent.clear(pw);
    await userEvent.type(pw, 'secret-pass{Enter}');
    expect(await screen.findByText('No pending claims.')).toBeTruthy();
    expect(fetch.mock.calls.every(([, init]) => init.credentials === 'same-origin')).toBe(true);
  });

  it('drops back to login when the server says the session expired', async () => {
    loggedIn({ 'GET /api/admin/claims': () => json({ error: 'Not logged in' }, 401) });
    render(<AdminApp />);
    expect(await screen.findByLabelText('Password')).toBeTruthy();
  });
});

describe('claims', () => {
  it('lists claims with a badge, filters by loosely typed code, and approves in one tap', async () => {
    let claims = [claim('a', 'BAT-427'), claim('b', 'HEX-923')];
    const fetch = loggedIn({
      'GET /api/admin/claims': () => json({ claims }),
      'POST /api/admin/claims/a/approve': () => {
        claims = claims.filter((c) => c.id !== 'a');
        return json({ session: { ...claim('a', ''), name: 'Ola Nordmann', state: 'claimed' } });
      },
    });
    render(<AdminApp />);
    await waitFor(() => expect(screen.getAllByTestId('claim')).toHaveLength(2));
    expect(screen.getByRole('button', { name: /claims/i }).textContent).toContain('2');

    await userEvent.type(screen.getByLabelText('Search claim code'), 'bat 4');
    const cards = screen.getAllByTestId('claim');
    expect(cards).toHaveLength(1);
    await userEvent.click(within(cards[0]!).getByRole('button', { name: 'Approve' }));

    expect((await screen.findByRole('status')).textContent).toBe('Approved: Ola Nordmann');
    await waitFor(() => expect(screen.getAllByTestId('claim')).toHaveLength(1));
    expect(screen.getByText('HEX-923')).toBeTruthy();
    expect(fetch.mock.calls.some(([url, init]) => url === '/api/admin/claims/a/approve' && init.method === 'POST')).toBe(true);
  });
});

describe('sessions', () => {
  it('opens a session, shows its chat, and ends it after confirmation', async () => {
    const s = { ...claim('s1', ''), name: 'Kari', state: 'guest', claimCode: null, claimPerson: null, messageCount: 2 };
    const fetch = loggedIn({
      'GET /api/admin/sessions': () => json({ sessions: [s] }),
      'GET /api/admin/sessions/s1': () =>
        json({
          session: s,
          messages: [
            { role: 'user', content: 'hello', createdAt: 0 },
            { role: 'assistant', content: 'boo', createdAt: 0 },
          ],
          gates: [],
          photos: [],
        }),
      'POST /api/admin/sessions/s1/end': () => json({ ok: true }),
    });
    const confirm = vi.spyOn(window, 'confirm');
    render(<AdminApp />);
    await userEvent.click(await screen.findByRole('button', { name: /^sessions$/i }));
    await userEvent.click(await screen.findByTestId('session-row'));
    expect(await screen.findByText('boo')).toBeTruthy();

    confirm.mockReturnValueOnce(false);
    await userEvent.click(screen.getByRole('button', { name: 'End session' }));
    expect(fetch.mock.calls.some(([url]) => url === '/api/admin/sessions/s1/end')).toBe(false);

    confirm.mockReturnValueOnce(true);
    await userEvent.click(screen.getByRole('button', { name: 'End session' }));
    expect((await screen.findByRole('status')).textContent).toBe('Session ended');
    expect(await screen.findByTestId('session-row')).toBeTruthy(); // back on the list
  });
});

describe('people', () => {
  it('creates a person, splitting aliases on commas, and shows server errors', async () => {
    let created: unknown = null;
    loggedIn({
      'POST /api/admin/people': (init) => {
        const body = JSON.parse(init.body as string);
        if (body.name === 'Taken') return json({ error: '"Taken" is already used by Ola.' }, 409);
        created = body;
        return json({ person: { slug: 'kari', ...body, claimedBy: null } });
      },
    });
    render(<AdminApp />);
    await userEvent.click(await screen.findByRole('button', { name: /^people$/i }));
    await userEvent.click(await screen.findByRole('button', { name: '+ New person' }));

    await userEvent.type(screen.getByLabelText('Display name'), 'Taken');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/already used/);

    await userEvent.clear(screen.getByLabelText('Display name'));
    await userEvent.type(screen.getByLabelText('Display name'), 'Kari Nordmann');
    await userEvent.type(screen.getByLabelText(/aliases/i), 'Kari,  KN , ');
    await userEvent.type(screen.getByLabelText(/info for ipsengpt/i), 'Likes owls.');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByRole('button', { name: '+ New person' });
    expect(created).toEqual({ name: 'Kari Nordmann', aliases: ['Kari', 'KN'], info: 'Likes owls.' });
  });
});

describe('ago', () => {
  it('formats relative times', () => {
    const now = 10_000_000;
    expect(ago(now - 10_000, now)).toBe('just now');
    expect(ago(now - 180_000, now)).toBe('3 min ago');
    expect(ago(now - 2 * 3600_000 - 5, now)).toBe('2 h ago');
  });
});

describe('system', () => {
  const model = (over: Record<string, unknown> = {}) => ({
    url: 'http://127.0.0.1:11435',
    model: 'qwen3-vl:8b-instruct',
    reachable: true,
    hasModel: true,
    error: null,
    checkedAt: Date.now(),
    ...over,
  });

  it('shows whether the PC is connected, what guests see, and recent errors', async () => {
    loggedIn({
      'GET /api/admin/system': () =>
        json({
          model: model({ reachable: false, hasModel: false, error: 'fetch failed' }),
          status: { open: false, reason: 'disconnected', message: 'IpsenGPT has lost contact.' },
          pauseReason: null,
          listeners: 3,
          errors: [{ at: Date.now(), message: 'Model check failed, chat closed: fetch failed', detail: '' }],
        }),
    });
    render(<AdminApp />);
    await userEvent.click(await screen.findByRole('button', { name: /^system$/i }));
    const card = await screen.findByTestId('model');
    expect(card.textContent).toContain('Disconnected');
    expect(card.textContent).toContain('fetch failed');
    expect(screen.getByTestId('guest-view').textContent).toMatch(/Chat is closed\. Guests see: “IpsenGPT has lost contact\.” 3 pages open/);
    expect(screen.getByText('Model check failed, chat closed: fetch failed')).toBeTruthy();
  });

  it('pauses chat with a reason and resumes it', async () => {
    let pauseReason: string | null = null;
    const fetch = loggedIn({
      'GET /api/admin/system': () =>
        json({
          model: model(),
          status: pauseReason ? { open: false, reason: 'paused', message: pauseReason } : { open: true, reason: null, message: null },
          pauseReason,
          listeners: 1,
          errors: [],
        }),
      'PUT /api/admin/system/pause': (init) => {
        pauseReason = JSON.parse(init.body as string).reason;
        return json({ pauseReason });
      },
      'DELETE /api/admin/system/pause': () => {
        pauseReason = null;
        return json({ pauseReason });
      },
    });
    render(<AdminApp />);
    await userEvent.click(await screen.findByRole('button', { name: /^system$/i }));
    expect((await screen.findByTestId('model')).textContent).toContain('Connected');
    expect(screen.getByRole('button', { name: 'Pause chat' })).toHaveProperty('disabled', true);

    await userEvent.type(screen.getByLabelText('Pause chat for everyone'), '  Speeches!  ');
    await userEvent.click(screen.getByRole('button', { name: 'Pause chat' }));
    expect(await screen.findByText('Guests see: “Speeches!”')).toBeTruthy();
    const put = fetch.mock.calls.find(([url, init]) => url === '/api/admin/system/pause' && init.method === 'PUT')!;
    expect(JSON.parse(put[1].body as string)).toEqual({ reason: 'Speeches!' });

    await userEvent.click(screen.getByRole('button', { name: 'Resume chat' }));
    expect(await screen.findByLabelText('Pause chat for everyone')).toBeTruthy();
    expect(screen.getByTestId('guest-view').textContent).toMatch(/^Guests can chat\./);
  });
});
