import express from 'express';
import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';
import { db, now, refreshDatabaseRowSearch, refreshPageDatabaseSearch, refreshPageSearch, removeDatabaseRowSearch } from './database.js';
import { HttpError, parseId, requireObject, requireString } from './errors.js';
import { exportPages } from './export.js';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { exportDirectory } from './config.js';
import { renderHomeDocument, renderNotFoundDocument, renderPageDocument, renderSettingsDocument } from './views.js';

const app = express();
app.disable('x-powered-by');
app.use(express.static(fileURLToPath(new URL('../public', import.meta.url)), { index: false }));
app.use(express.json({ limit: '1mb', strict: true }));
app.use(express.urlencoded({ extended: false, limit: '100kb' }));

const getPage = db.prepare('SELECT id, title, content, created_at, updated_at FROM pages WHERE id = ?');
const getPageDatabase = db.prepare('SELECT * FROM page_databases WHERE page_id = ?');

function getExistingPage(id) {
  const page = getPage.get(id);
  if (!page) throw new HttpError(404, 'Page not found.');
  return page;
}

function pageTitle(value) {
  const title = requireString(value, 'title').trim();
  if (!title) throw new HttpError(400, 'title must be a non-empty string.');
  return title;
}

function parseJson(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function wikiTargets(content) {
  return [...content.matchAll(/\[\[([^\]]+)\]\]/g)]
    .map((match) => match[1].split('|', 1)[0].trim())
    .filter(Boolean);
}

function pageLinks(page) {
  const resolveTitle = db.prepare('SELECT id, title FROM pages WHERE title = ? COLLATE NOCASE');
  const seen = new Set();
  const links = [];
  const unresolved = [];
  for (const title of wikiTargets(page.content)) {
    const target = resolveTitle.get(title);
    if (target) {
      if (!seen.has(target.id)) links.push(target);
      seen.add(target.id);
    } else if (!unresolved.some((item) => item.toLocaleLowerCase() === title.toLocaleLowerCase())) {
      unresolved.push(title);
    }
  }
  return { links, unresolved };
}

function backlinks(page) {
  const pages = db.prepare('SELECT id, title, content FROM pages WHERE id != ? ORDER BY title COLLATE NOCASE').all(page.id);
  return pages.filter((candidate) => wikiTargets(candidate.content)
    .some((title) => title.toLocaleLowerCase() === page.title.toLocaleLowerCase()))
    .map(({ id, title }) => ({ id, title }));
}

function pagePayload(page) {
  return { ...page, ...pageLinks(page), backlinks: backlinks(page) };
}

function validateColumns(input) {
  if (!Array.isArray(input)) throw new HttpError(400, 'columns must be an array.');
  if (input.length > 50) throw new HttpError(400, 'A database can have at most 50 columns.');
  const ids = new Set();
  const names = new Set();
  return input.map((column) => {
    requireObject(column, 'Each column');
    const name = requireString(column.name, 'Column name').trim();
    const type = column.type;
    if (!['text', 'number', 'date', 'select'].includes(type)) {
      throw new HttpError(400, `Column "${name}" has an unsupported type.`);
    }
    const id = typeof column.id === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(column.id)
      ? column.id : `col_${randomUUID().replaceAll('-', '')}`;
    if (ids.has(id)) throw new HttpError(400, 'Column ids must be unique.');
    if (names.has(name.toLocaleLowerCase())) throw new HttpError(400, 'Column names must be unique.');
    ids.add(id);
    names.add(name.toLocaleLowerCase());
    const normalized = { id, name, type };
    if (type === 'select') {
      if (!Array.isArray(column.options) || column.options.length > 100 || column.options.some((option) => typeof option !== 'string')) {
        throw new HttpError(400, `Select column "${name}" must have a string options array.`);
      }
      normalized.options = [...new Set(column.options.map((option) => option.trim()).filter(Boolean))];
    }
    return normalized;
  });
}

