import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export type Db = Database.Database;

/** Append-only. Each entry runs once, tracked by PRAGMA user_version. */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE sessions (
    id                TEXT PRIMARY KEY,
    token_hash        TEXT NOT NULL UNIQUE,
    name              TEXT,
    name_key          TEXT,
    state             TEXT NOT NULL CHECK (state IN ('guest', 'pending_claim', 'claimed')),
    person_slug       TEXT,
    claim_code        TEXT UNIQUE,
    claim_person_slug TEXT,
    notice            TEXT,
    created_at        INTEGER NOT NULL,
    last_seen_at      INTEGER NOT NULL,
    ended_at          INTEGER
  );
  -- Names are unique among live sessions. Pending claims don't hold the name,
  -- so several guests can claim the same person in parallel.
  CREATE UNIQUE INDEX sessions_name_key ON sessions (name_key)
    WHERE name_key IS NOT NULL AND ended_at IS NULL AND state != 'pending_claim';
  CREATE UNIQUE INDEX sessions_person ON sessions (person_slug)
    WHERE person_slug IS NOT NULL AND ended_at IS NULL;

  CREATE TABLE messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
    role       TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content    TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX messages_session ON messages (session_id, id);

  CREATE TABLE admin_sessions (
    token_hash TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  `,
  `
  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  `
  -- A gate given to one session. The definition is copied in, so editing
  -- gates.json mid-party never changes a gate someone is already facing.
  CREATE TABLE gates (
    id            TEXT PRIMARY KEY,
    session_id    TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
    def_key       TEXT,
    source        TEXT NOT NULL,
    target        TEXT NOT NULL,
    guest_prompt  TEXT NOT NULL,
    refusal_lines TEXT NOT NULL,
    points        INTEGER NOT NULL,
    status        TEXT NOT NULL CHECK (status IN ('active', 'passed', 'expired', 'cancelled')),
    refusals      INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL,
    deadline_at   INTEGER,
    resolved_at   INTEGER
  );
  CREATE INDEX gates_session ON gates (session_id, status);
  -- Triggered gates fire once per session; the admin can force a gate again.
  CREATE UNIQUE INDEX gates_once ON gates (session_id, def_key)
    WHERE def_key IS NOT NULL AND source != 'admin_forced';

  -- Timed global gates that have fired, so a restart doesn't fire them again.
  CREATE TABLE gate_timers (
    def_key  TEXT NOT NULL,
    at       TEXT NOT NULL,
    fired_at INTEGER NOT NULL,
    PRIMARY KEY (def_key, at)
  );

  CREATE TABLE photo_attempts (
    id                 TEXT PRIMARY KEY,
    session_id         TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
    gate_id            TEXT REFERENCES gates (id) ON DELETE SET NULL,
    target             TEXT NOT NULL,
    status             TEXT NOT NULL CHECK (status IN ('verifying', 'passed', 'failed', 'unverified')),
    contains_target    INTEGER,
    confidence         REAL,
    reason             TEXT,
    error              TEXT,
    resized_file       TEXT,
    original_file      TEXT,
    original_mime      TEXT,
    original_bytes     INTEGER,
    -- 1: decoded, rotated and re-encoded without metadata. 0: stored as uploaded (e.g. HEIC).
    original_processed INTEGER,
    consent_at         INTEGER NOT NULL,
    created_at         INTEGER NOT NULL,
    verified_at        INTEGER,
    deleted_at         INTEGER
  );
  CREATE INDEX photo_attempts_session ON photo_attempts (session_id, created_at);
  `,
  `
  -- Every point change. A session's score is the sum of its rows.
  CREATE TABLE points (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
    amount     INTEGER NOT NULL,
    reason     TEXT NOT NULL,
    source     TEXT NOT NULL CHECK (source IN ('gate', 'admin')),
    -- The gate a 'gate' row came from; a gate pays out once.
    gate_id    TEXT UNIQUE REFERENCES gates (id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX points_session ON points (session_id, created_at);
  -- Gates passed before the ledger existed.
  INSERT INTO points (session_id, amount, reason, source, gate_id, created_at)
    SELECT session_id, points, 'Photo gate: ' || target, 'gate', id, COALESCE(resolved_at, created_at)
    FROM gates WHERE status = 'passed' AND points != 0;

  -- "First to <threshold> points": won once, by the first session to get there.
  CREATE TABLE rewards (
    id         TEXT PRIMARY KEY,
    threshold  INTEGER NOT NULL CHECK (threshold > 0),
    prize      TEXT NOT NULL,
    -- 0: guests see the goal but the prize as "???".
    revealed   INTEGER NOT NULL DEFAULT 0,
    winner_id  TEXT REFERENCES sessions (id) ON DELETE SET NULL,
    won_at     INTEGER,
    created_at INTEGER NOT NULL
  );

  -- A persona for this session only (null: the global one).
  ALTER TABLE sessions ADD COLUMN persona_id TEXT;
  `,
];

export function openDb(dbPath: string): Db {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]!);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}
