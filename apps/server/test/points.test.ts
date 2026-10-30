import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startMockOllama, type MockOllama } from '../src/dev/mock-ollama.js';
import type { Reward } from '../src/points.js';
import { adminCookie, gateJson, makeEnv, newGuest, phoneJpeg, writeGates, type TestEnv } from './helpers.js';

let mock: MockOllama;
beforeAll(async () => {
  mock = await startMockOllama({ tokenDelayMs: 1 });
});
afterAll(() => mock.close());
beforeEach(() => mock.setVerdict('pass'));

const env = (gates: unknown[] = []) =>
  makeEnv({ OLLAMA_URL: mock.url }, (config) => writeGates(config.gatesPath, gates));

/** A named guest's session id. */
async function guest(e: TestEnv, name: string): Promise<string> {
  const { token } = await newGuest(e, name);
  return e.services.sessions.byToken(token)!.id;
}

describe('the ledger', () => {
  it('adds and takes points, with a reason', async () => {
    const e = env();
    const kari = await guest(e, 'Kari');
    const p = e.services.points;
    p.award(kari, 10, 'Best costume', 'admin');
    p.award(kari, -3, '  Spilled punch  ', 'admin');
    expect(p.total(kari)).toBe(7);
    expect(p.recent().map((r) => [r.amount, r.reason, r.sessionName])).toEqual([
      [-3, 'Spilled punch', 'Kari'],
      [10, 'Best costume', 'Kari'],
    ]);
  });

  it('refuses 0, fractions, no reason and unknown sessions', async () => {
    const e = env();
    const kari = await guest(e, 'Kari');
    const p = e.services.points;
    expect(() => p.award(kari, 0, 'x', 'admin')).toThrow(/not 0/);
    expect(() => p.award(kari, 1.5, 'x', 'admin')).toThrow(/whole number/);
    expect(() => p.award(kari, 5, '   ', 'admin')).toThrow(/why/);
    expect(() => p.award('nope', 5, 'x', 'admin')).toThrow(/not found/);
  });

  it('a gate pays out once', async () => {
    const e = env();
    const kari = await guest(e, 'Kari');
    const [gate] = e.services.gates.force([kari], { custom: { target: 'a cat', guestPrompt: 'Cat!' } }, null);
    e.services.points.award(kari, 5, 'Cat', 'gate', gate!.id);
    expect(() => e.services.points.award(kari, 5, 'Cat', 'gate', gate!.id)).toThrow(/already paid out/);
    expect(e.services.points.total(kari)).toBe(5);
  });
});

describe('the leaderboard', () => {
  it('best first; a tie goes to whoever got there first; no points, no place', async () => {
    const e = env();
    const [kari, per, ola, zero] = [await guest(e, 'Kari'), await guest(e, 'Per'), await guest(e, 'Ola'), await guest(e, 'Zero')];
    const p = e.services.points;
    p.award(per, 10, 'x', 'admin');
    e.tick(1000);
    p.award(kari, 10, 'x', 'admin');
    e.tick(1000);
    p.award(ola, 20, 'x', 'admin');
    expect(p.leaderboard().map((s) => [s.rank, s.name, s.points])).toEqual([
      [1, 'Ola', 20],
      [2, 'Per', 10],
      [3, 'Kari', 10],
    ]);
    expect(p.standing(kari)).toEqual({ points: 10, rank: 3 });
    expect(p.standing(zero)).toEqual({ points: 0, rank: null });
    expect(p.leaderboard(2)).toHaveLength(2);
  });

  it('leaves out ended and nameless guests', async () => {
    const e = env();
    const [kari, per] = [await guest(e, 'Kari'), await guest(e, 'Per')];
    e.services.points.award(kari, 5, 'x', 'admin');
    e.services.points.award(per, 5, 'x', 'admin');
    e.services.sessions.end(kari);
    e.services.sessions.releaseName(per);
    expect(e.services.points.leaderboard()).toEqual([]);
  });
});

