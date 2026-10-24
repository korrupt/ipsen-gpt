import { Router } from 'express';
import { z } from 'zod';
import type { Config } from '../config.js';
import { allow, clientIp, requireSession, sessionOf, sessionView } from '../http.js';
import { NameError, type SessionStore } from '../sessions.js';
import type { RateLimiter } from '../rateLimit.js';

const NameBody = z.object({ name: z.string().max(200) });

export function sessionRouter(config: Config, sessions: SessionStore, limiter: RateLimiter): Router {
  const router = Router();

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
      res.status(201).json({ token, session: sessionView(session) });
    } catch (err) {
      nameError(res, err);
    }
  });

  router.get('/session', requireSession(sessions), (_req, res) => {
    const s = sessionOf(res);
    res.json({
      session: sessionView(s),
      messages: sessions.recentMessages(s.id, 200).map(({ role, content }) => ({ role, content })),
    });
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
