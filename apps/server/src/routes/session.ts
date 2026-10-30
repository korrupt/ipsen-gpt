import { Router } from 'express';
import { z } from 'zod';
import type { Config } from '../config.js';
import { allow, bearerToken, clientIp, requireSession, sessionOf, sessionView } from '../http.js';
import { gateView } from '../gates.js';
import { NameError, SessionError } from '../sessions.js';
import type { Services } from '../services.js';

const NameBody = z.object({ name: z.string().max(200) });
const InviteBody = z.object({ token: z.string().min(1).max(100) });

export const INVITE_INVALID = "That invite link doesn't work anymore. Ask SadGPT's human for a new one, or just pick a name.";

export function sessionRouter(config: Config, { sessions, invites, gates, limiter, points, scoreboard, pushScores }: Services): Router {
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

  /**
   * Opens an invite link: the guest becomes its person at once, no claim code.
   * With a live session (Bearer token), that session becomes the person and
   * keeps its chat and points; without one, a new session is made (201, with token).
   */
  router.post('/invite', (req, res) => {
    const body = InviteBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: INVITE_INVALID, code: 'invite_invalid' });
      return;
    }
    if (!allow(limiter, res, `invite:ip:${clientIp(req)}`, config.rateLimits.sessionCreatePerIp)) return;
    const token = bearerToken(req);
    const current = token ? sessions.byToken(token) : undefined;
    let joined;
    try {
      joined = invites.redeem(body.data.token, (slug) => sessions.joinAs(slug, current?.id));
    } catch (err) {
      if (!(err instanceof SessionError)) throw err;
      joined = null; // the person was deleted
    }
    if (!joined) {
      res.status(410).json({ error: INVITE_INVALID, code: 'invite_invalid' });
      return;
    }
    const { session } = joined;
    if (joined.token) gates.sessionStarted(session.id);
    gates.personAttached(session.id, session.personSlug!);
    pushScores(); // a new name on the leaderboard, or a claimant turned away
    res
      .status(joined.token ? 201 : 200)
      .json({ token: joined.token, session: sessionView(session), gate: currentGate(session.id) });
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