function validateRowValues(valuesInput, columns) {
  const values = requireObject(valuesInput, 'values');
  const allowed = new Set(columns.map((column) => column.id));
  for (const key of Object.keys(values)) {
    if (!allowed.has(key)) throw new HttpError(400, `Unknown column id: ${key}.`);
  }
  const normalized = {};
  for (const column of columns) {
    const value = values[column.id];
    if (value === undefined || value === null || value === '') continue;
    if (column.type === 'text') {
      if (typeof value !== 'string') throw new HttpError(400, `${column.name} must be text.`);
      normalized[column.id] = value;
    } else if (column.type === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new HttpError(400, `${column.name} must be a finite number.`);
      normalized[column.id] = value;
    } else if (column.type === 'date') {
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)
          || Number.isNaN(Date.parse(`${value}T00:00:00.000Z`))
          || new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value) {
        throw new HttpError(400, `${column.name} must be a valid date in YYYY-MM-DD format.`);
      }
      normalized[column.id] = value;
    } else {
      if (typeof value !== 'string' || !column.options.includes(value)) {
        throw new HttpError(400, `${column.name} must match one of its select options.`);
      }
      normalized[column.id] = value;
    }
  }
  return normalized;
}

function databasePayload(database) {
  if (!database) return null;
  return {
    id: database.id,
    page_id: database.page_id,
    columns: parseJson(database.columns_json, []),
    created_at: database.created_at,
    updated_at: database.updated_at,
    rows: db.prepare('SELECT id, values_json, position, created_at, updated_at FROM database_rows WHERE database_id = ? ORDER BY position, id')
      .all(database.id).map((row) => ({ ...row, values: parseJson(row.values_json, {}) })),
  };
}

function pageListForViews() {
  return db.prepare(`
    SELECT p.id, p.title, p.created_at, p.updated_at,
      EXISTS(SELECT 1 FROM page_databases d WHERE d.page_id = p.id) AS hasDatabase
    FROM pages p ORDER BY p.title COLLATE NOCASE
  `).all();
}

app.get('/', async (_request, response) => {
  response.type('html').send(await renderHomeDocument(pageListForViews()));
});

app.get('/pages/:id', async (request, response) => {
  const pageId = parseId(request.params.id, 'page id');
  const page = getPage.get(pageId);
  if (!page) return response.status(404).type('html').send(renderNotFoundDocument(pageListForViews()));
  const fullPage = {
    ...pagePayload(page),
    database: databasePayload(getPageDatabase.get(pageId)),
  };
  response.type('html').send(await renderPageDocument(fullPage, pageListForViews()));
});

app.get('/settings', async (_request, response) => {
  response.type('html').send(await renderSettingsDocument(pageListForViews(), exportDirectory));
});

app.post('/export', async (_request, response, next) => {
  try {
    await exportPages();
    response.redirect(303, '/settings');
  } catch (error) {
    next(error);
  }
});

app.get('/api/health', (_request, response) => response.json({ status: 'ok' }));

app.get('/api/pages', (_request, response) => {
  response.json(db.prepare('SELECT id, title, created_at, updated_at FROM pages ORDER BY title COLLATE NOCASE').all());
});

app.post('/api/pages', (request, response) => {
  const input = requireObject(request.body);
  const title = pageTitle(input.title);
  const content = input.content === undefined ? '' : requireString(input.content, 'content', { allowEmpty: true });
  const timestamp = now();
  const create = db.transaction(() => {
    const result = db.prepare('INSERT INTO pages(title, content, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run(title, content, timestamp, timestamp);
    const page = getPage.get(Number(result.lastInsertRowid));
    refreshPageSearch(page);
    return page;
  });
  const page = create();
  response.status(201).json(pagePayload(page));
});

app.get('/api/pages/:id', (request, response) => {
  const pageId = parseId(request.params.id, 'page id');
  response.json({ ...pagePayload(getExistingPage(pageId)), database: databasePayload(getPageDatabase.get(pageId)) });
});

app.patch('/api/pages/:id', (request, response) => {
  const pageId = parseId(request.params.id, 'page id');
  const current = getExistingPage(pageId);
  const input = requireObject(request.body);
  const title = input.title === undefined ? current.title : pageTitle(input.title);
  const content = input.content === undefined ? current.content : requireString(input.content, 'content', { allowEmpty: true });
  if (input.title === undefined && input.content === undefined) throw new HttpError(400, 'Provide title or content to update.');
  const updated = { ...current, title, content, updated_at: now() };
  const save = db.transaction(() => {
    db.prepare('UPDATE pages SET title = ?, content = ?, updated_at = ? WHERE id = ?')
      .run(title, content, updated.updated_at, pageId);
    refreshPageSearch(updated);
    refreshPageDatabaseSearch(pageId);
  });
  save();
  response.json(pagePayload(getPage.get(pageId)));
});

app.delete('/api/pages/:id', (request, response) => {
  const pageId = parseId(request.params.id, 'page id');
  getExistingPage(pageId);
  const remove = db.transaction(() => {
    db.prepare('DELETE FROM database_search WHERE rowid IN (SELECT r.id FROM database_rows r JOIN page_databases d ON d.id = r.database_id WHERE d.page_id = ?)').run(pageId);
    db.prepare('DELETE FROM page_search WHERE rowid = ?').run(pageId);
    db.prepare('DELETE FROM pages WHERE id = ?').run(pageId);
  });
  remove();
  response.status(204).end();
});

app.post('/api/markdown/preview', async (request, response) => {
  const input = requireObject(request.body);
  const markdown = requireString(input.markdown, 'markdown', { allowEmpty: true });
  const html = await marked.parse(markdown);
  response.json({ html: sanitizeHtml(html, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(['h1', 'h2', 'img']),
    allowedAttributes: { ...sanitizeHtml.defaults.allowedAttributes, a: ['href', 'name', 'target', 'rel'], img: ['src', 'alt', 'title'] },
    allowedSchemes: ['http', 'https', 'mailto'],
  }) });
});

