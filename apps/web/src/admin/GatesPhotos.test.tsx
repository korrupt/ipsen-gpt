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
    'GET /api/admin/people': () => json({ people: [], errors: [] }),
    ...routes,
  });

const def = (over: Partial<GateDefinition> = {}): GateDefinition => ({
  key: 'global/pumpkin',
  id: 'pumpkin',
  person: null,
  kind: 'photo',
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
  kind: 'photo',
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
  claimPeople: [],
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
          missingShipped: [],
        }),
      'POST /api/admin/gates/g1/cancel': () => {
        active = [];
        return json({ gate: gate({ status: 'cancelled' }) });
      },
    });
    render(<AdminApp />);
    await userEvent.click(await screen.findByRole('button', { name: /^gates$/i }));

    expect(await screen.findByText('Photo · Ola only · after 3 messages')).toBeTruthy();
    expect(screen.getByText('Photo · everyone · only when forced')).toBeTruthy();
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
      'GET /api/admin/gates': () => json({ definitions: [def()], errors: [], active: [], missingShipped: [] }),
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
      'GET /api/admin/gates': () => json({ definitions: [], errors: [], active: [], missingShipped: [] }),
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
    await userEvent.type(within(form).getByLabelText('What SadGPT demands'), 'Broom or bust.');
    await userEvent.type(within(form).getByLabelText('Deadline in minutes'), '10');
    await userEvent.click(submit);
    expect((await screen.findByRole('status')).textContent).toBe('Gate forced');
    expect(bodyOf(fetch, '/api/admin/gates/force')).toEqual({
      sessionId: 's1',
      custom: { kind: 'photo', target: 'a broomstick', guestPrompt: 'Broom or bust.' },
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
      'GET /api/admin/gates': () => json({ definitions: [def()], errors: [], active: [], missingShipped: [] }),
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

describe('gate editor', () => {
  it('creates a text gate for one person, with an id made from the target', async () => {
    let defs: GateDefinition[] = [];
    const fetch = loggedIn({
      'GET /api/admin/gates': () => json({ definitions: defs, errors: [], active: [], missingShipped: [] }),
      'GET /api/admin/people': () => json({ people: [{ slug: 'ola', name: 'Ola' }], errors: [] }),
      'POST /api/admin/gate-defs': (init) => {
        const b = JSON.parse(init.body as string);
        defs = [def({ key: `${b.for}/${b.id}`, id: b.id, kind: b.kind, target: b.target, person: { slug: 'ola', name: 'Ola' } })];
        return json({ definition: defs[0] });
      },
    });
    render(<AdminApp />);
    await userEvent.click(await screen.findByRole('button', { name: /^gates$/i }));
    await userEvent.click(await screen.findByRole('button', { name: 'New gate' }));
    const form = screen.getByRole('form', { name: 'New gate' });
    const create = within(form).getByRole('button', { name: 'Create gate' });
    expect(create).toHaveProperty('disabled', true);

    await userEvent.selectOptions(within(form).getByLabelText('Kind'), 'text');
    await userEvent.type(within(form).getByLabelText('What their message must do'), 'A haiku about Pumpkins!');
    await userEvent.type(within(form).getByLabelText(/what sadgpt says/i), 'Write me a haiku.');
    await userEvent.type(within(form).getByLabelText(/aren’t good enough/), 'No.{Enter}{Enter}Try harder.');
    await waitFor(() => expect(within(form).getByRole('option', { name: 'Ola only' })).toBeTruthy());
    await userEvent.selectOptions(within(form).getByLabelText('For'), 'Ola only');
    await userEvent.selectOptions(within(form).getByLabelText('When'), 'after_messages');
    const count = within(form).getByLabelText('After how many messages');
    await userEvent.clear(count);
    await userEvent.type(count, '3');
    expect((within(form).getByLabelText(/^id/i) as HTMLInputElement).value).toBe('a-haiku-about-pumpkins');

    await userEvent.click(create);
    expect(bodyOf(fetch, '/api/admin/gate-defs')).toEqual({
      id: 'a-haiku-about-pumpkins',
      for: 'ola',
      kind: 'text',
      target: 'A haiku about Pumpkins!',
      guestPrompt: 'Write me a haiku.',
      refusalLines: ['No.', 'Try harder.'],
      points: 5,
      trigger: { type: 'after_messages', count: 3 },
    });
    expect((await screen.findByTestId('gate-definition')).textContent).toContain('✍️ A haiku about Pumpkins!');
    expect(screen.queryByRole('form', { name: 'New gate' })).toBeNull();
  });

  it('sets a random trigger as a percent per message', async () => {
    let defs: GateDefinition[] = [];
    const fetch = loggedIn({
      'GET /api/admin/gates': () => json({ definitions: defs, errors: [], active: [], missingShipped: [] }),
      'POST /api/admin/gate-defs': (init) => {
        const b = JSON.parse(init.body as string);
        defs = [def({ key: `global/${b.id}`, id: b.id, target: b.target, trigger: b.trigger })];
        return json({ definition: defs[0] });
      },
    });
    render(<AdminApp />);
    await userEvent.click(await screen.findByRole('button', { name: /^gates$/i }));
    await userEvent.click(await screen.findByRole('button', { name: 'New gate' }));
    const form = screen.getByRole('form', { name: 'New gate' });
    await userEvent.type(within(form).getByLabelText('What must be in the photo'), 'a broom');
    await userEvent.type(within(form).getByLabelText(/what sadgpt says/i), 'Broom!');
    await userEvent.selectOptions(within(form).getByLabelText('When'), 'random');
    const from = within(form).getByLabelText('From message number');
    await userEvent.clear(from);
    await userEvent.type(from, '4');
    const chance = within(form).getByLabelText('Chance per message in percent');
    await userEvent.clear(chance);
    await userEvent.type(chance, '0');
    await userEvent.click(within(form).getByRole('button', { name: 'Create gate' }));
    expect(within(form).getByRole('alert').textContent).toMatch(/percent above 0/);
    await userEvent.clear(chance);
    await userEvent.type(chance, '7.5');
    await userEvent.click(within(form).getByRole('button', { name: 'Create gate' }));
    expect(bodyOf(fetch, '/api/admin/gate-defs').trigger).toEqual({ type: 'random', after_messages: 4, chance: 0.075 });
    expect((await screen.findByTestId('gate-definition')).textContent).toContain('at random: 7.5% per message from message 4');
  });

  it('edits, resets, deletes and adds back gates, and shows server errors', async () => {
    let defs = [def({ shipped: 'changed' }), def({ key: 'global/candle', id: 'candle', target: 'a candle', shipped: 'same' })];
    let missing: GateDefinition[] = [];
    const fetch = loggedIn({
      'GET /api/admin/gates': () => json({ definitions: defs, errors: [], active: [], missingShipped: missing }),
      'PUT /api/admin/gate-defs/global/pumpkin': (init) => {
        const b = JSON.parse(init.body as string);
        if (b.points > 100) return json({ error: 'points: too many' }, 400);
        defs = [{ ...defs[0]!, target: b.target, points: b.points }, defs[1]!];
        return json({ definition: defs[0] });
      },
      'POST /api/admin/gate-defs/restore/pumpkin': () => {
        defs = [{ ...defs[0]!, target: 'a pumpkin', shipped: 'same' }, defs[1]!];
        return json({ definition: defs[0] });
      },
      'DELETE /api/admin/gate-defs/global/candle': () => {
        missing = [defs[1]!];
        defs = [defs[0]!];
        return json({ ok: true });
      },
      'POST /api/admin/gate-defs/restore/candle': () => {
        defs = [...defs, missing[0]!];
        missing = [];
        return json({ definition: defs[1] });
      },
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<AdminApp />);
    await userEvent.click(await screen.findByRole('button', { name: /^gates$/i }));
    const [pumpkin] = await screen.findAllByTestId('gate-definition');
    expect(pumpkin!.textContent).toContain('edited');

    await userEvent.click(within(pumpkin!).getByRole('button', { name: 'Edit' }));
    const form = screen.getByRole('form', { name: 'Edit gate pumpkin' });
    expect(within(form).queryByLabelText(/^id/i)).toBeNull();
    const target = within(form).getByLabelText('What must be in the photo');
    await userEvent.clear(target);
    await userEvent.type(target, 'a giant pumpkin');
    const pts = within(form).getByLabelText('Points');
    await userEvent.clear(pts);
    await userEvent.type(pts, '500');
    await userEvent.click(within(form).getByRole('button', { name: 'Save' }));
    expect((await within(form).findByRole('alert')).textContent).toBe('points: too many');
    await userEvent.clear(pts);
    await userEvent.type(pts, '12');
    await userEvent.click(within(form).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('📷 a giant pumpkin')).toBeTruthy();
    expect(bodyOf(fetch, '/api/admin/gate-defs/global/pumpkin')).toMatchObject({ for: null, kind: 'photo', points: 500 });

    await userEvent.click(within(screen.getAllByTestId('gate-definition')[0]!).getByRole('button', { name: 'Reset to shipped' }));
    expect(await screen.findByText('📷 a pumpkin')).toBeTruthy();

    await userEvent.click(within(screen.getAllByTestId('gate-definition')[1]!).getByRole('button', { name: 'Delete' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Add back' }));
    await waitFor(() => expect(screen.getAllByTestId('gate-definition')).toHaveLength(2));
    expect(screen.queryByRole('button', { name: 'Add back' })).toBeNull();
  });
});
