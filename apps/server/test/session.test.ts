import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { NOTICES } from '../src/sessions.js';
import { makeEnv, newGuest } from './helpers.js';

const get = (app: any, token: string) => request(app).get('/api/session').set('authorization', `Bearer ${token}`);

describe('guest session API', () => {
  it('POST /api/session creates a session with a long random token', async () => {
    const e = makeEnv();
    const res = await request(e.app).post('/api/session').send({ name: '  Kari ' });
    expect(res.status).toBe(201);
    expect(res.body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(res.body.session).toEqual({ name: 'Kari', state: 'guest', claimCode: null, notice: null });
    // Only a hash of the token is stored.
    const row = e.services.db.prepare('SELECT token_hash FROM sessions').get() as { token_hash: string };
    expect(row.token_hash).not.toContain(res.body.token);
  });

  it('rejects taken (409) and invalid (400) names', async () => {
    const e = makeEnv();
    await newGuest(e, 'Kari');
    const taken = await request(e.app).post('/api/session').send({ name: 'KARI' });
    expect(taken.status).toBe(409);
    expect(taken.body).toMatchObject({ code: 'taken', error: 'That name is taken.' });
    const invalid = await request(e.app).post('/api/session').send({ name: '<b>' });
    expect(invalid.status).toBe(400);
    expect((await request(e.app).post('/api/session').send({})).status).toBe(400);
  });

  it('reserved names get a pending claim with a code, but no person details', async () => {
    const e = makeEnv();
    e.services.people.save({ name: 'Ola Nordmann', aliases: ['Ola'], info: 'secret info' });
    const { body } = await newGuest(e, 'Ola');
    expect(body.session.state).toBe('pending_claim');
    expect(body.session.claimCode).toMatch(/^[A-Z]+-[2-9]{3}$/);
    expect(JSON.stringify(body)).not.toMatch(/secret info|Nordmann|ola-nordmann/);
  });

  it('GET /api/session returns the session and its history; 401 for unknown tokens', async () => {
    const e = makeEnv();
    const { token } = await newGuest(e, 'Kari');
    const id = e.services.sessions.byToken(token)!.id;
    e.services.sessions.addExchange(id, 'hi', 'boo');
    const res = await get(e.app, token);
    expect(res.body).toEqual({
      session: { name: 'Kari', state: 'guest', claimCode: null, notice: null },
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'boo' },
      ],
    });
    expect((await get(e.app, 'nope')).status).toBe(401);
  });

  it('after a rejection, the guest sees the notice and picks a new name with PUT', async () => {
    const e = makeEnv();
    e.services.people.save({ name: 'Ola', aliases: [], info: '' });
    const { token } = await newGuest(e, 'Ola');
    e.services.sessions.rejectClaim(e.services.sessions.byToken(token)!.id);

    expect((await get(e.app, token)).body.session).toMatchObject({ name: null, notice: NOTICES.claimRejected });
    const put = await request(e.app).put('/api/session/name').set('authorization', `Bearer ${token}`).send({ name: 'Per' });
    expect(put.status).toBe(200);
    expect(put.body.session).toEqual({ name: 'Per', state: 'guest', claimCode: null, notice: null });

    // Can't rename once named.
    const again = await request(e.app).put('/api/session/name').set('authorization', `Bearer ${token}`).send({ name: 'Pål' });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('already_named');
  });

  it('an ended session is gone for the guest', async () => {
    const e = makeEnv();
    const { token } = await newGuest(e, 'Kari');
    e.services.sessions.end(e.services.sessions.byToken(token)!.id);
    expect((await get(e.app, token)).status).toBe(401);
  });

  it('rate-limits session creation per IP', async () => {
    const e = makeEnv({ RATE_SESSION_CREATE_IP: '2/600' });
    await newGuest(e, 'A');
    await newGuest(e, 'B');
    const res = await request(e.app).post('/api/session').send({ name: 'C' });
    expect(res.status).toBe(429);
  });
});
