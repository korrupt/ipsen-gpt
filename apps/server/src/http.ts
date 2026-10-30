import type { NextFunction, Request, Response } from 'express';
import type { RateLimitRule } from './config.js';
import type { RateLimiter } from './rateLimit.js';
import type { Session, SessionStore } from './sessions.js';

export const RATE_LIMITED_MESSAGE = 'Slow down. SadGPT needs a moment to process its feelings.';

/** Responds 429 and returns false if the key is over its limit. */
export function allow(limiter: RateLimiter, res: Response, key: string, rule: RateLimitRule): boolean {
  const waitMs = limiter.hit(key, rule);
  if (waitMs === 0) return true;
  res.setHeader('Retry-After', String(Math.ceil(waitMs / 1000)));
  res.status(429).json({ error: RATE_LIMITED_MESSAGE });
  return false;
}

export const clientIp = (req: Request) => req.ip ?? 'unknown';

/** Guest auth: `Authorization: Bearer <session token>`. */
export function requireSession(sessions: SessionStore) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const m = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '');
    const session = m ? sessions.byToken(m[1]!) : undefined;
    if (!session) {
      res.status(401).json({ error: 'session_invalid' });
      return;
    }
    sessions.touch(session);
    res.locals.session = session;
    next();
  };
}

export const sessionOf = (res: Response) => res.locals.session as Session;

/** What a guest may see about their own session. Never person info. */
export function sessionView(s: Session) {
  return { name: s.name, state: s.state, claimCode: s.claimCode, notice: s.notice };
}
