import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { dataDirectory, databasePath } from './config.js';

fs.mkdirSync(path.dirname(databasePath), { recursive: true });
fs.mkdirSync(dataDirectory, { recursive: true });

export const db = new Database(databasePath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pages (
      id INTEGER PRIMARY KEY,
      title TEXT NOT NULL CHECK(length(trim(title)) > 0),
      content TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS page_databases (
      id INTEGER PRIMARY KEY,
      page_id INTEGER NOT NULL UNIQUE REFERENCES pages(id) ON DELETE CASCADE,
      columns_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS database_rows (
      id INTEGER PRIMARY KEY,
      database_id INTEGER NOT NULL REFERENCES page_databases(id) ON DELETE CASCADE,
      values_json TEXT NOT NULL DEFAULT '{}',
      position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS database_rows_order ON database_rows(database_id, position, id);
    CREATE VIRTUAL TABLE IF NOT EXISTS page_search USING fts5(title, content);
    CREATE VIRTUAL TABLE IF NOT EXISTS database_search USING fts5(page_title, content);
  `);
} catch (error) {
  if (String(error.message).includes('fts5')) {
    throw new Error('This SQLite build does not include FTS5, which is required for search.', { cause: error });
  }
  throw error;
}

// Rebuild FTS tables on startup to recover cleanly from an interrupted write.
const rebuildSearch = db.transaction(() => {
  db.prepare('DELETE FROM page_search').run();
  db.prepare('INSERT INTO page_search(rowid, title, content) SELECT id, title, content FROM pages').run();
  db.prepare('DELETE FROM database_search').run();
  db.prepare(`
    INSERT INTO database_search(rowid, page_title, content)
    SELECT r.id, p.title, COALESCE(
      (SELECT group_concat(value, ' ') FROM json_each(r.values_json)), ''
    ) || ' ' || COALESCE((
      SELECT group_concat(json_extract(c.value, '$.name'), ' ')
      FROM page_databases d, json_each(d.columns_json) c WHERE d.id = r.database_id
    ), '')
    FROM database_rows r
    JOIN page_databases d ON d.id = r.database_id
    JOIN pages p ON p.id = d.page_id
  `).run();
});
rebuildSearch();

export function now() {
  return new Date().toISOString();
}

export function refreshPageSearch(page) {
  db.prepare('DELETE FROM page_search WHERE rowid = ?').run(page.id);
  db.prepare('INSERT INTO page_search(rowid, title, content) VALUES (?, ?, ?)').run(page.id, page.title, page.content);
}

export function refreshDatabaseRowSearch(rowId) {
  const row = db.prepare(`
    SELECT r.id, r.values_json, d.columns_json, p.title
    FROM database_rows r
    JOIN page_databases d ON d.id = r.database_id
    JOIN pages p ON p.id = d.page_id WHERE r.id = ?
  `).get(rowId);
  db.prepare('DELETE FROM database_search WHERE rowid = ?').run(rowId);
  if (row) {
    const values = JSON.parse(row.values_json);
    const columns = JSON.parse(row.columns_json);
    const content = [...Object.values(values), ...columns.map((column) => column.name)].join(' ');
    db.prepare('INSERT INTO database_search(rowid, page_title, content) VALUES (?, ?, ?)').run(rowId, row.title, content);
  }
}

export function removeDatabaseRowSearch(rowId) {
  db.prepare('DELETE FROM database_search WHERE rowid = ?').run(rowId);
}

export function refreshPageDatabaseSearch(pageId) {
  const rows = db.prepare(`
    SELECT r.id FROM database_rows r JOIN page_databases d ON d.id = r.database_id WHERE d.page_id = ?
  `).all(pageId);
  for (const row of rows) refreshDatabaseRowSearch(row.id);
}
