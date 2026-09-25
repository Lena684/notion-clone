import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';

const publicDirectory = fileURLToPath(new URL('../public/', import.meta.url));
const shell = fs.readFileSync(path.join(publicDirectory, 'index.html'), 'utf8');

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function safeJson(value) {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (character) => ({
    '<': '\\u003c', '>': '\\u003e', '&': '\\u0026', '\u2028': '\\u2028', '\u2029': '\\u2029',
  })[character]);
}

function navigationLink(page, activePageId) {
  const href = `/pages/${page.id}`;
  const active = String(page.id) === String(activePageId);
  const icon = page.hasDatabase ? '▤' : '▧';
  return `<a class="nav-row${active ? ' active' : ''}" href="${href}" data-page-id="${page.id}"${active ? ' aria-current="page"' : ''}><span class="page-emoji" aria-hidden="true">${icon}</span><span>${escapeHtml(page.title)}</span></a>`;
}

function navigation(pages, activePageId) {
  const sorted = [...pages].sort((left, right) => left.title.localeCompare(right.title));
  const regular = sorted.filter((page) => !page.hasDatabase).map((page) => navigationLink(page, activePageId)).join('');
  const databases = sorted.filter((page) => page.hasDatabase).map((page) => navigationLink(page, activePageId)).join('');
  return {
    regular: regular || '<span class="nav-empty">Your pages will appear here</span>',
    databases: databases || '<span class="nav-empty">No databases yet</span>',
  };
}

function pageHeader(page, { home = false } = {}) {
  const icon = home ? '⌂' : page.database ? '▤' : '▧';
  const description = home
    ? 'A quiet place for everything you want to remember.'
    : page.database ? 'A simple database, kept with your notes.' : 'A Markdown page in your private workspace.';
  const updated = page.updated_at
    ? `Edited ${new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(page.updated_at))}`
    : 'A private workspace';
  return `<header class="page-hero"><span class="page-icon" aria-hidden="true">${icon}</span><h1 class="page-title">${escapeHtml(page.title)}</h1><p class="page-description">${description}</p><div class="page-meta"><span>${escapeHtml(updated)}</span><span class="meta-divider"></span><span>Private</span></div></header>`;
}

function toolbar(page) {
  const databaseAction = page.database
    ? '<button class="tool-button" type="button" data-action="edit-schema">▤ Edit columns</button>'
    : '<button class="tool-button" type="button" data-action="new-database">＋ Add database</button>';
  return `<div class="page-tools" role="toolbar" aria-label="Page actions"><button class="tool-button" type="button" data-action="edit">✎ Edit</button>${databaseAction}<span class="tool-spacer"></span><button class="tool-button primary-soft" type="button" data-action="share">↗ Copy link</button><button class="icon-button more-button" type="button" aria-label="More page actions" data-action="page-menu">···</button></div>`;
}

function wikiLinksInHtml(html, page) {
  const targets = new Map((page.links || []).map((link) => [link.title.toLocaleLowerCase(), link]));
  let inCode = false;
  return html.replace(/<\/?(?:pre|code)\b[^>]*>|[^<]+|</g, (part) => {
    if (/^<(pre|code)\b/i.test(part)) { inCode = true; return part; }
    if (/^<\/(pre|code)>/i.test(part)) { inCode = false; return part; }
    if (inCode || part === '<') return part;
    return part.replace(/\[\[([^\]]+)\]\]/g, (_match, inner) => {
      const [targetTitle, label] = inner.split('|', 2).map((value) => value.trim());
      const target = targets.get(targetTitle.toLocaleLowerCase());
      const visible = escapeHtml(label || targetTitle);
      return target
        ? `<a class="wiki-link" href="/pages/${target.id}" data-page-id="${target.id}">${visible}</a>`
        : `<span class="wiki-link unresolved">${visible}</span>`;
    });
  });
}

async function markdownHtml(page) {
  const rendered = await marked.parse(page.content || '');
  const clean = sanitizeHtml(rendered, {
    allowedTags: [...new Set([...sanitizeHtml.defaults.allowedTags, 'h1', 'h2', 'img'])],
    allowedAttributes: {
      ...sanitizeHtml.defaults.allowedAttributes,
      a: ['href', 'name', 'target', 'rel'],
      img: ['src', 'alt', 'title'],
    },
    allowedSchemes: ['http', 'https', 'mailto'],
  });
  return wikiLinksInHtml(clean, page);
}

