import { AdminAuth } from './admin/auth.js';
import type { Config } from './config.js';
import { openDb, type Db } from './db.js';
import { ErrorLog } from './errorLog.js';
import { loadGateDefs, type GateDefSet } from './gateDefs.js';
import { GateStore } from './gates.js';
import { Llm } from './llm.js';
import { PeopleStore } from './people.js';
import { PhotoStore } from './photos.js';
import { RateLimiter } from './rateLimit.js';
import { SessionStore } from './sessions.js';
import { Settings } from './settings.js';

export interface Services {
  db: Db;
  people: PeopleStore;
  sessions: SessionStore;
  gates: GateStore;
  /** Current gate definitions, read from disk. */
  gateDefs: () => GateDefSet;
  photos: PhotoStore;
  adminAuth: AdminAuth;
  limiter: RateLimiter;
  settings: Settings;
  llm: Llm;
  errors: ErrorLog;
  /** Logs to stderr and keeps the entry for the admin System screen. */
  log: (msg: string, err?: unknown) => void;
  /** Session ids with a reply currently streaming. */
  inFlight: Set<string>;
  /** Session ids with a photo being verified. */
  verifying: Set<string>;
  /** Fires timed gates and expires deadlines; index.ts runs it every few seconds. */
  tick: () => void;
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
  const sessions = new SessionStore(db, people, now);
  const gateDefs = () => loadGateDefs(config.gatesPath, people);
  const gates = new GateStore(db, gateDefs, now);
  const log = (msg: string, err?: unknown) => {
    write(msg, err);
    errors.add(msg, err);
  };
  return {
    db,
    people,
    sessions,
    gates,
    gateDefs,
    photos: new PhotoStore(db, config.photos.dir, now),
    adminAuth: new AdminAuth(db, config.admin, now),
    limiter: new RateLimiter(now),
    settings,
    llm: new Llm(config.ollama, settings, log, now),
    errors,
    log,
    inFlight: new Set(),
    verifying: new Set(),
    tick: () =>
      gates.tick(
        () => sessions.liveNamedIds(),
        (slug) => sessions.holderOf(slug)?.id,
      ),
  };
}
