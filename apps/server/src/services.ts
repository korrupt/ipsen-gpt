import { AdminAuth } from './admin/auth.js';
import type { Config } from './config.js';
import { openDb, type Db } from './db.js';
import { PeopleStore } from './people.js';
import { RateLimiter } from './rateLimit.js';
import { SessionStore } from './sessions.js';

export interface Services {
  db: Db;
  people: PeopleStore;
  sessions: SessionStore;
  adminAuth: AdminAuth;
  limiter: RateLimiter;
  /** Session ids with a reply currently streaming. */
  inFlight: Set<string>;
}

export function createServices(config: Config, now: () => number = Date.now): Services {
  const db = openDb(config.dbPath);
  const people = new PeopleStore(config.peopleDir);
  return {
    db,
    people,
    sessions: new SessionStore(db, people, now),
    adminAuth: new AdminAuth(db, config.admin, now),
    limiter: new RateLimiter(now),
    inFlight: new Set(),
  };
}
