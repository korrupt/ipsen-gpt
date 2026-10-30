import { Router } from 'express';
import { z } from 'zod';
import type { Config } from '../config.js';
import { gateView } from '../gates.js';
import { allow, requireSession, sessionOf } from '../http.js';
import { GUESS_LINES, SECRET_LEVELS } from '../secrets.js';
import type { Services } from '../services.js';

const GuessBody = z.object({ guess: z.string().max(200) });

export const SECRETS_OFF = "There's no secret right now. SadGPT has nothing to hide, which is somehow worse.";

/**
 * The secrets game for guests:
 *  - GET /secret: their level (never the word)
 *  - POST /secret {guess}: checks a guess at the current level. Right: points,
 *    the next level, and any photo gate that level starts with.
 */
export function secretRouter(config: Config, services: Services): Router {
  const router = Router();
  const { sessions, secrets, settings, points, gates, limiter, db, secretView, pushSecret } = services;

  router.get('/secret', requireSession(sessions), (_req, res) => {
    res.json({ secret: secretView(sessionOf(res).id) });
  });

  router.post('/secret', requireSession(sessions), (req, res) => {
    const session = sessionOf(res);
    if (session.name === null) {
      res.status(409).json({ error: 'Pick a name first.', code: 'name_required' });
      return;
    }
    const body = GuessBody.safeParse(req.body);
    if (!body.success || !body.data.guess.trim()) {
      res.status(400).json({ error: 'Type the secret word first.' });
      return;
    }
    if (!settings.get('secretsEnabled')) {
      res.status(409).json({ error: SECRETS_OFF, code: 'secrets_off', secret: secretView(session.id) });
      return;
    }
    if (secrets.level(session.id) > SECRET_LEVELS) {
      res.status(409).json({ error: GUESS_LINES.done, code: 'secrets_done', secret: secretView(session.id) });
      return;
    }
    if (!allow(limiter, res, `secret:session:${session.id}`, config.rateLimits.secretPerSession)) return;

    const result = db.transaction(() => {
      const r = secrets.guess(session.id, body.data.guess);
      if (!r.correct) return { correct: false as const, amount: 0 };
      const amount = settings.get('secretPoints')[r.level - 1] ?? 0;
      if (amount !== 0) points.award(session.id, amount, `Secret level ${r.level}: ${r.word.toUpperCase()}`, 'secret');
      return { correct: true as const, level: r.level, amount };
    })();

    if (!result.correct) {
      res.json({ correct: false, message: GUESS_LINES.wrong, points: 0, secret: secretView(session.id) });
      return;
    }
    const next = result.level + 1;
    const gate =
      next <= SECRET_LEVELS
        ? gates.secretLevelReached({ id: session.id, personSlug: session.state === 'claimed' ? session.personSlug : null }, next)
        : gates.current(session.id);
    pushSecret(session.id);
    res.json({
      correct: true,
      message: next > SECRET_LEVELS ? GUESS_LINES.done : GUESS_LINES.right,
      points: result.amount,
      secret: secretView(session.id),
      gate: gate ? gateView(gate) : null,
    });
  });

  return router;
}
