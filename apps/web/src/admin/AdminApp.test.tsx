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
  claimPeople: [{ slug: 'ola', name: person }],
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

describe('claims with a shared alias', () => {
  it('shows every matching person and approves as the one tapped', async () => {
    const vanessa = {
      ...claim('v', 'BAT-427'),
      name: 'Vanessa',
      claimPeople: [
        { slug: 'vanessa-berg', name: 'Vanessa Berg' },
        { slug: 'vanessa-hansen', name: 'Vanessa Hansen' },
      ],
    };
    const fetch = loggedIn({
      'GET /api/admin/claims': () => json({ claims: [vanessa] }),
      'POST /api/admin/claims/v/approve': () => json({ session: { ...vanessa, name: 'Vanessa Hansen', state: 'claimed' } }),
    });
    render(<AdminApp />);
    const card = await screen.findByTestId('claim');
    expect(card.textContent).toContain('Wants to be one of Vanessa Berg or Vanessa Hansen');
    expect(within(card).queryByRole('button', { name: 'Approve' })).toBeNull();
    await userEvent.click(within(card).getByRole('button', { name: 'Approve as Vanessa Hansen' }));
    expect((await screen.findByRole('status')).textContent).toBe('Approved: Vanessa Hansen');
    expect(bodyOf(fetch, 'POST', '/api/admin/claims/v/approve')).toEqual({ slug: 'vanessa-hansen' });
  });
});

describe('invite links', () => {
  const OLA = { slug: 'ola', name: 'Ola', aliases: [], info: '', persona: null, customPersona: null, claimedBy: null, invite: null };

  it('makes a link for a person, copies it, and revokes it', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText }, share: undefined });
    const fetch = loggedIn({
      'GET /api/admin/people': () => json({ people: [OLA], errors: [] }),
      'GET /api/admin/personas': () => json(PERSONAS),
      'POST /api/admin/people/ola/invite': () => json({ person: { ...OLA, invite: { token: 'tok123', createdAt: 1 } } }),
      'DELETE /api/admin/people/ola/invite': () => json({ person: OLA }),
    });
    render(<AdminApp />);
    await userEvent.click(await screen.findByRole('button', { name: /^people$/i }));
    await userEvent.click(await screen.findByTestId('person-row'));
    const card = screen.getByTestId('invite-card');
    expect(within(card).queryByLabelText('Invite link')).toBeNull();

    await userEvent.click(within(card).getByRole('button', { name: 'Make invite link' }));
    const link = (await within(card).findByLabelText('Invite link')) as HTMLInputElement;
    expect(link.value).toBe(`${window.location.origin}/#invite=tok123`);
    expect(within(card).queryByRole('button', { name: 'Share' })).toBeNull(); // no Web Share here
    await userEvent.click(within(card).getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/#invite=tok123`);

    await userEvent.click(within(card).getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(within(card).queryByLabelText('Invite link')).toBeNull());
    expect(fetch.mock.calls.some(([u, init]) => u === '/api/admin/people/ola/invite' && init.method === 'DELETE')).toBe(true);
  });
});