function backlinks(page) {
  const links = (page.backlinks || []).map((item) => `<a class="backlink-item" href="/pages/${item.id}" data-page-id="${item.id}"><span aria-hidden="true">↗</span>${escapeHtml(item.title)}</a>`).join('');
  return `<section class="backlinks"><h3>Linked mentions</h3>${links || '<p class="backlinks-empty">No pages link here yet.</p>'}</section>`;
}

function databaseTable(page) {
  const database = page.database;
  const columns = database?.columns || [];
  const rows = database?.rows || [];
  const header = columns.map((column) => `<th>${escapeHtml(column.name)}<small class="column-type">${escapeHtml(column.type)}</small></th>`).join('');
  const body = rows.map((row) => `<tr data-row-id="${row.id}">${columns.map((column) => {
    const value = row.values?.[column.id] ?? '';
    const label = `${column.name} for ${Object.values(row.values || {})[0] || 'row'}`;
    if (column.type === 'select') {
      const options = (column.options || []).map((option) => `<option value="${escapeHtml(option)}"${option === value ? ' selected' : ''}>${escapeHtml(option)}</option>`).join('');
      return `<td><select data-row-id="${row.id}" data-column-id="${escapeHtml(column.id)}" aria-label="${escapeHtml(label)}"><option value="">Choose…</option>${options}</select></td>`;
    }
    const inputType = column.type === 'number' ? 'number' : column.type === 'date' ? 'date' : 'text';
    return `<td><input type="${inputType}" value="${escapeHtml(value)}" data-row-id="${row.id}" data-column-id="${escapeHtml(column.id)}" aria-label="${escapeHtml(label)}"${inputType === 'number' ? ' step="any"' : ''}></td>`;
  }).join('')}<td class="row-action-cell"><button type="button" class="row-remove" data-action="delete-row" data-row-id="${row.id}" aria-label="Delete row">×</button></td></tr>`).join('');
  if (!columns.length) return '<div class="database-wrap empty-state"><h2>This database has no columns</h2><p>Add columns to start organizing rows.</p></div>';
  const table = rows.length
    ? `<div class="database-wrap"><table class="database-table"><thead><tr>${header}<th aria-label="Row actions"></th></tr></thead><tbody>${body}</tbody></table><button class="add-row" type="button" data-action="add-row">＋ Add a row</button></div><div class="db-caption"><span>${rows.length} ${rows.length === 1 ? 'entry' : 'entries'}</span><span>Changes save to this device</span></div>`
    : '<div class="database-wrap empty-state"><h2>Nothing here yet</h2><p>Add your first row to start the collection.</p><button class="button-primary" type="button" data-action="add-row">＋ Add a row</button></div>';
  return `<div class="db-view-controls"><button type="button" class="view-tab active">▤ Table</button><span class="tool-spacer"></span><button class="tool-button" type="button" data-action="add-row">＋ New row</button></div>${table}`;
}

async function pageBody(page) {
  const html = await markdownHtml(page);
  const markdown = `<article class="page-body" id="page-content">${html || '<p class="empty-page-hint">This page is empty. Choose Edit to add Markdown.</p>'}</article>`;
  return `${pageHeader(page)}${toolbar(page)}${markdown}${page.database ? databaseTable(page) : ''}${backlinks(page)}`;
}