app.get('/api/pages/:id/database', (request, response) => {
  const pageId = parseId(request.params.id, 'page id');
  getExistingPage(pageId);
  response.json(databasePayload(getPageDatabase.get(pageId)));
});

app.delete('/api/pages/:id/database', (request, response) => {
  const pageId = parseId(request.params.id, 'page id');
  getExistingPage(pageId);
  const database = getPageDatabase.get(pageId);
  if (!database) return response.status(204).end();
  const remove = db.transaction(() => {
    db.prepare('DELETE FROM database_search WHERE rowid IN (SELECT id FROM database_rows WHERE database_id = ?)').run(database.id);
    db.prepare('DELETE FROM page_databases WHERE id = ?').run(database.id);
  });
  remove();
  response.status(204).end();
});

app.put('/api/pages/:id/database', (request, response) => {
  const pageId = parseId(request.params.id, 'page id');
  getExistingPage(pageId);
  const input = requireObject(request.body);
  const columns = validateColumns(input.columns);
  const existing = getPageDatabase.get(pageId);
  const timestamp = now();
  if (existing) {
    const oldColumns = parseJson(existing.columns_json, []);
    const oldIds = new Set(oldColumns.map((column) => column.id));
    const newIds = new Set(columns.map((column) => column.id));
    const removedIds = [...oldIds].filter((id) => !newIds.has(id));
    const update = db.transaction(() => {
      db.prepare('UPDATE page_databases SET columns_json = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(columns), timestamp, existing.id);
      if (removedIds.length) {
        for (const row of db.prepare('SELECT id, values_json FROM database_rows WHERE database_id = ?').all(existing.id)) {
          const values = parseJson(row.values_json, {});
          for (const id of removedIds) delete values[id];
          db.prepare('UPDATE database_rows SET values_json = ?, updated_at = ? WHERE id = ?')
            .run(JSON.stringify(values), timestamp, row.id);
        }
      }
      refreshPageDatabaseSearch(pageId);
    });
    update();
  } else {
    db.prepare('INSERT INTO page_databases(page_id, columns_json, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run(pageId, JSON.stringify(columns), timestamp, timestamp);
  }
  response.status(existing ? 200 : 201).json(databasePayload(getPageDatabase.get(pageId)));
});

app.post('/api/pages/:id/database/rows', (request, response) => {
  const pageId = parseId(request.params.id, 'page id');
  getExistingPage(pageId);
  const database = getPageDatabase.get(pageId);
  if (!database) throw new HttpError(404, 'This page has no database.');
  const input = requireObject(request.body);
  const columns = parseJson(database.columns_json, []);
  const values = validateRowValues(input.values ?? {}, columns);
  const max = db.prepare('SELECT COALESCE(MAX(position), -1) AS position FROM database_rows WHERE database_id = ?').get(database.id).position;
  const timestamp = now();
  const create = db.transaction(() => {
    const result = db.prepare('INSERT INTO database_rows(database_id, values_json, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(database.id, JSON.stringify(values), input.position === undefined ? max + 1 : validatePosition(input.position), timestamp, timestamp);
    refreshDatabaseRowSearch(Number(result.lastInsertRowid));
    return Number(result.lastInsertRowid);
  });
  const rowId = create();
  response.status(201).json(getRow(rowId));
});

app.patch('/api/pages/:pageId/database/rows/:rowId', (request, response) => {
  const pageId = parseId(request.params.pageId, 'page id');
  const rowId = parseId(request.params.rowId, 'row id');
  getExistingPage(pageId);
  const database = getPageDatabase.get(pageId);
  if (!database) throw new HttpError(404, 'This page has no database.');
  const row = db.prepare('SELECT * FROM database_rows WHERE id = ? AND database_id = ?').get(rowId, database.id);
  if (!row) throw new HttpError(404, 'Database row not found.');
  const input = requireObject(request.body);
  const columns = parseJson(database.columns_json, []);
  const values = input.values === undefined
    ? parseJson(row.values_json, {})
    : validateRowValues({ ...parseJson(row.values_json, {}), ...requireObject(input.values, 'values') }, columns);
  const position = input.position === undefined ? row.position : validatePosition(input.position);
  const timestamp = now();
  const save = db.transaction(() => {
    db.prepare('UPDATE database_rows SET values_json = ?, position = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(values), position, timestamp, rowId);
    refreshDatabaseRowSearch(rowId);
  });
  save();
  response.json(getRow(rowId));
});

app.delete('/api/pages/:pageId/database/rows/:rowId', (request, response) => {
  const pageId = parseId(request.params.pageId, 'page id');
  const rowId = parseId(request.params.rowId, 'row id');
  getExistingPage(pageId);
  const database = getPageDatabase.get(pageId);
  if (!database) throw new HttpError(404, 'This page has no database.');
  const result = db.transaction(() => {
    const row = db.prepare('SELECT id FROM database_rows WHERE id = ? AND database_id = ?').get(rowId, database.id);
    if (!row) throw new HttpError(404, 'Database row not found.');
    removeDatabaseRowSearch(rowId);
    db.prepare('DELETE FROM database_rows WHERE id = ?').run(rowId);
  });
  result();
  response.status(204).end();
});

function validatePosition(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new HttpError(400, 'position must be a non-negative integer.');
  return value;
}

function getRow(rowId) {
  const row = db.prepare('SELECT id, values_json, position, created_at, updated_at FROM database_rows WHERE id = ?').get(rowId);
  return { ...row, values: parseJson(row.values_json, {}) };
}

app.get('/api/search', (request, response) => {
  const query = typeof request.query.q === 'string' ? request.query.q.trim() : '';
  if (!query) return response.json({ query, pages: [], database_rows: [] });
  const tokens = query.match(/[\p{L}\p{N}_-]+/gu) || [];
  if (tokens.length === 0) return response.json({ query, pages: [], database_rows: [] });
  const match = tokens.slice(0, 12).map((token) => `"${token.replaceAll('"', '""')}"*`).join(' AND ');
  const pages = db.prepare(`
    SELECT p.id, p.title, p.updated_at, snippet(page_search, 1, '<mark>', '</mark>', '…', 18) AS excerpt
    FROM page_search JOIN pages p ON p.id = page_search.rowid WHERE page_search MATCH ?
    ORDER BY bm25(page_search), p.updated_at DESC LIMIT 50
  `).all(match);
  const databaseRows = db.prepare(`
    SELECT r.id AS row_id, d.page_id, p.title AS page_title, r.values_json, r.position, r.updated_at,
      snippet(database_search, 1, '<mark>', '</mark>', '…', 18) AS excerpt
    FROM database_search
    JOIN database_rows r ON r.id = database_search.rowid
    JOIN page_databases d ON d.id = r.database_id
    JOIN pages p ON p.id = d.page_id WHERE database_search MATCH ?
    ORDER BY bm25(database_search), r.updated_at DESC LIMIT 50
  `).all(match).map((row) => ({ ...row, values: parseJson(row.values_json, {}) }));
  response.json({ query, pages, database_rows: databaseRows });
});

app.post('/api/export', async (_request, response, next) => {
  try {
    response.json(await exportPages());
  } catch (error) {
    next(error);
  }
});

app.use((error, _request, response, _next) => {
  if (response.headersSent) return;
  if (error instanceof HttpError) return response.status(error.status).json({ error: error.message });
  if (error?.type === 'entity.parse.failed') return response.status(400).json({ error: 'Request body must be valid JSON.' });
  if (error?.code === 'SQLITE_CONSTRAINT_UNIQUE') return response.status(409).json({ error: 'A page database already exists for this page.' });
  console.error(error);
  response.status(500).json({ error: 'An unexpected server error occurred.' });
});

export default app;