describe('sessions', () => {
  it('opens a session, shows its chat, and ends it after confirmation', async () => {
    const s = { ...claim('s1', ''), name: 'Kari', state: 'guest', claimCode: null, claimPeople: [], messageCount: 2 };
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
      'GET /api/admin/personas': () =>
        json({
          personas: [
            { id: 'sadgpt', name: 'Emo SadGPT', description: '' },
            { id: 'nihilist', name: 'Nihilist SadGPT', description: '' },
          ],
          errors: [],
          activeId: 'sadgpt',
          defaultId: 'sadgpt',
        }),
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
    await userEvent.type(screen.getByLabelText(/info for sadgpt/i), 'Likes owls.');
    const persona = screen.getByLabelText(/persona once you approve them/i);
    expect((await screen.findByRole('option', { name: 'Global persona (now: Emo SadGPT)' })).tagName).toBe('OPTION');
    await userEvent.selectOptions(persona, 'Nihilist SadGPT');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByRole('button', { name: '+ New person' });
    expect(created).toEqual({ name: 'Kari Nordmann', aliases: ['Kari', 'KN'], info: 'Likes owls.', persona: 'nihilist', customPersona: null });
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
          status: { open: false, reason: 'disconnected', message: 'SadGPT has lost contact.' },
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
    expect(screen.getByTestId('guest-view').textContent).toMatch(/Chat is closed\. Guests see: “SadGPT has lost contact\.” 3 pages open/);
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

const PERSONAS = {
  personas: [
    { id: 'drama', name: 'Dramatic SadGPT', description: 'Theatre kid' },
    { id: 'sadgpt', name: 'Emo SadGPT', description: 'The default' },
  ],
  errors: [],
  activeId: 'sadgpt',
  defaultId: 'sadgpt',
  defaults: [
    { id: 'sadgpt', name: 'Emo SadGPT', description: 'The default', inUse: true },
    { id: 'nihilist', name: 'Nihilist SadGPT', description: '', inUse: false },
  ],
};
const KARI = {
  id: 's1',
  name: 'Kari',
  state: 'guest',
  claimCode: null,
  person: null,
  claimPeople: [],
  notice: null,
  personaId: null,
  points: 12,
  createdAt: Date.now(),
  lastSeenAt: Date.now(),
  messageCount: 3,
};
const bodyOf = (fetch: ReturnType<typeof loggedIn>, method: string, url: string) =>
  JSON.parse(fetch.mock.calls.findLast(([u, init]) => u === url && init.method === method)![1].body as string);

describe('points', () => {
  it('gives points with a reason, adds a reward with its prize hidden, and shows the prize on demand', async () => {
    let rewards: object[] = [];
    const fetch = loggedIn({
      'GET /api/admin/sessions': () => json({ sessions: [KARI] }),
      'GET /api/admin/points': () => json({ leaderboard: [{ rank: 1, sessionId: 's1', name: 'Kari', points: 12 }], rewards, recent: [] }),
      'POST /api/admin/points': () => json({ total: 22 }),
      'POST /api/admin/rewards': (init) => {
        const b = JSON.parse(init.body as string);
        rewards = [{ id: 'r1', ...b, winnerId: null, winnerName: null, wonAt: null, createdAt: Date.now() }];
        return json({ reward: rewards[0] });
      },
      'PATCH /api/admin/rewards/r1': (init) => {
        rewards = [{ ...rewards[0], ...JSON.parse(init.body as string) }];
        return json({ reward: rewards[0] });
      },
    });
    render(<AdminApp />);
    await userEvent.click(await screen.findByRole('button', { name: /^points$/i }));
    expect((await screen.findByTestId('admin-leaderboard')).textContent).toContain('1. Kari12');

    const award = screen.getByTestId('award-form');
    const give = within(award).getByRole('button', { name: 'Give points' });
    expect(give).toHaveProperty('disabled', true);
    await userEvent.selectOptions(await within(award).findByLabelText('Guest'), 'Kari (12 pts)');
    await userEvent.type(within(award).getByLabelText(/^points/i), '10');
    await userEvent.type(within(award).getByLabelText(/^reason/i), 'Saddest costume');
    await userEvent.click(give);
    await screen.findByText('Gave 10 points (now 22)');
    expect(bodyOf(fetch, 'POST', '/api/admin/points')).toEqual({ sessionId: 's1', amount: 10, reason: 'Saddest costume' });

    const form = screen.getByTestId('reward-form');
    await userEvent.type(within(form).getByLabelText(/first to/i), '50');
    await userEvent.type(within(form).getByLabelText(/^prize/i), 'Sad candy');
    await userEvent.click(within(form).getByRole('button', { name: 'Add reward' }));
    expect(bodyOf(fetch, 'POST', '/api/admin/rewards')).toEqual({ threshold: 50, prize: 'Sad candy', revealed: false });
    const card = await screen.findByTestId('reward');
    expect(card.textContent).toContain('Guests see: ???');

    await userEvent.click(within(card).getByRole('button', { name: 'Show prize' }));
    expect(bodyOf(fetch, 'PATCH', '/api/admin/rewards/r1')).toEqual({ revealed: true });
    expect(await within(await screen.findByTestId('reward')).findByText(/Guests see: Sad candy/)).toBeTruthy();
  });

  it("take points uses a negative number, and the button says so", async () => {
    loggedIn({
      'GET /api/admin/sessions': () => json({ sessions: [KARI] }),
      'GET /api/admin/points': () => json({ leaderboard: [], rewards: [], recent: [] }),
    });
    render(<AdminApp />);
    await userEvent.click(await screen.findByRole('button', { name: /^points$/i }));
    const award = await screen.findByTestId('award-form');
    await userEvent.type(within(award).getByLabelText(/^points/i), '-5');
    expect(within(award).getByRole('button', { name: 'Take points' })).toBeTruthy();
  });
});

describe('personas', () => {
  it("sets a guest's own persona from their session page", async () => {
    let session = { ...KARI };
    const fetch = loggedIn({
      'GET /api/admin/sessions': () => json({ sessions: [session] }),
      'GET /api/admin/sessions/s1': () => json({ session, messages: [], gates: [], photos: [] }),
      'GET /api/admin/gates': () => json({ definitions: [], errors: [], active: [] }),
      'GET /api/admin/personas': () => json(PERSONAS),
      'PUT /api/admin/sessions/s1/persona': (init) => {
        session = { ...session, personaId: JSON.parse(init.body as string).id };
        return json({ session });
      },
    });
    render(<AdminApp />);
    await userEvent.click(await screen.findByRole('button', { name: /^sessions$/i }));
    await userEvent.click(await screen.findByTestId('session-row'));
    expect(await screen.findByText('Points: 12')).toBeTruthy();
    const select = screen.getByLabelText('Persona for this guest') as HTMLSelectElement;
    await screen.findByRole('option', { name: 'Dramatic SadGPT' });
    await userEvent.selectOptions(select, 'Dramatic SadGPT');
    expect(bodyOf(fetch, 'PUT', '/api/admin/sessions/s1/persona')).toEqual({ id: 'drama' });
    await waitFor(() => expect(select.value).toBe('drama'));
  });

  it('switches the global persona from System', async () => {
    let activeId = 'sadgpt';
    const fetch = loggedIn({
      'GET /api/admin/system': () =>
        json({ model: { url: 'u', model: 'm', reachable: true, hasModel: true, error: null, checkedAt: null }, status: { open: true, reason: null, message: null }, pauseReason: null, listeners: 0, errors: [] }),
      'GET /api/admin/personas': () => json({ ...PERSONAS, activeId }),
      'PUT /api/admin/personas/active': (init) => {
        activeId = JSON.parse(init.body as string).id;
        return json({ activeId });
      },
    });
    render(<AdminApp />);
    await userEvent.click(await screen.findByRole('button', { name: /^system$/i }));
    const select = (await screen.findByLabelText(/persona for everyone/i)) as HTMLSelectElement;
    expect(select.value).toBe('sadgpt');
    expect(screen.getByRole('option', { name: 'Emo SadGPT (default)' })).toBeTruthy();
    await userEvent.selectOptions(select, 'Dramatic SadGPT');
    expect(bodyOf(fetch, 'PUT', '/api/admin/personas/active')).toEqual({ id: 'drama' });
    expect(await within(screen.getByTestId('global-persona')).findByText('Theatre kid')).toBeTruthy();
  });
});

describe('persona editing', () => {
  const SYSTEM = () =>
    json({ model: { url: 'u', model: 'm', reachable: true, hasModel: true, error: null, checkedAt: null }, status: { open: true, reason: null, message: null }, pauseReason: null, listeners: 0, errors: [] });

  it('edits a persona, resets it to the default, and adds a deleted default back', async () => {
    const fetch = loggedIn({
      'GET /api/admin/system': SYSTEM,
      'GET /api/admin/personas': () => json(PERSONAS),
      'GET /api/admin/personas/sadgpt': () =>
        json({ persona: { id: 'sadgpt', name: 'Emo SadGPT', description: 'The default', body: 'You are emo.' }, hasDefault: true }),
      'PUT /api/admin/personas/sadgpt': (init) => json({ persona: { id: 'sadgpt', ...JSON.parse(init.body as string) } }),
      'POST /api/admin/personas/sadgpt/restore': () => json({ persona: { id: 'sadgpt', name: 'Emo SadGPT', description: '' } }),
      'POST /api/admin/personas/nihilist/restore': () => json({ persona: { id: 'nihilist', name: 'Nihilist SadGPT', description: '' } }),
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<AdminApp />);
    await userEvent.click(await screen.findByRole('button', { name: /^system$/i }));
    const list = await screen.findByTestId('persona-list');
    expect(within(list).getByText('Everyone')).toBeTruthy();

    await userEvent.click(within(list).getByRole('button', { name: /Emo SadGPT/ }));
    const character = (await screen.findByLabelText(/^character/i)) as HTMLTextAreaElement;
    expect(character.value).toBe('You are emo.');
    await userEvent.type(character, ' Very.');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(bodyOf(fetch, 'PUT', '/api/admin/personas/sadgpt')).toEqual({ name: 'Emo SadGPT', description: 'The default', body: 'You are emo. Very.' });

    await userEvent.click(within(await screen.findByTestId('persona-list')).getByRole('button', { name: /Emo SadGPT/ }));
    await userEvent.click(await screen.findByRole('button', { name: 'Reset to default' }));
    await waitFor(() => expect(fetch.mock.calls.some(([u]) => u === '/api/admin/personas/sadgpt/restore')).toBe(true));

    await userEvent.click(within(await screen.findByTestId('persona-list')).getByRole('button', { name: '+ Nihilist SadGPT' }));
    await waitFor(() => expect(fetch.mock.calls.some(([u]) => u === '/api/admin/personas/nihilist/restore')).toBe(true));
  });

  it('creates a new persona and edits the shared rules', async () => {
    const fetch = loggedIn({
      'GET /api/admin/system': SYSTEM,
      'GET /api/admin/personas': () => json(PERSONAS),
      'POST /api/admin/personas': (init) => {
        const b = JSON.parse(init.body as string);
        return b.name === 'Taken' ? json({ error: 'Give the persona a name.' }, 400) : json({ persona: { id: 'grumpy', ...b } });
      },
      'GET /api/admin/personas/rules': () => json({ text: '## Language\nReply in their language.' }),
      'PUT /api/admin/personas/rules': (init) => json({ text: JSON.parse(init.body as string).text }),
    });
    render(<AdminApp />);
    await userEvent.click(await screen.findByRole('button', { name: /^system$/i }));
    await userEvent.click(await screen.findByRole('button', { name: '+ New persona' }));
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toHaveProperty('disabled', true); // needs a name and a character
    await userEvent.type(screen.getByLabelText('Name'), 'Taken');
    await userEvent.type(screen.getByLabelText(/^character/i), 'Grumbles.');
    await userEvent.click(save);
    expect((await screen.findByRole('alert')).textContent).toBe('Give the persona a name.');
    await userEvent.clear(screen.getByLabelText('Name'));
    await userEvent.type(screen.getByLabelText('Name'), 'Grumpy');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByTestId('persona-list');
    expect(bodyOf(fetch, 'POST', '/api/admin/personas')).toEqual({ name: 'Grumpy', description: '', body: 'Grumbles.' });

    await userEvent.click(screen.getByRole('button', { name: 'Shared rules' }));
    const rules = (await screen.findByLabelText('Rules')) as HTMLTextAreaElement;
    expect(rules.value).toBe('## Language\nReply in their language.');
    await userEvent.type(rules, ' Always.');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByTestId('persona-list');
    expect(bodyOf(fetch, 'PUT', '/api/admin/personas/rules')).toEqual({ text: '## Language\nReply in their language. Always.' });
  });
});

describe('a persona written for one person', () => {
  const OLA = { slug: 'ola', name: 'Ola', aliases: [], info: '', persona: null, customPersona: 'Heartbroken over Ola.', claimedBy: null };

  it('People: shows and edits it, and switching to a listed persona drops it', async () => {
    const fetch = loggedIn({
      'GET /api/admin/people': () => json({ people: [OLA], errors: [] }),
      'GET /api/admin/personas': () => json(PERSONAS),
      'PUT /api/admin/people/ola': (init) => json({ person: { ...OLA, ...JSON.parse(init.body as string) } }),
    });
    render(<AdminApp />);
    await userEvent.click(await screen.findByRole('button', { name: /^people$/i }));
    const row = await screen.findByTestId('person-row');
    expect(row.textContent).toContain('own persona');
    await userEvent.click(row);

    const select = screen.getByLabelText(/persona once you approve them/i) as HTMLSelectElement;
    await screen.findByRole('option', { name: 'Emo SadGPT' });
    expect(select.value).toBe('_custom');
    const text = screen.getByLabelText(/their persona/i) as HTMLTextAreaElement;
    expect(text.value).toBe('Heartbroken over Ola.');
    await userEvent.type(text, ' Very.');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByRole('button', { name: '+ New person' });
    expect(bodyOf(fetch, 'PUT', '/api/admin/people/ola')).toMatchObject({ persona: null, customPersona: 'Heartbroken over Ola. Very.' });

    await userEvent.click(await screen.findByTestId('person-row'));
    await screen.findByRole('option', { name: 'Emo SadGPT' });
    await userEvent.selectOptions(screen.getByLabelText(/persona once you approve them/i), 'Emo SadGPT');
    expect(screen.queryByLabelText(/their persona/i)).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByRole('button', { name: '+ New person' });
    expect(bodyOf(fetch, 'PUT', '/api/admin/people/ola')).toMatchObject({ persona: 'sadgpt', customPersona: null });
  });

  it('People: a custom persona needs text before saving', async () => {
    loggedIn({ 'GET /api/admin/personas': () => json(PERSONAS) });
    render(<AdminApp />);
    await userEvent.click(await screen.findByRole('button', { name: /^people$/i }));
    await userEvent.click(await screen.findByRole('button', { name: '+ New person' }));
    await userEvent.type(screen.getByLabelText('Display name'), 'Per');
    await screen.findByRole('option', { name: 'Emo SadGPT' });
    await userEvent.selectOptions(screen.getByLabelText(/persona once you approve them/i), 'Custom: written below, just for them');
    expect(screen.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', true);
    await userEvent.type(screen.getByLabelText(/their persona/i), 'Be nice to Per.');
    expect(screen.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', false);
  });

  it('Sessions: shows what the guest gets now and why, and what no pick means', async () => {
    const session = {
      ...KARI,
      name: 'Ola',
      state: 'claimed',
      person: { slug: 'ola', name: 'Ola', hasCustomPersona: false },
      personaId: 'sadgpt',
      persona: {
        now: { source: 'session', id: 'sadgpt', name: 'Emo SadGPT' },
        withoutPick: { source: 'person', id: 'nihilist', name: 'Nihilist SadGPT' },
      },
    };
    loggedIn({
      'GET /api/admin/sessions': () => json({ sessions: [session] }),
      'GET /api/admin/sessions/s1': () => json({ session, messages: [], gates: [], photos: [] }),
      'GET /api/admin/gates': () => json({ definitions: [], errors: [], active: [] }),
      'GET /api/admin/personas': () => json(PERSONAS),
    });
    render(<AdminApp />);
    await userEvent.click(await screen.findByRole('button', { name: /^sessions$/i }));
    const row = await screen.findByTestId('session-row');
    expect(row.textContent).toContain('Emo SadGPT');
    await userEvent.click(row);
    expect(await screen.findByRole('option', { name: "No pick: Nihilist SadGPT (Ola's persona in People)" })).toBeTruthy();
    expect(screen.getByTestId('persona-now').textContent).toBe('Now: Emo SadGPT (picked for this guest)');
  });
});
