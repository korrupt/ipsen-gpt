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
