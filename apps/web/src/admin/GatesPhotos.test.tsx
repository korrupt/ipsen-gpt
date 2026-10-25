import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeServer, json } from '../test-utils';
import { AdminApp } from './AdminApp';
import type { AdminGate, AdminPhoto, GateDefinition } from './api';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const loggedIn = (routes: Parameters<typeof fakeServer>[0] = {}) =>
  fakeServer({
    'GET /api/admin/me': () => json({ ok: true }),
    'GET /api/admin/claims': () => json({ claims: [] }),
    'GET /api/admin/sessions': () => json({ sessions: [] }),
    ...routes,
  });

const def = (over: Partial<GateDefinition> = {}): GateDefinition => ({
  key: 'global/pumpkin',
  id: 'pumpkin',
  person: null,
  target: 'a pumpkin',
  guestPrompt: 'Bring me a pumpkin!',
  refusalLines: [],
  points: 10,
  trigger: { type: 'admin_forced' },
  ...over,
});

const gate = (over: Partial<AdminGate> = {}): AdminGate => ({
  id: 'g1',
  sessionId: 's1',
  sessionName: 'Kari',
  defKey: 'global/pumpkin',
  source: 'admin_forced',
  target: 'a pumpkin',
  guestPrompt: 'Bring me a pumpkin!',
  points: 10,
  status: 'active',
  refusals: 2,
  createdAt: Date.now(),
  deadlineAt: null,
  resolvedAt: null,
  ...over,
});

const photo = (over: Partial<AdminPhoto> = {}): AdminPhoto => ({
  id: 'p1',
  sessionId: 's1',
  sessionName: 'Kari',
  gateId: 'g1',
  target: 'a pumpkin',
  status: 'failed',
  containsTarget: false,
  confidence: 0.83,
  reason: 'A cat on a sofa.',
  error: null,
  hasResized: true,
  hasOriginal: true,
  originalMime: 'image/jpeg',
  originalBytes: 3 * 1024 * 1024,
  originalProcessed: true,
  consentAt: Date.now(),
  createdAt: Date.now(),
  ...over,
});

const kari = {
  id: 's1',
  name: 'Kari',
  state: 'guest',
  claimCode: null,
  person: null,
  claimPerson: null,
  notice: null,
  createdAt: Date.now(),
  lastSeenAt: Date.now(),
};

const bodyOf = (fetch: ReturnType<typeof fakeServer>, url: string) =>
  JSON.parse(fetch.mock.calls.find(([u]) => u === url)![1].body as string);

