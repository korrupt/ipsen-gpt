import { AdminAuth } from './admin/auth.js';
import type { Config } from './config.js';
import { openDb, type Db } from './db.js';
import { ErrorLog } from './errorLog.js';
import { EventHub } from './events.js';
import { GateDefStore, type GateDefSet } from './gateDefs.js';
import { GateStore, gateView } from './gates.js';
import { InviteStore } from './invites.js';
import { Llm } from './llm.js';
import { PeopleStore } from './people.js';
import { PersonaStore } from './personas.js';
import { PointsStore, rewardView } from './points.js';
import { PhotoStore } from './photos.js';
import { RateLimiter } from './rateLimit.js';
import { SECRET_LEVELS, SecretStore, type SecretView } from './secrets.js';
import { SessionStore } from './sessions.js';
import { Settings } from './settings.js';

export interface Services {
  db: Db;
  people: PeopleStore;
  personas: PersonaStore;
  points: PointsStore;
  /** The secrets game's words and levels. Whether it's on, and its points, are in settings. */
  secrets: SecretStore;
  sessions: SessionStore;
  /** Single-use invite links that make the guest a person without a claim code. */
  invites: InviteStore;
  gates: GateStore;
  /** Current gate definitions, read from disk. */
  gateDefs: () => GateDefSet;
  /** Creates, edits and deletes gate definitions (admin). */
  gateStore: GateDefStore;
  photos: PhotoStore;
  adminAuth: AdminAuth;
  limiter: RateLimiter;
  settings: Settings;
  llm: Llm;
  /** Live events to guests' open /api/events streams. */
  events: EventHub;
  errors: ErrorLog;
  /** Logs to stderr and keeps the entry for the admin System screen. */
  log: (msg: string, err?: unknown) => void;
  /** Session ids with a reply currently streaming. */
  inFlight: Set<string>;
  /** Session ids with a photo being verified. */
  verifying: Set<string>;
  /** Fires timed gates and expires deadlines; index.ts runs it every few seconds. */
  tick: () => void;
  /** What guests see of the scores: the top of the leaderboard and the rewards. */
  scoreboard: () => { top: { rank: number; name: string; points: number }[]; rewards: ReturnType<typeof rewardView>[] };
  /** Sends every open page the new scoreboard and its own score (after points or names change). */
  pushScores: () => void;
  /** What a guest sees of their secrets game. */
  secretView: (sessionId: string) => SecretView;
  /** Sends the guest's secrets-game state to their open pages; no id: to every open page. */
  pushSecret: (sessionId?: string) => void;
}

/** How many places guests see on the leaderboard (their own place is always shown too). */
export const LEADERBOARD_SIZE = 10;

export interface ServiceOptions {
  now?: () => number;
  /** Where log lines go besides the error log. Default: stderr. */
  write?: (msg: string, err?: unknown) => void;
  /** Dice for random gates. Default: Math.random. */
  random?: () => number;
}

const stderr = (msg: string, err?: unknown) => console.error(`[${new Date().toISOString()}] ${msg}`, err ?? '');

export function createServices(config: Config, { now = Date.now, write = stderr, random = Math.random }: ServiceOptions = {}): Services {
  const db = openDb(config.dbPath);
  const people = new PeopleStore(config.peopleDir);
  const settings = new Settings(db);
  const errors = new ErrorLog(50, now);
  const sessions = new SessionStore(db, people, now);
  const gateStore = new GateDefStore(config.gatesPath, people, config.gatesSeedPath);
  const gateDefs = () => gateStore.load();
  const gates = new GateStore(db, gateDefs, now, random);
  const log = (msg: string, err?: unknown) => {
    write(msg, err);
    errors.add(msg, err);
  };
  try {
    if (gateStore.seed()) write(`Gates: copied the shipped gates into ${config.gatesPath}`);
  } catch (err) {
    log(`Could not copy the shipped gates into ${config.gatesPath}`, err);
  }
  const personas = new PersonaStore(config.chat.personasDir, config.chat.defaultPersona, settings, config.chat.personasSeedDir);
  try {
    const copied = personas.seed();
    if (copied.length) write(`Personas: copied ${copied.length} defaults into ${config.chat.personasDir}`);
  } catch (err) {
    log(`Could not copy the default personas into ${config.chat.personasDir}`, err);
  }
  const llm = new Llm(config.ollama, settings, log, now);
  const events = new EventHub();
  const points = new PointsStore(db, now);
  const secrets = new SecretStore(db, now);
  const secretView = (sessionId: string): SecretView => {
    if (!settings.get('secretsEnabled')) return { enabled: false };
    const level = secrets.level(sessionId);
    const done = level > SECRET_LEVELS;
    return { enabled: true, level: Math.min(level, SECRET_LEVELS), levels: SECRET_LEVELS, done, points: done ? null : (settings.get('secretPoints')[level - 1] ?? 0) };
  };
  const pushSecret = (sessionId?: string) => {
    for (const id of sessionId ? [sessionId] : events.sessionIds()) {
      if (events.isListening(id)) events.toSession(id, 'secret', secretView(id));
    }
  };
  const scoreboard = () => ({
    top: points.leaderboard(LEADERBOARD_SIZE).map(({ rank, name, points: p }) => ({ rank, name, points: p })),
    rewards: points.rewards().map(rewardView),
  });
  const pushScores = () => {
    const board = scoreboard();
    events.broadcast('scoreboard', board);
    // Places shift for everyone when one score changes, so everyone gets their own standing.
    for (const id of events.sessionIds()) events.toSession(id, 'points', points.standing(id));
  };
  points.onChange = ({ won }) => {
    pushScores();
    for (const r of won) if (r.winnerId) events.toSession(r.winnerId, 'reward_won', rewardView(r));
  };
  // Push changes to guests the moment they happen.
  llm.onStatusChange = (status) => events.broadcast('status', status);
  gates.onChange = (ids) => {
    for (const id of ids) {
      if (!events.isListening(id)) continue;
      const g = gates.current(id);
      events.toSession(id, 'gate', { gate: g ? gateView(g) : null });
    }
  };
  return {
    db,
    people,
    personas,
    points,
    secrets,
    sessions,
    invites: new InviteStore(db, now),
    gates,
    gateDefs,
    gateStore,
    photos: new PhotoStore(db, config.photos.dir, now),
    adminAuth: new AdminAuth(db, config.admin, now),
    limiter: new RateLimiter(now),
    settings,
    llm,
    events,
    errors,
    log,
    inFlight: new Set(),
    verifying: new Set(),
    scoreboard,
    pushScores,
    secretView,
    pushSecret,
    tick: () =>
      gates.tick(
        () => sessions.liveNamedIds(),
        (slug) => sessions.holderOf(slug)?.id,
      ),
  };
}