function homeBody(pages) {
  const recent = [...pages].sort((left, right) => (right.updated_at || '').localeCompare(left.updated_at || '')).slice(0, 5);
  const rows = recent.map((page, index) => `<a class="recent-item" href="/pages/${page.id}" data-page-id="${page.id}"><span class="recent-symbol ${['green', 'blue', 'rose', ''][index % 4]}" aria-hidden="true">${page.hasDatabase ? '▤' : '▧'}</span><span><strong>${escapeHtml(page.title)}</strong><small>${page.hasDatabase ? 'Database' : 'Markdown page'}</small></span><span class="recent-date">${escapeHtml(page.updated_at ? new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(page.updated_at)) : 'New')}</span></a>`).join('');
  return `${pageHeader({ title: 'Home' }, { home: true })}<div class="home-layout"><section class="welcome-note"><div class="welcome-copy"><h2>Make a little room for your thoughts.</h2><p>Keep your notes, plans, and small discoveries together. Start anywhere; you can always find your way back.</p><div class="welcome-actions"><button type="button" class="button-primary" data-action="new-page">＋ Create a page</button><button type="button" class="button-secondary" data-action="new-database">▤ New database</button></div></div><div class="welcome-art" aria-hidden="true"><span class="spark">✳</span><span class="spark two">✳</span><div class="paper-stack"><div class="paper back"></div><div class="paper front"></div></div></div></section><div class="content-heading"><h2>Recently updated</h2><button class="text-link" type="button" data-action="search">Find a page</button></div><div class="recent-list">${rows || '<div class="empty-state"><h2>A fresh page</h2><p>Create your first note and it will appear here.</p></div>'}</div></div>`;
}

function shellFor({ page = null, pages = [], body, view = 'page' }) {
  const activeId = page?.id ?? null;
  const nav = navigation(pages, activeId);
  const currentTitle = page?.title || (view === 'settings' ? 'Settings & export' : 'Home');
  const parent = page?.database ? 'Databases' : page ? 'Pages' : view === 'settings' ? 'Workspace' : 'Private';
  const initialState = safeJson({ view, page, pages });
  return shell
    .replace('<title>Fieldnotes · Your workspace</title>', `<title>${escapeHtml(currentTitle)} · Fieldnotes</title>`)
    .replace('href="./styles.css"', 'href="/styles.css"')
    .replace('src="./app.js"', 'src="/app.js"')
    .replace('href="#home"', 'href="/"')
    .replace('<nav id="pages-nav" class="page-nav" aria-label="Pages"></nav>', `<nav id="pages-nav" class="page-nav" aria-label="Pages">${nav.regular}</nav>`)
    .replace('<nav id="collections-nav" class="page-nav" aria-label="Database pages"></nav>', `<nav id="collections-nav" class="page-nav" aria-label="Database pages">${nav.databases}</nav>`)
    .replace('<div class="breadcrumbs" id="breadcrumbs"><span>Private</span><span class="crumb-divider">/</span><strong>Home</strong></div>', `<div class="breadcrumbs" id="breadcrumbs"><span>${parent}</span><span class="crumb-divider">/</span><strong>${escapeHtml(currentTitle)}</strong></div>`)
    .replace('<div class="workspace-content" id="workspace-content" tabindex="-1"></div>', `<div class="workspace-content" id="workspace-content" tabindex="-1" data-server-rendered="true" data-view="${view}"${page ? ` data-page-id="${page.id}"` : ''}>${body}</div><script id="server-page-state" type="application/json">${initialState}</script>`);
}

export async function renderHomeDocument(pages) {
  return shellFor({ pages, body: homeBody(pages), view: 'home' });
}

export async function renderPageDocument(page, pages) {
  return shellFor({ page, pages, body: await pageBody(page), view: page.database ? 'database' : 'page' });
}

export async function renderSettingsDocument(pages, exportDirectory) {
  const body = `${pageHeader({ title: 'Settings & export', updated_at: '' })}<section class="settings-panel"><div class="settings-group settings-row"><div><h2>Export your notes</h2><p>Write all pages to plain Markdown files in your local export folder.</p><form method="post" action="/export"><button class="button-secondary" type="submit">↓ Export pages</button></form></div></div><div class="settings-group"><h2>Stored on this device</h2><p>Pages and databases live in a local SQLite database. Markdown exports are saved as regular files on your computer.</p><code class="export-path">${escapeHtml(exportDirectory)}</code></div><div class="settings-group"><h2>Privacy</h2><p>This workspace is designed for one person on one machine. It has no accounts, tracking, or cloud storage.</p></div></section>`;
  return shellFor({ pages, body, view: 'settings' });
}

export function renderNotFoundDocument(pages = []) {
  const body = '<section class="error-panel"><h2>Page not found</h2><p>This note may have been deleted or the link may be incorrect.</p><a class="button-secondary" href="/">Back to workspace</a></section>';
  return shellFor({ pages, body, view: 'not-found' });
}