describe('gates tab', () => {
  it('shows definitions with their trigger, load errors, and active gates that can be cancelled', async () => {
    let active = [gate()];
    const fetch = loggedIn({
      'GET /api/admin/gates': () =>
        json({
          definitions: [def(), def({ key: 'ola/carrot', target: 'a carrot', person: { slug: 'ola', name: 'Ola' }, trigger: { type: 'after_messages', count: 3 } })],
          errors: ['gates.json gate Bad: id: lowercase letters, digits and dashes'],
          active,
        }),
      'POST /api/admin/gates/g1/cancel': () => {
        active = [];
        return json({ gate: gate({ status: 'cancelled' }) });
      },
    });
    render(<AdminApp />);
    await userEvent.click(await screen.findByRole('button', { name: /^gates$/i }));

    expect(await screen.findByText('Ola only · after 3 messages')).toBeTruthy();
    expect(screen.getByText('only when forced')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('gates.json gate Bad');
    const card = screen.getByTestId('gate-card');
    expect(within(card).getByText('Kari')).toBeTruthy();
    expect(card.textContent).toContain('refused 2×');

    await userEvent.click(within(card).getByRole('button', { name: 'Cancel gate' }));
    expect(await screen.findByText('Nobody is blocked.')).toBeTruthy();
    expect(fetch.mock.calls.some(([url]) => url === '/api/admin/gates/g1/cancel')).toBe(true);
  });

  it('forces a defined gate on everyone, only after confirming', async () => {
    const fetch = loggedIn({
      'GET /api/admin/sessions': () => json({ sessions: [kari] }),
      'GET /api/admin/gates': () => json({ definitions: [def()], errors: [], active: [] }),
      'POST /api/admin/gates/force': () => json({ count: 7 }),
    });
    const confirm = vi.spyOn(window, 'confirm');
    render(<AdminApp />);
    await userEvent.click(await screen.findByRole('button', { name: /^gates$/i }));
    const form = await screen.findByRole('form', { name: 'Force a gate' });
    await userEvent.selectOptions(within(form).getByLabelText('Who'), 'Everyone');
    await userEvent.selectOptions(within(form).getByLabelText('Gate'), 'a pumpkin');

    confirm.mockReturnValueOnce(false);
    await userEvent.click(within(form).getByRole('button', { name: 'Force gate' }));
    expect(fetch.mock.calls.some(([url]) => url === '/api/admin/gates/force')).toBe(false);

    confirm.mockReturnValueOnce(true);
    await userEvent.click(within(form).getByRole('button', { name: 'Force gate' }));
    expect((await screen.findByRole('status')).textContent).toBe('Gate forced on 7 guests');
    expect(bodyOf(fetch, '/api/admin/gates/force')).toEqual({ all: true, key: 'global/pumpkin' });
  });

  it('forces a custom gate on one guest with a deadline', async () => {
    const fetch = loggedIn({
      'GET /api/admin/sessions': () => json({ sessions: [kari] }),
      'GET /api/admin/gates': () => json({ definitions: [], errors: [], active: [] }),
      'POST /api/admin/gates/force': () => json({ count: 1 }),
    });
    render(<AdminApp />);
    await userEvent.click(await screen.findByRole('button', { name: /^gates$/i }));
    const form = await screen.findByRole('form', { name: 'Force a gate' });
    await waitFor(() => expect(within(form).getByRole('option', { name: 'Kari' })).toBeTruthy());
    await userEvent.selectOptions(within(form).getByLabelText('Who'), 'Kari');
    await userEvent.selectOptions(within(form).getByLabelText('Gate'), 'Custom…');
    const submit = within(form).getByRole('button', { name: 'Force gate' });
    expect(submit).toHaveProperty('disabled', true);
    await userEvent.type(within(form).getByLabelText('Custom gate target'), 'a broomstick');
    await userEvent.type(within(form).getByLabelText('What IpsenGPT demands'), 'Broom or bust.');
    await userEvent.type(within(form).getByLabelText('Deadline in minutes'), '10');
    await userEvent.click(submit);
    expect((await screen.findByRole('status')).textContent).toBe('Gate forced');
    expect(bodyOf(fetch, '/api/admin/gates/force')).toEqual({
      sessionId: 's1',
      custom: { target: 'a broomstick', guestPrompt: 'Broom or bust.' },
      deadlineMinutes: 10,
    });
  });
});

describe('photos tab', () => {
  it('shows thumbnails, filters by verdict, and deletes after confirming', async () => {
    let photos = [photo(), photo({ id: 'p2', status: 'passed', reason: 'A pumpkin.', containsTarget: true })];
    const fetch = loggedIn({
      'GET /api/admin/photos': () => json({ photos }),
      'DELETE /api/admin/photos/p1': () => {
        photos = photos.filter((p) => p.id !== 'p1');
        return json({ ok: true });
      },
    });
    const confirm = vi.spyOn(window, 'confirm');
    render(<AdminApp />);
    await userEvent.click(await screen.findByRole('button', { name: /^photos$/i }));

    const thumbs = await screen.findAllByRole('button', { name: 'Kari: a pumpkin' });
    expect(thumbs).toHaveLength(2);
    expect(thumbs[0]!.querySelector('img')!.getAttribute('src')).toBe('/api/admin/photos/p1/resized');
    await userEvent.click(screen.getByRole('button', { name: 'Passed 1' }));
    expect(screen.getAllByRole('button', { name: 'Kari: a pumpkin' })).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: 'All 2' }));

    await userEvent.click(screen.getAllByRole('button', { name: 'Kari: a pumpkin' })[0]!);
    expect(screen.getByText('A cat on a sofa.')).toBeTruthy();
    expect(screen.getByText('(83% sure)')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Download' }).getAttribute('href')).toBe('/api/admin/photos/p1/original?download=1');
    expect(screen.queryByRole('note')).toBeNull();

    confirm.mockReturnValueOnce(true);
    await userEvent.click(screen.getByRole('button', { name: 'Delete photo' }));
    expect((await screen.findByRole('status')).textContent).toBe('Photo deleted');
    expect(fetch.mock.calls.some(([url, init]) => url === '/api/admin/photos/p1' && init.method === 'DELETE')).toBe(true);
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Kari: a pumpkin' })).toHaveLength(1));
  });

  it('warns when an original could not be cleaned of location data', async () => {
    loggedIn({
      'GET /api/admin/photos': () => json({ photos: [photo({ originalMime: 'image/heif', originalProcessed: false })] }),
    });
    render(<AdminApp />);
    await userEvent.click(await screen.findByRole('button', { name: /^photos$/i }));
    await userEvent.click(await screen.findByRole('button', { name: 'Kari: a pumpkin' }));
    expect(screen.getByRole('note').textContent).toMatch(/may still contain location data/);
  });
});

describe('session detail', () => {
  it("shows the session's gates and photos, and forces a gate on just that session", async () => {
    const fetch = loggedIn({
      'GET /api/admin/sessions': () => json({ sessions: [kari] }),
      'GET /api/admin/sessions/s1': () =>
        json({ session: kari, messages: [], gates: [gate({ status: 'passed' })], photos: [photo()] }),
      'GET /api/admin/people': () => json({ people: [], errors: [] }),
      'GET /api/admin/gates': () => json({ definitions: [def()], errors: [], active: [] }),
      'POST /api/admin/gates/force': () => json({ count: 1 }),
    });
    render(<AdminApp />);
    await userEvent.click(await screen.findByRole('button', { name: /^sessions$/i }));
    await userEvent.click(await screen.findByTestId('session-row'));
    expect(await screen.findByText('Gates (1)')).toBeTruthy();
    expect(screen.getByText('Passed')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Kari: a pumpkin' })).toBeTruthy();

    const form = screen.getByRole('form', { name: 'Force a gate' });
    expect(within(form).queryByLabelText('Who')).toBeNull();
    await waitFor(() => expect(within(form).getByRole('option', { name: 'a pumpkin' })).toBeTruthy());
    await userEvent.selectOptions(within(form).getByLabelText('Gate'), 'a pumpkin');
    await userEvent.click(within(form).getByRole('button', { name: 'Force gate' }));
    await waitFor(() => expect(bodyOf(fetch, '/api/admin/gates/force')).toEqual({ sessionId: 's1', key: 'global/pumpkin' }));
  });
});
