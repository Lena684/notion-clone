import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

let root;
let exportDir;
let db;
let server;
let baseUrl;

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'local-notes-test-'));
  exportDir = path.join(root, 'exports');
  process.env.NOTES_DATA_DIR = path.join(root, 'data');
  process.env.NOTES_DATABASE_PATH = path.join(root, 'data', 'test.sqlite');
  process.env.NOTES_EXPORT_DIR = exportDir;
  const [{ default: app }, database] = await Promise.all([
    import('../src/app.js'),
    import('../src/database.js'),
  ]);
  db = database.db;
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  db?.close();
  if (root) await fs.rm(root, { recursive: true, force: true });
});

async function request(route, { method = 'GET', body } = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = response.status === 204 ? null : await response.json();
  return { response, data };
}

test('serves the browser workspace and its frontend assets', async () => {
  const htmlResponse = await fetch(`${baseUrl}/`);
  assert.equal(htmlResponse.status, 200);
  assert.match(htmlResponse.headers.get('content-type'), /text\/html/);
  const html = await htmlResponse.text();
  assert.match(html, /Fieldnotes/);
  assert.match(html, /src="\/app\.js"/);
  assert.match(html, /data-server-rendered="true"/);
  assert.match(html, /data-view="home"/);
  assert.match(html, /id="server-page-state"/);

  const [scriptResponse, styleResponse] = await Promise.all([
    fetch(`${baseUrl}/app.js`),
    fetch(`${baseUrl}/styles.css`),
  ]);
  assert.equal(scriptResponse.status, 200);
  assert.match(await scriptResponse.text(), /\/markdown\/preview/);
  assert.equal(styleResponse.status, 200);
  assert.match(await styleResponse.text(), /--accent: #347565/);
});

test('page CRUD resolves wiki links and backlinks', async () => {
  const targetResult = await request('/api/pages', {
    method: 'POST', body: { title: 'Research', content: 'Useful notes.' },
  });
  assert.equal(targetResult.response.status, 201);

  const sourceResult = await request('/api/pages', {
    method: 'POST', body: { title: 'Home', content: 'See [[research]].' },
  });
  assert.equal(sourceResult.response.status, 201);
  assert.deepEqual(sourceResult.data.links.map((page) => page.id), [targetResult.data.id]);

  const target = await request(`/api/pages/${targetResult.data.id}`);
  assert.deepEqual(target.data.backlinks.map((page) => page.title), ['Home']);

  const targetHtmlResponse = await fetch(`${baseUrl}/pages/${targetResult.data.id}`);
  assert.equal(targetHtmlResponse.status, 200);
  const targetHtml = await targetHtmlResponse.text();
  assert.match(targetHtml, /<article class="page-body" id="page-content">[\s\S]*Useful notes\./);
  assert.match(targetHtml, /class="backlinks"[\s\S]*Home/);

  const sourceHtmlResponse = await fetch(`${baseUrl}/pages/${sourceResult.data.id}`);
  const sourceHtml = await sourceHtmlResponse.text();
  assert.match(sourceHtml, new RegExp(`href="/pages/${targetResult.data.id}"`));

  const updated = await request(`/api/pages/${sourceResult.data.id}`, {
    method: 'PATCH', body: { content: 'See [[research]] and [[Missing]].' },
  });
  assert.deepEqual(updated.data.unresolved, ['Missing']);
  const search = await request('/api/search?q=Missing');
  assert.equal(search.data.pages[0].id, sourceResult.data.id);
});

test('database rows validate types, support inline updates, and are searchable', async () => {
  const pageResult = await request('/api/pages', {
    method: 'POST', body: { title: 'Reading list', content: 'Databases are notes too.' },
  });
  const pageId = pageResult.data.id;
  const databaseResult = await request(`/api/pages/${pageId}/database`, {
    method: 'PUT',
    body: { columns: [
      { id: 'title', name: 'Title', type: 'text' },
      { id: 'rating', name: 'Rating', type: 'number' },
      { id: 'read', name: 'Read date', type: 'date' },
      { id: 'status', name: 'Status', type: 'select', options: ['To read', 'Done'] },
    ] },
  });
  assert.equal(databaseResult.response.status, 201);

  const rowResult = await request(`/api/pages/${pageId}/database/rows`, {
    method: 'POST', body: { values: { title: 'The Quiet Archive', rating: 4.5, read: '2026-09-01', status: 'Done' } },
  });
  assert.equal(rowResult.response.status, 201);
  assert.equal(rowResult.data.values.rating, 4.5);

  const inlineUpdate = await request(`/api/pages/${pageId}/database/rows/${rowResult.data.id}`, {
    method: 'PATCH', body: { values: { status: 'To read' } },
  });
  assert.equal(inlineUpdate.data.values.title, 'The Quiet Archive');
  assert.equal(inlineUpdate.data.values.status, 'To read');

  const search = await request('/api/search?q=Quiet');
  assert.equal(search.data.database_rows[0].row_id, rowResult.data.id);

  const invalid = await request(`/api/pages/${pageId}/database/rows`, {
    method: 'POST', body: { values: { rating: 'high' } },
  });
  assert.equal(invalid.response.status, 400);

  const persisted = await request(`/api/pages/${pageId}`);
  assert.equal(persisted.data.database.rows[0].values.status, 'To read');

  const renderedDatabase = await fetch(`${baseUrl}/pages/${pageId}`);
  const renderedHtml = await renderedDatabase.text();
  assert.match(renderedHtml, /class="database-table"/);
  assert.match(renderedHtml, /<article class="page-body" id="page-content">[\s\S]*Databases are notes too\./);
  assert.match(renderedHtml, /No pages link here yet\./);

  const emptyDatabasePage = await request('/api/pages', {
    method: 'POST', body: { title: 'Empty columns', content: '' },
  });
  await request(`/api/pages/${emptyDatabasePage.data.id}/database`, {
    method: 'PUT', body: { columns: [] },
  });
  const renderedEmptyDatabase = await fetch(`${baseUrl}/pages/${emptyDatabasePage.data.id}`);
  const emptyDatabaseHtml = await renderedEmptyDatabase.text();
  assert.match(emptyDatabaseHtml, /This database has no columns/);
  assert.match(emptyDatabaseHtml, /No pages link here yet\./);
});

test('Markdown preview sanitizes unsafe markup and manual export preserves wiki text', async () => {
  const preview = await request('/api/markdown/preview', {
    method: 'POST', body: { markdown: '# Title\n\n<script>alert(1)</script> [bad](javascript:alert(1))' },
  });
  assert.equal(preview.response.status, 200);
  assert.doesNotMatch(preview.data.html, /<script/i);
  assert.doesNotMatch(preview.data.html, /href=["']javascript:/i);

  const pageResult = await request('/api/pages', {
    method: 'POST', body: { title: 'Export sample', content: 'Link: [[Research]]' },
  });
  const exported = await request('/api/export', { method: 'POST' });
  assert.equal(exported.response.status, 200);
  const filename = `export-sample-${pageResult.data.id}.md`;
  const contents = await fs.readFile(path.join(exportDir, filename), 'utf8');
  assert.match(contents, /# Export sample\n\nLink: \[\[Research\]\]/);
});
