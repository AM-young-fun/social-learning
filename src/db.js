import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { isoFromStatusId, statusIdFromUrl } from './x-time.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(__dirname);
const defaultDbPath = join(projectRoot, 'data', 'social-learning.sqlite');

export function openDatabase(dbPath = process.env.SOCIAL_LEARNING_DB || defaultDbPath) {
  mkdirSync(dirname(dbPath), { recursive: true });

  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db);

  return db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL DEFAULT 'x',
      handle TEXT NOT NULL,
      display_name TEXT,
      profile_url TEXT,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      visit_count INTEGER NOT NULL DEFAULT 0,
      UNIQUE(platform, handle)
    );

    CREATE TABLE IF NOT EXISTS profile_visits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      observed_at TEXT NOT NULL,
      page_url TEXT,
      source TEXT NOT NULL DEFAULT 'extension'
    );

    CREATE TABLE IF NOT EXISTS timeline_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      platform TEXT NOT NULL DEFAULT 'x',
      item_key TEXT NOT NULL,
      item_url TEXT,
      author_handle TEXT,
      authored_at TEXT,
      kind TEXT,
      text_content TEXT,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      observed_count INTEGER NOT NULL DEFAULT 0,
      UNIQUE(profile_id, platform, item_key)
    );

    CREATE TABLE IF NOT EXISTS timeline_observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timeline_item_id INTEGER NOT NULL REFERENCES timeline_items(id) ON DELETE CASCADE,
      observed_at TEXT NOT NULL,
      reply_count INTEGER,
      repost_count INTEGER,
      like_count INTEGER,
      quote_count INTEGER,
      view_count INTEGER,
      bookmark_count INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_profiles_last_seen ON profiles(last_seen_at DESC);
    CREATE INDEX IF NOT EXISTS idx_profile_visits_profile_time ON profile_visits(profile_id, observed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_items_profile_authored ON timeline_items(profile_id, authored_at DESC);
    CREATE INDEX IF NOT EXISTS idx_items_key ON timeline_items(platform, item_key);
    CREATE INDEX IF NOT EXISTS idx_observations_item_time ON timeline_observations(timeline_item_id, observed_at DESC);
  `);

  if (!hasColumn(db, 'timeline_items', 'text_content')) {
    db.exec('ALTER TABLE timeline_items ADD COLUMN text_content TEXT;');
  }

  backfillAuthoredAtFromStatusIds(db);
}

function hasColumn(db, tableName, columnName) {
  return db.prepare(`PRAGMA table_info(${tableName})`)
    .all()
    .some((column) => column.name === columnName);
}

function backfillAuthoredAtFromStatusIds(db) {
  const rows = db.prepare(`
    SELECT id, item_key, item_url
    FROM timeline_items
    WHERE authored_at IS NULL
  `).all();
  if (!rows.length) return;

  const update = db.prepare('UPDATE timeline_items SET authored_at = ? WHERE id = ?');
  db.exec('BEGIN');
  try {
    for (const item of rows) {
      const authoredAt = isoFromStatusId(item.item_key) || isoFromStatusId(statusIdFromUrl(item.item_url));
      if (authoredAt) update.run(authoredAt, item.id);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
