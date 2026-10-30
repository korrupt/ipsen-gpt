import { Router } from 'express';
import { z } from 'zod';
import type { Config } from '../config.js';
import { allow, clientIp, requireSession, sessionOf, sessionView } from '../http.js';
import { gateView } from '../gates.js';
import { NameError } from '../sessions.js';
import type { Services } from '../services.js';

const NameBody = z.object({ name: z.string().max(200) });

export function sessionRouter(config: Config, { sessions, gates, limiter, points, scoreboard }: Services): Router {
  const router = Router();
  /** The gate the guest must pass before chatting, if any. */
  const currentGate = (sessionId: string) => {
    const g = gates.current(sessionId);
    return g ? gateView(g) : null;
  };

  const nameError = (res: import('express').Response, err: unknown) => {
    if (!(err instanceof NameError)) throw err;
    res.status(err.code === 'invalid' ? 400 : 409).json({ error: err.message, code: err.code });
  };

  router.post('/session', (req, res) => {
    const body = NameBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'Pick a name first.', code: 'invalid' });
      return;
    }
    if (!allow(limiter, res, `session:ip:${clientIp(req)}`, config.rateLimits.sessionCreatePerIp)) return;
    try {
      const { token, session } = sessions.create(body.data.name);
      gates.sessionStarted(session.id);
      res.status(201).json({ token, session: sessionView(session), gate: currentGate(session.id) });
    } catch (err) {
      nameError(res, err);
    }
  });

  router.get('/session', requireSession(sessions), (_req, res) => {
    const s = sessionOf(res);
    res.json({
      session: sessionView(s),
      gate: currentGate(s.id),
      messages: sessions.recentMessages(s.id, 200).map(({ role, content }) => ({ role, content })),
    });
  });

  /** The leaderboard and rewards (prizes hidden until revealed), plus the guest's own standing. */
  router.get('/leaderboard', requireSession(sessions), (_req, res) => {
    res.json({ ...scoreboard(), me: points.standing(sessionOf(res).id) });
  });

  router.put('/session/name', requireSession(sessions), (req, res) => {
    const body = NameBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'Pick a name first.', code: 'invalid' });
      return;
    }
    if (!allow(limiter, res, `session:ip:${clientIp(req)}`, config.rateLimits.sessionCreatePerIp)) return;
    try {
      res.json({ session: sessionView(sessions.setName(sessionOf(res).id, body.data.name)) });
    } catch (err) {
      nameError(res, err);
    }
  });

  return router;
}
