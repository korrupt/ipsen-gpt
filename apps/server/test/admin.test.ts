import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { NOTICES } from '../src/sessions.js';
import { ADMIN_PASSWORD, adminCookie, makeEnv, newGuest, writePerson, type TestEnv } from './helpers.js';

const as = (e: TestEnv, cookie: string) => ({
  get: (url: string) => request(e.app).get(url).set('cookie', cookie),
  post: (url: string, body: object = {}) => request(e.app).post(url).set('cookie', cookie).send(body),
  put: (url: string, body: object) => request(e.app).put(url).set('cookie', cookie).send(body),
  del: (url: string) => request(e.app).delete(url).set('cookie', cookie),
});

const sessionId = (e: TestEnv, token: string) => e.services.sessions.byToken(token)!.id;

describe('admin auth', () => {
  it('is disabled without ADMIN_PASSWORD', async () => {
    const e = makeEnv({ ADMIN_PASSWORD: '' });
    const res = await request(e.app).post('/api/admin/login').send({ password: '' });
    expect(res.status).toBe(503);
    expect((await request(e.app).get('/api/admin/sessions')).status).toBe(401);
  });

  it('rejects a wrong password', async () => {
    const e = makeEnv();
    const res = await request(e.app).post('/api/admin/login').send({ password: 'wrong-password' });
    expect(res.status).toBe(401);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('sets an HttpOnly, Secure, SameSite=Strict cookie scoped to the admin API', async () => {
    const e = makeEnv();
    const res = await request(e.app).post('/api/admin/login').send({ password: ADMIN_PASSWORD });
    expect(res.status).toBe(200);
    const cookie = (res.headers['set-cookie'] as unknown as string[])[0]!;
    expect(cookie).toMatch(/^ipsen_admin=[A-Za-z0-9_-]{43};/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(cookie).toMatch(/Path=\/api\/admin/);
  });

  it('can drop Secure for plain-http LAN testing', async () => {
    const e = makeEnv({ ADMIN_COOKIE_SECURE: 'false' });
    const res = await request(e.app).post('/api/admin/login').send({ password: ADMIN_PASSWORD });
    expect((res.headers['set-cookie'] as unknown as string[])[0]).not.toMatch(/Secure/);
  });

  it('rate-limits login attempts per IP; a success resets the counter', async () => {
    const e = makeEnv({ RATE_ADMIN_LOGIN_IP: '3/900' });
    const login = (password: string) => request(e.app).post('/api/admin/login').send({ password });
    await login('wrong-1');
    await login('wrong-2');
    expect((await login(ADMIN_PASSWORD)).status).toBe(200);
    await login('wrong-3');
    await login('wrong-4');
    await login('wrong-5');
    const blocked = await login(ADMIN_PASSWORD);
    expect(blocked.status).toBe(429);
    e.tick(900_001);
    expect((await login(ADMIN_PASSWORD)).status).toBe(200);
  });

  it('protects every admin route, and logout/expiry end the session', async () => {
    const e = makeEnv({ ADMIN_SESSION_HOURS: '1' });
    for (const url of ['/api/admin/me', '/api/admin/claims', '/api/admin/sessions', '/api/admin/people']) {
      expect((await request(e.app).get(url)).status).toBe(401);
      expect((await request(e.app).get(url).set('cookie', 'ipsen_admin=forged')).status).toBe(401);
    }
    expect((await request(e.app).post('/api/admin/people').send({ name: 'X' })).status).toBe(401);

    const cookie = await adminCookie(e);
    expect((await as(e, cookie).get('/api/admin/me')).status).toBe(200);
    e.tick(3600_001);
    expect((await as(e, cookie).get('/api/admin/me')).status).toBe(401);

    const fresh = await adminCookie(e);
    await as(e, fresh).post('/api/admin/logout');
    expect((await as(e, fresh).get('/api/admin/me')).status).toBe(401);
  });
});

describe('admin claims', () => {
  it('lists pending claims, finds them by code, and approves in one call', async () => {
    const e = makeEnv();
    e.services.people.save({ name: 'Ola Nordmann', aliases: ['Ola'], info: '' });
    const real = await newGuest(e, 'Ola');
    const fake = await newGuest(e, 'ola nordmann');
    const admin = as(e, await adminCookie(e));

    const all = await admin.get('/api/admin/claims');
    expect(all.body.claims).toHaveLength(2);
    expect(all.body.claims[0]).toMatchObject({
      name: 'Ola',
      state: 'pending_claim',
      claimCode: real.body.session.claimCode,
      claimPerson: { slug: 'ola-nordmann', name: 'Ola Nordmann' },
    });

    const code = real.body.session.claimCode.toLowerCase().replace('-', '');
    const found = await admin.get(`/api/admin/claims?code=${code}`);
    expect(found.body.claims.map((c: { id: string }) => c.id)).toEqual([sessionId(e, real.token)]);

    const approved = await admin.post(`/api/admin/claims/${sessionId(e, real.token)}/approve`);
    expect(approved.status).toBe(200);
    expect(approved.body.session).toMatchObject({ state: 'claimed', name: 'Ola Nordmann' });

    const guestView = await request(e.app).get('/api/session').set('authorization', `Bearer ${fake.token}`);
    expect(guestView.body.session).toMatchObject({ name: null, notice: NOTICES.claimedByOther });
    expect((await admin.get('/api/admin/claims')).body.claims).toEqual([]);
  });

  it('rejects a claim', async () => {
    const e = makeEnv();
    e.services.people.save({ name: 'Ola', aliases: [], info: '' });
    const g = await newGuest(e, 'Ola');
    const admin = as(e, await adminCookie(e));
    const res = await admin.post(`/api/admin/claims/${sessionId(e, g.token)}/reject`);
    expect(res.body.session).toMatchObject({ state: 'guest', name: null });
    expect((await admin.post(`/api/admin/claims/${sessionId(e, g.token)}/reject`)).status).toBe(409);
    expect((await admin.post('/api/admin/claims/nope/approve')).status).toBe(409);
  });
});

describe('admin sessions', () => {
  it('lists sessions and shows a chat log', async () => {
    const e = makeEnv();
    const g = await newGuest(e, 'Kari');
    e.services.sessions.addExchange(sessionId(e, g.token), 'hi', 'boo');
    const admin = as(e, await adminCookie(e));

    const list = await admin.get('/api/admin/sessions');
    expect(list.body.sessions).toEqual([
      expect.objectContaining({ name: 'Kari', state: 'guest', messageCount: 2, person: null }),
    ]);
    expect(JSON.stringify(list.body)).not.toMatch(/token/i);

    const detail = await admin.get(`/api/admin/sessions/${sessionId(e, g.token)}`);
    expect(detail.body.messages.map((m: { content: string }) => m.content)).toEqual(['hi', 'boo']);
    expect((await admin.get('/api/admin/sessions/nope')).status).toBe(404);
  });

  it('assigns a person, releases a name, and ends a session', async () => {
    const e = makeEnv();
    const ola = e.services.people.save({ name: 'Ola', aliases: [], info: '' }).slug;
    const g = await newGuest(e, 'Kari');
    const id = sessionId(e, g.token);
    const admin = as(e, await adminCookie(e));

    const assigned = await admin.post(`/api/admin/sessions/${id}/assign`, { slug: ola });
    expect(assigned.body.session).toMatchObject({ state: 'claimed', name: 'Ola', person: { slug: ola } });
    expect((await admin.post(`/api/admin/sessions/${id}/assign`, { slug: 'ghost' })).status).toBe(404);
    expect((await admin.post(`/api/admin/sessions/${id}/assign`, {})).status).toBe(400);

    const released = await admin.post(`/api/admin/sessions/${id}/release-name`);
    expect(released.body.session).toMatchObject({ name: null, state: 'guest', person: null });

    expect((await admin.post(`/api/admin/sessions/${id}/end`)).status).toBe(200);
    expect((await request(e.app).get('/api/session').set('authorization', `Bearer ${g.token}`)).status).toBe(401);
    expect((await admin.post(`/api/admin/sessions/${id}/end`)).status).toBe(404);
  });
});

describe('admin people', () => {
  it('creates, edits and deletes person folders on disk', async () => {
    const e = makeEnv();
    const admin = as(e, await adminCookie(e));

    const created = await admin.post('/api/admin/people', { name: 'Kari Nordmann', aliases: ['Kari'], info: 'Likes owls.' });
    expect(created.status).toBe(200);
    const slug = created.body.person.slug;
    const file = path.join(e.config.peopleDir, slug, 'person.md');
    expect(fs.readFileSync(file, 'utf8')).toContain('Likes owls.');

    const updated = await admin.put(`/api/admin/people/${slug}`, { name: 'Kari N.', aliases: ['Kari'], info: 'Likes bats.' });
    expect(updated.body.person).toMatchObject({ slug, name: 'Kari N.', info: 'Likes bats.' });
    expect(fs.readFileSync(file, 'utf8')).toContain('Likes bats.');

    const list = await admin.get('/api/admin/people');
    expect(list.body.people).toEqual([expect.objectContaining({ slug, name: 'Kari N.', claimedBy: null })]);

    expect((await admin.del(`/api/admin/people/${slug}`)).status).toBe(200);
    expect(fs.existsSync(path.join(e.config.peopleDir, slug))).toBe(false);
    expect((await admin.get('/api/admin/people')).body.people).toEqual([]);
    expect((await admin.del(`/api/admin/people/${slug}`)).status).toBe(404);
  });

  it('reports name clashes and bad input', async () => {
    const e = makeEnv();
    const admin = as(e, await adminCookie(e));
    await admin.post('/api/admin/people', { name: 'Ola', aliases: [], info: '' });
    const clash = await admin.post('/api/admin/people', { name: 'Per', aliases: ['ola'], info: '' });
    expect(clash.status).toBe(409);
    expect(clash.body.error).toMatch(/already used by Ola/);
    expect((await admin.post('/api/admin/people', { name: '<script>' })).status).toBe(400);
    expect((await admin.post('/api/admin/people', { aliases: 'x' })).status).toBe(400);
  });

  it('renaming a claimed person renames their session', async () => {
    const e = makeEnv();
    const admin = as(e, await adminCookie(e));
    const slug = (await admin.post('/api/admin/people', { name: 'Ola', aliases: [], info: '' })).body.person.slug;
    const g = await newGuest(e, 'Ola');
    await admin.post(`/api/admin/claims/${sessionId(e, g.token)}/approve`);
    expect((await admin.get('/api/admin/people')).body.people[0].claimedBy).toMatchObject({ name: 'Ola' });

    await admin.put(`/api/admin/people/${slug}`, { name: 'Ola the Great', aliases: ['Ola'], info: '' });
    const view = await request(e.app).get('/api/session').set('authorization', `Bearer ${g.token}`);
    expect(view.body.session.name).toBe('Ola the Great');
  });

  it('reload picks up folders edited by hand and lists broken ones', async () => {
    const e = makeEnv();
    const admin = as(e, await adminCookie(e));
    writePerson(e.config.peopleDir, 'per', 'Per', [], 'hand-written');
    fs.mkdirSync(path.join(e.config.peopleDir, 'broken'));
    const res = await admin.post('/api/admin/people/reload');
    expect(res.body.people.map((p: { slug: string }) => p.slug)).toEqual(['per']);
    expect(res.body.errors).toEqual([expect.stringMatching(/^broken:/)]);
  });
});