describe('rewards: first to N points', () => {
  it('go to the first guest to get there, for good', async () => {
    const e = env();
    const [kari, per] = [await guest(e, 'Kari'), await guest(e, 'Per')];
    const p = e.services.points;
    const won: Reward[] = [];
    const prev = p.onChange;
    p.onChange = (c) => (prev(c), won.push(...c.won));
    const r50 = p.addReward({ threshold: 50, prize: 'Candy' });
    p.award(kari, 40, 'x', 'admin');
    e.tick(1000);
    p.award(per, 60, 'x', 'admin');
    e.tick(1000);
    p.award(kari, 30, 'x', 'admin'); // Kari passes 50 too, but later
    expect(p.reward(r50.id)).toMatchObject({ winnerId: per, winnerName: 'Per' });
    expect(won.map((r) => r.winnerName)).toEqual(['Per']);

    p.award(per, -60, 'Cheated', 'admin');
    expect(p.reward(r50.id)?.winnerId).toBe(per); // not undone
  });

  it('a reward added late goes to whoever got there first', async () => {
    const e = env();
    const [kari, per] = [await guest(e, 'Kari'), await guest(e, 'Per')];
    const p = e.services.points;
    p.award(kari, 30, 'x', 'admin');
    e.tick(1000);
    p.award(per, 100, 'x', 'admin');
    e.tick(1000);
    p.award(kari, 80, 'x', 'admin'); // Kari now leads with 110, but Per reached 100 first
    expect(p.addReward({ threshold: 100, prize: 'Cake' })).toMatchObject({ winnerName: 'Per' });
    expect(p.addReward({ threshold: 25, prize: 'Gum' })).toMatchObject({ winnerName: 'Kari' });
    expect(p.addReward({ threshold: 500, prize: 'Car' }).winnerId).toBeNull();
  });

  it("one guest can win several; the goal can't move once won; ended guests can't win", async () => {
    const e = env();
    const [kari, per] = [await guest(e, 'Kari'), await guest(e, 'Per')];
    const p = e.services.points;
    const a = p.addReward({ threshold: 10, prize: 'A' });
    const b = p.addReward({ threshold: 20, prize: 'B' });
    p.award(kari, 25, 'x', 'admin');
    expect([p.reward(a.id)?.winnerId, p.reward(b.id)?.winnerId]).toEqual([kari, kari]);
    expect(() => p.updateReward(a.id, { threshold: 5 })).toThrow(/Already won by Kari/);
    expect(p.updateReward(a.id, { prize: 'Better A', revealed: true })).toMatchObject({ prize: 'Better A', revealed: true });

    const c = p.addReward({ threshold: 30, prize: 'C' });
    e.services.sessions.end(per);
    expect(() => p.award(per, 50, 'x', 'admin')).not.toThrow();
    expect(p.reward(c.id)?.winnerId).toBeNull();
  });

  it('are checked: a positive whole goal and a prize', async () => {
    const p = env().services.points;
    expect(() => p.addReward({ threshold: 0, prize: 'x' })).toThrow(/above 0/);
    expect(() => p.addReward({ threshold: 10, prize: ' ' })).toThrow(/prize/);
    expect(() => p.updateReward('nope', { prize: 'x' })).toThrow(/No such reward/);
    expect(() => p.deleteReward('nope')).toThrow(/No such reward/);
  });
});

describe('guests', () => {
  it('see the leaderboard and rewards, but hidden prizes only as null', async () => {
    const e = env();
    const { token } = await newGuest(e, 'Kari');
    const kari = e.services.sessions.byToken(token)!.id;
    e.services.points.addReward({ threshold: 5, prize: 'SECRET-PRIZE' });
    e.services.points.addReward({ threshold: 50, prize: 'Cake', revealed: true });
    e.services.points.award(kari, 7, 'x', 'admin');
    const res = await request(e.app).get('/api/leaderboard').set('authorization', `Bearer ${token}`);
    expect(res.body).toEqual({
      top: [{ rank: 1, name: 'Kari', points: 7 }],
      rewards: [
        { id: expect.any(String), threshold: 5, prize: null, winner: 'Kari' },
        { id: expect.any(String), threshold: 50, prize: 'Cake', winner: null },
      ],
      me: { points: 7, rank: 1 },
    });
    expect(res.text).not.toContain('SECRET-PRIZE');
    expect(res.text).not.toContain(kari); // session ids stay private
    expect((await request(e.app).get('/api/leaderboard')).status).toBe(401);
  });

  it('get the gate points when a photo passes', async () => {
    const e = env([gateJson('pumpkin', { type: 'session_start' }, { points: 15 })]);
    const { token, body } = await newGuest(e, 'Kari');
    await request(e.app)
      .post(`/api/photos/verify?gate=${body.gate.id}&consent=1`)
      .set('authorization', `Bearer ${token}`)
      .set('content-type', 'image/jpeg')
      .send(await phoneJpeg());
    const id = e.services.sessions.byToken(token)!.id;
    expect(e.services.points.total(id)).toBe(15);
    expect(e.services.points.recent()[0]).toMatchObject({ source: 'gate', gateId: body.gate.id, reason: 'Photo: a pumpkin' });
  });
});

