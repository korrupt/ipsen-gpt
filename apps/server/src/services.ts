import { AdminAuth } from './admin/auth.js';
import type { Config } from './config.js';
import { openDb, type Db } from './db.js';
import { ErrorLog } from './errorLog.js';
import { Llm } from './llm.js';
import { PeopleStore } from './people.js';
import { RateLimiter } from './rateLimit.js';
import { SessionStore } from './sessions.js';
import { Settings } from './settings.js';

export interface Services {
  db: Db;
  people: PeopleStore;
  sessions: SessionStore;
  adminAuth: AdminAuth;
  limiter: RateLimiter;
  settings: Settings;
  llm: Llm;
  errors: ErrorLog;
  /** Logs to stderr and keeps the entry for the admin System screen. */
  log: (msg: string, err?: unknown) => void;
  /** Session ids with a reply currently streaming. */
  inFlight: Set<string>;
}

export interface ServiceOptions {
  now?: () => number;
  /** Where log lines go besides the error log. Default: stderr. */
  write?: (msg: string, err?: unknown) => void;
}

const stderr = (msg: string, err?: unknown) => console.error(`[${new Date().toISOString()}] ${msg}`, err ?? '');

export function createServices(config: Config, { now = Date.now, write = stderr }: ServiceOptions = {}): Services {
  const db = openDb(config.dbPath);
  const people = new PeopleStore(config.peopleDir);
  const settings = new Settings(db);
  const errors = new ErrorLog(50, now);
  const log = (msg: string, err?: unknown) => {
    write(msg, err);
    errors.add(msg, err);
  };
  return {
    db,
    people,
    sessions: new SessionStore(db, people, now),
    adminAuth: new AdminAuth(db, config.admin, now),
    limiter: new RateLimiter(now),
    settings,
    llm: new Llm(config.ollama, settings, log, now),
    errors,
    log,
    inFlight: new Set(),
  };
}
