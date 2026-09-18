import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'schoolday.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS assignments (
    id            TEXT PRIMARY KEY,
    source        TEXT NOT NULL,
    external_id   TEXT NOT NULL,
    student       TEXT NOT NULL DEFAULT '',
    subject       TEXT NOT NULL,
    course        TEXT NOT NULL DEFAULT '',
    title         TEXT NOT NULL,
    due           TEXT NOT NULL,
    est_minutes   INTEGER NOT NULL DEFAULT 0,
    status        TEXT NOT NULL DEFAULT 'open',
    score         TEXT NOT NULL DEFAULT '',
    notes         TEXT NOT NULL DEFAULT '',
    fetched_at    TEXT NOT NULL,
    UNIQUE (source, external_id)
  );

  CREATE TABLE IF NOT EXISTS sync_runs (
    id          TEXT PRIMARY KEY,
    source      TEXT NOT NULL,
    started_at  TEXT NOT NULL,
    finished_at TEXT,
    status      TEXT NOT NULL DEFAULT 'running',
    count       INTEGER NOT NULL DEFAULT 0,
    error       TEXT
  );

  CREATE TABLE IF NOT EXISTS events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    topic      TEXT NOT NULL,
    payload    TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS jobs (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending',
    payload     TEXT NOT NULL DEFAULT '{}',
    attempts    INTEGER NOT NULL DEFAULT 0,
    last_error  TEXT,
    created_at  TEXT NOT NULL,
    started_at  TEXT,
    finished_at TEXT
  );

  CREATE TABLE IF NOT EXISTS kv (
    k TEXT PRIMARY KEY,
    v TEXT NOT NULL
  );
`);

// Migrate pre-existing databases that predate the student column.
try {
  db.exec(`ALTER TABLE assignments ADD COLUMN student TEXT NOT NULL DEFAULT ''`);
} catch {
  // column already present
}

// Migrate pre-existing databases that predate the score column.
try {
  db.exec(`ALTER TABLE assignments ADD COLUMN score TEXT NOT NULL DEFAULT ''`);
} catch {
  // column already present
}

export function kvGet(key, fallback = null) {
  const row = db.prepare('SELECT v FROM kv WHERE k = ?').get(key);
  return row ? row.v : fallback;
}

export function kvSet(key, value) {
  db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(key, value);
}

export default db;