describe('admin points API', () => {
  it('gives and takes points, and manages rewards', async () => {
    const e = env();
    const kari = await guest(e, 'Kari');
    const cookie = await adminCookie(e);
    const post = (path: string, body: object) => request(e.app).post(`/api/admin${path}`).set('cookie', cookie).send(body);

    expect((await post('/points', { sessionId: kari, amount: 12, reason: 'Saddest message' })).body).toMatchObject({ total: 12 });
    expect((await post('/points', { sessionId: kari, amount: 0, reason: 'x' })).status).toBe(400);
    expect((await post('/points', { sessionId: kari, amount: 5, reason: '' })).status).toBe(400);
    expect((await post('/points', { sessionId: 'nope', amount: 5, reason: 'x' })).status).toBe(404);

    const reward = (await post('/rewards', { threshold: 10, prize: 'Candy' })).body.reward;
    expect(reward).toMatchObject({ threshold: 10, prize: 'Candy', revealed: false, winnerName: 'Kari' });
    expect((await post('/rewards', { threshold: -1, prize: 'x' })).status).toBe(400);

    const patch = (body: object) => request(e.app).patch(`/api/admin/rewards/${reward.id}`).set('cookie', cookie).send(body);
    expect((await patch({ revealed: true })).body.reward.revealed).toBe(true);
    // Editing only the text keeps it revealed.
    expect((await patch({ prize: 'Lots of candy' })).body.reward).toMatchObject({ prize: 'Lots of candy', revealed: true });
    expect((await patch({ threshold: 99 })).status).toBe(409);
    expect((await patch({})).status).toBe(400);

    const all = await request(e.app).get('/api/admin/points').set('cookie', cookie);
    expect(all.body.leaderboard).toEqual([{ rank: 1, sessionId: kari, name: 'Kari', points: 12 }]);
    expect(all.body.rewards).toHaveLength(1);
    expect(all.body.recent[0]).toMatchObject({ amount: 12, reason: 'Saddest message', sessionName: 'Kari' });
    expect((await request(e.app).get('/api/admin/sessions').set('cookie', cookie)).body.sessions[0].points).toBe(12);

    expect((await request(e.app).delete(`/api/admin/rewards/${reward.id}`).set('cookie', cookie)).status).toBe(200);
    expect((await request(e.app).get('/api/admin/points')).status).toBe(401);
  });
});

describe('live', () => {
  const servers: Server[] = [];
  const aborts: AbortController[] = [];
  afterEach(async () => {
    for (const a of aborts.splice(0)) a.abort();
    await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
  });

  /** Collects every event on a guest's /api/events stream. */
  async function listen(e: TestEnv, token: string) {
    const server = e.app.listen(0, '127.0.0.1');
    servers.push(server);
    await new Promise((r) => server.once('listening', r));
    const ac = new AbortController();
    aborts.push(ac);
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/events`, {
      headers: { authorization: `Bearer ${token}` },
      signal: ac.signal,
    });
    const seen: { event: string; data: any }[] = [];
    void (async () => {
      let buf = '';
      try {
        for await (const chunk of res.body!.pipeThrough(new TextDecoderStream())) {
          buf += chunk;
          let i: number;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const lines = buf.slice(0, i).split('\n');
            buf = buf.slice(i + 2);
            const event = lines.find((l) => l.startsWith('event: '))?.slice(7);
            const data = lines.find((l) => l.startsWith('data: '))?.slice(6);
            if (event && data) seen.push({ event, data: JSON.parse(data) });
          }
        }
      } catch {
        // aborted at the end of the test
      }
    })();
    const waitFor = async (event: string, n = 1) => {
      for (let i = 0; i < 100; i++) {
        const hits = seen.filter((s) => s.event === event);
        if (hits.length >= n) return hits[n - 1]!.data;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error(`no ${n}x "${event}"; got ${seen.map((s) => s.event).join(', ')}`);
    };
    return { seen, waitFor };
  }

  it('sends the scores on connect and pushes every change, plus a win and an award notice', async () => {
    const e = env();
    const kari = await newGuest(e, 'Kari');
    const per = await newGuest(e, 'Per');
    const kariId = e.services.sessions.byToken(kari.token)!.id;
    e.services.points.addReward({ threshold: 10, prize: 'Hidden candy' });

    const k = await listen(e, kari.token);
    const p = await listen(e, per.token);
    expect(await k.waitFor('points')).toEqual({ points: 0, rank: null });
    expect(await k.waitFor('scoreboard')).toEqual({ top: [], rewards: [{ id: expect.any(String), threshold: 10, prize: null, winner: null }] });

    const cookie = await adminCookie(e);
    await request(e.app).post('/api/admin/points').set('cookie', cookie).send({ sessionId: kariId, amount: 12, reason: 'Best tears' });
    expect(await k.waitFor('points_awarded')).toEqual({ amount: 12, reason: 'Best tears' });
    expect(await k.waitFor('points', 2)).toEqual({ points: 12, rank: 1 });
    expect(await k.waitFor('reward_won')).toMatchObject({ threshold: 10, prize: null, winner: 'Kari' });
    // Everyone sees the new leaderboard; only Kari hears about her award and win.
    expect(await p.waitFor('scoreboard', 2)).toMatchObject({ top: [{ rank: 1, name: 'Kari', points: 12 }], rewards: [{ winner: 'Kari' }] });
    expect(p.seen.map((s) => s.event)).not.toContain('reward_won');
    expect(p.seen.map((s) => s.event)).not.toContain('points_awarded');

    // Revealing the prize reaches everyone.
    const rewardId = e.services.points.rewards()[0]!.id;
    await request(e.app).patch(`/api/admin/rewards/${rewardId}`).set('cookie', cookie).send({ revealed: true });
    expect(await p.waitFor('scoreboard', 3)).toMatchObject({ rewards: [{ prize: 'Hidden candy' }] });
  });
});
