import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import type { Config } from '../config.js';
import type { Db } from '../db.js';
import { hashToken, newToken } from '../sessions.js';

export const ADMIN_COOKIE = 'ipsen_admin';

const sha = (s: string) => crypto.createHash('sha256').update(s).digest();

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of header?.split(';') ?? []) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    try {
      out[k] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      // ignore malformed cookie values
    }
  }
  return out;
}

export class AdminAuth {
  constructor(
    private readonly db: Db,
    private readonly cfg: Config['admin'],
    private readonly now: () => number = Date.now,
  ) {}

  get enabled(): boolean {
    return this.cfg.password !== null;
  }

  checkPassword(password: string): boolean {
    if (this.cfg.password === null) return false;
    // Compare fixed-length digests so timing doesn't leak length or content.
    return crypto.timingSafeEqual(sha(password), sha(this.cfg.password));
  }

  createSession(): string {
    const token = newToken();
    const now = this.now();
    this.db.prepare('DELETE FROM admin_sessions WHERE expires_at <= ?').run(now);
    this.db
      .prepare('INSERT INTO admin_sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)')
      .run(hashToken(token), now, now + this.cfg.sessionTtlMs);
    return token;
  }

  isValid(token: string | undefined): boolean {
    if (!token || !this.enabled) return false;
    const row = this.db
      .prepare('SELECT expires_at FROM admin_sessions WHERE token_hash = ?')
      .get(hashToken(token)) as { expires_at: number } | undefined;
    return !!row && row.expires_at > this.now();
  }

  destroy(token: string | undefined): void {
    if (token) this.db.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').run(hashToken(token));
  }

  setCookie(res: Response, token: string): void {
    res.cookie(ADMIN_COOKIE, token, {
      httpOnly: true,
      secure: this.cfg.cookieSecure,
      sameSite: 'strict',
      path: '/api/admin',
      maxAge: this.cfg.sessionTtlMs,
    });
  }

  clearCookie(res: Response): void {
    res.clearCookie(ADMIN_COOKIE, {
      httpOnly: true,
      secure: this.cfg.cookieSecure,
      sameSite: 'strict',
      path: '/api/admin',
    });
  }

  tokenFrom(req: Request): string | undefined {
    return parseCookies(req.headers.cookie)[ADMIN_COOKIE];
  }

  require = (req: Request, res: Response, next: NextFunction): void => {
    if (!this.isValid(this.tokenFrom(req))) {
      res.status(401).json({ error: 'Not logged in' });
      return;
    }
    next();
  };
}
