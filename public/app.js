(() => {
  const API = '/api';
  let pages = [];
  let currentId = 'home';
  let currentPage = null;
  let draft = null;
  let dirty = false;
  let editing = false;
  let previewTimer;
  let previewSequence = 0;
  let searchTimer;
  let searchController;
  let searchIndex = -1;
  let schemaMode = 'create';
  let toastTimer;
  let exportLocation = '';

  const content = document.getElementById('workspace-content');
  const pagesNav = document.getElementById('pages-nav');
  const collectionsNav = document.getElementById('collections-nav');
  const searchOverlay = document.getElementById('search-overlay');
  const searchInput = document.getElementById('search-input');
  const searchResults = document.getElementById('search-results');
  const databaseDialog = document.getElementById('database-dialog');
  const schemaColumns = document.getElementById('schema-columns');
  const schemaForm = document.getElementById('schema-form');
  const toastNode = document.getElementById('toast');

  const safeText = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const slug = value => value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'untitled';
  const pageById = id => pages.find(page => String(page.id) === String(id));

  async function api(route, options = {}) {
    const response = await fetch(`${API}${route}`, {
      ...options,
      headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...options.headers },
    });
    if (response.status === 204) return null;
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `Request failed (${response.status}).`);
    return result;
  }

  function notify(message, error = false) {
    toastNode.textContent = message;
    toastNode.classList.toggle('toast-error', error);
    toastNode.classList.add('show');
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toastNode.classList.remove('show'), 3000);
  }

  function setSaveState(label, saving = false) {
    const indicator = document.getElementById('save-indicator');
    indicator.classList.toggle('saving', saving);
    indicator.innerHTML = `<i></i> ${safeText(label)}`;
  }

  function formatDate(value) {
    if (!value) return 'just now';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'recently';
    return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date);
  }

  function navButton(page, active) {
    const icon = page.hasDatabase ? '▤' : '▧';
    return `<button class="nav-row ${String(page.id) === String(active) ? 'active' : ''}" type="button" data-page-id="${safeText(page.id)}" ${String(page.id) === String(active) ? 'aria-current="page"' : ''}><span class="page-emoji" aria-hidden="true">${icon}</span><span>${safeText(page.title)}</span></button>`;
  }

  async function refreshPages() {
    const listing = await api('/pages');
    const detailed = await Promise.all(listing.map(async page => {
      try {
        const detail = await api(`/pages/${page.id}`);
        return { ...page, hasDatabase: Boolean(detail.database) };
      } catch { return { ...page, hasDatabase: false }; }
    }));
    pages = detailed;
    renderNavigation();
  }

  function renderNavigation() {
    const sorted = [...pages].sort((a, b) => a.title.localeCompare(b.title));
    pagesNav.innerHTML = sorted.filter(page => !page.hasDatabase).map(page => navButton(page, currentId)).join('') || '<span class="nav-empty">Your pages will appear here</span>';
    collectionsNav.innerHTML = sorted.filter(page => page.hasDatabase).map(page => navButton(page, currentId)).join('') || '<span class="nav-empty">No databases yet</span>';
  }

  function syncRoute(id) {
    const hash = id === 'home' ? '#home' : id === 'settings' ? '#settings' : `#page/${encodeURIComponent(id)}`;
    history.replaceState(null, '', `${location.pathname}${location.search}${hash}`);
  }

  function updateBreadcrumb(page = null) {
    const parent = !page ? 'Private' : page.database ? 'Databases' : 'Pages';
    const title = page?.title || (currentId === 'settings' ? 'Settings & export' : 'Home');
    document.getElementById('breadcrumbs').innerHTML = `<span>${parent}</span><span class="crumb-divider">/</span><strong>${safeText(title)}</strong>`;
    document.title = `${title} · Fieldnotes`;
  }

  function pageHeader(page, { home = false, isEditing = false } = {}) {
    const title = isEditing
      ? `<input id="page-title-input" class="title-edit page-title" aria-label="Page title" value="${safeText(draft?.title ?? page.title)}">`
      : `<h1 class="page-title">${safeText(page.title)}</h1>`;
    const icon = home ? '⌂' : page.database ? '▤' : '▧';
    const updated = page.updated_at ? `Edited ${formatDate(page.updated_at)}` : 'A private workspace';
    const description = home
      ? 'A quiet place for everything you want to remember.'
      : page.database ? 'A simple database, kept with your notes.' : 'A Markdown page in your private workspace.';
    return `<header class="page-hero">
      <span class="page-icon" aria-hidden="true">${icon}</span>${title}
      <p class="page-description">${description}</p>
      <div class="page-meta"><span>${updated}</span><span class="meta-divider"></span><span>Private</span></div>
    </header>`;
  }

  function pageToolbar(page) {
    const buttons = editing
      ? '<button class="tool-button" type="button" data-action="cancel-edit">Cancel</button><button class="button-primary compact-primary" type="button" data-action="save-edit">Save changes</button>'
      : `<button class="tool-button" type="button" data-action="edit">✎  Edit</button>${page.database ? '<button class="tool-button" type="button" data-action="edit-schema">▤  Edit columns</button>' : '<button class="tool-button" type="button" data-action="new-database">＋  Add database</button>'}`;
    return `<div class="page-tools" role="toolbar" aria-label="Page actions">${buttons}<span class="tool-spacer"></span><button class="tool-button primary-soft" type="button" data-action="share">↗  Copy link</button><button class="icon-button more-button" type="button" aria-label="More page actions" data-action="page-menu">···</button></div>`;
  }

  function decorateWikiLinks(container, page) {
    if (!page) return;
    const targets = new Map((page.links || []).map(target => [target.title.toLocaleLowerCase(), target]));
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    const textNodes = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (node.parentElement?.closest('a, code, pre, script, style')) continue;
      if (node.nodeValue.includes('[[')) textNodes.push(node);
    }
    for (const node of textNodes) {
      const fragment = document.createDocumentFragment();
      const source = node.nodeValue;
      const pattern = /\[\[([^\]]+)\]\]/g;
      let cursor = 0;
      let match;
      while ((match = pattern.exec(source))) {
        fragment.append(document.createTextNode(source.slice(cursor, match.index)));
        const [targetTitle, labelText] = match[1].split('|', 2).map(value => value.trim());
        const target = targets.get(targetTitle.toLocaleLowerCase());
        if (target) {
          const anchor = document.createElement('a');
          anchor.className = 'wiki-link';
          anchor.href = `#page/${target.id}`;
          anchor.dataset.pageId = target.id;
          anchor.textContent = labelText || targetTitle;
          fragment.append(anchor);
        } else {
          const unresolved = document.createElement('span');
          unresolved.className = 'wiki-link unresolved';
          unresolved.textContent = labelText || targetTitle;
          fragment.append(unresolved);
        }
        cursor = pattern.lastIndex;
      }
      fragment.append(document.createTextNode(source.slice(cursor)));
      node.replaceWith(fragment);
    }
  }

  async function renderPreview(markdown, element, page, sequence = ++previewSequence) {
    if (!element) return;
    try {
      const result = await api('/markdown/preview', { method: 'POST', body: JSON.stringify({ markdown }) });
      if (sequence !== previewSequence || !element.isConnected) return;
      element.innerHTML = result.html;
      decorateWikiLinks(element, page);
    } catch (error) {
      if (sequence === previewSequence && element.isConnected) element.textContent = `Preview unavailable: ${error.message}`;
    }
  }

  function backlinkMarkup(page) {
    const backlinks = page.backlinks || [];
    if (!backlinks.length) return '';
    return `<section class="backlinks"><h3>Linked mentions</h3>${backlinks.map(item => `<a class="backlink-item" href="#page/${item.id}" data-page-id="${item.id}"><span aria-hidden="true">↗</span>${safeText(item.title)}</a>`).join('')}</section>`;
  }

  function renderHome() {
    const recent = [...pages].sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || '')).slice(0, 5);
    const rows = recent.map((page, index) => `<button class="recent-item" type="button" data-page-id="${page.id}"><span class="recent-symbol ${['green','blue','rose',''][index % 4]}" aria-hidden="true">${page.hasDatabase ? '▤' : '▧'}</span><span><strong>${safeText(page.title)}</strong><small>${page.hasDatabase ? 'Database' : 'Markdown page'}</small></span><span class="recent-date">${formatDate(page.updated_at)}</span></button>`).join('');
    return `${pageHeader({ title: 'Home' }, { home: true })}
      <div class="home-layout">
        <section class="welcome-note">
          <div class="welcome-copy"><h2>Make a little room for your thoughts.</h2><p>Keep your notes, plans, and small discoveries together. Start anywhere; you can always find your way back.</p><div class="welcome-actions"><button type="button" class="button-primary" data-action="new-page">＋ Create a page</button><button type="button" class="button-secondary" data-action="new-database">▤ New database</button></div></div>
          <div class="welcome-art" aria-hidden="true"><span class="spark">✳</span><span class="spark two">✳</span><div class="paper-stack"><div class="paper back"></div><div class="paper front"></div></div></div>
        </section>
        <div class="content-heading"><h2>Recently updated</h2><button class="text-link" type="button" data-action="search">Find a page</button></div>
        <div class="recent-list">${rows || '<div class="empty-state"><h2>A fresh page</h2><p>Create your first note and it will appear here.</p></div>'}</div>
        <hr class="section-rule">
        <div class="two-column">
          <section><div class="content-heading"><h2>A few ways to begin</h2></div><div class="quick-start">
            <button type="button" data-action="new-page"><span class="quick-mark">＋</span>Capture a thought</button>
            <button type="button" data-action="new-database"><span class="quick-mark">▤</span>Make a simple database</button>
            <button type="button" data-action="search"><span class="quick-mark">⌕</span>Find an old note</button>
          </div></section>
          <aside class="tip-box"><p class="tip-label">A small tip</p><p>Connect notes with a wiki link. Type <code>[[</code> and an existing page title, such as <em>Weekly notes</em>.</p></aside>
        </div>
      </div>`;
  }

  function renderRegularPage(page) {
    if (editing) {
      return `${pageHeader(page, { isEditing: true })}${pageToolbar(page)}
        <section class="editor-grid" aria-label="Markdown editor and preview">
          <div class="editor-pane"><label class="pane-label" for="markdown-editor"><span>Markdown</span><span>Plain text</span></label><textarea class="markdown-editor" id="markdown-editor" spellcheck="true" aria-label="Edit page in Markdown">${safeText(draft?.content ?? page.content ?? '')}</textarea></div>
          <div class="editor-pane"><div class="pane-label"><span>Preview</span><span>Live</span></div><div class="preview-pane"><article class="page-body" id="markdown-preview"><div class="content-loading" aria-label="Loading preview"></div></article></div></div>
        </section>`;
    }
    return `${pageHeader(page)}${pageToolbar(page)}<article class="page-body" id="page-content"><div class="content-loading" aria-label="Loading page preview"></div></article>${backlinkMarkup(page)}`;
  }

  function renderDatabase(page) {
    const database = page.database;
    const columns = database?.columns || [];
    const rows = database?.rows || [];
    const header = columns.map(column => `<th>${safeText(column.name)}<small class="column-type">${safeText(column.type)}</small></th>`).join('');
    const body = rows.map(row => `<tr data-row-id="${row.id}">${columns.map(column => {
      const value = row.values?.[column.id] ?? '';
      const label = `${column.name} for ${Object.values(row.values || {})[0] || 'row'}`;
      if (column.type === 'select') {
        const options = column.options || [];
        return `<td><select data-row-id="${row.id}" data-column-id="${safeText(column.id)}" aria-label="${safeText(label)}"><option value="">Choose…</option>${options.map(option => `<option value="${safeText(option)}" ${option === value ? 'selected' : ''}>${safeText(option)}</option>`).join('')}</select></td>`;
      }
      const type = column.type === 'number' ? 'number' : column.type === 'date' ? 'date' : 'text';
      return `<td><input type="${type}" value="${safeText(value)}" data-row-id="${row.id}" data-column-id="${safeText(column.id)}" aria-label="${safeText(label)}" ${type === 'number' ? 'step="any"' : ''}></td>`;
    }).join('')}<td class="row-action-cell"><button type="button" class="row-remove" data-action="delete-row" data-row-id="${row.id}" aria-label="Delete row">×</button></td></tr>`).join('');
    return `${pageHeader(page)}${pageToolbar(page)}
      <div class="db-view-controls"><button type="button" class="view-tab active">▤ Table</button><span class="tool-spacer"></span><button class="tool-button" type="button" data-action="add-row">＋ New row</button></div>
      ${rows.length ? `<div class="database-wrap"><table class="database-table"><thead><tr>${header}<th aria-label="Row actions"></th></tr></thead><tbody>${body}</tbody></table><button class="add-row" type="button" data-action="add-row">＋ Add a row</button></div><div class="db-caption"><span>${rows.length} ${rows.length === 1 ? 'entry' : 'entries'}</span><span>Changes save to this device</span></div>` : `<div class="database-wrap empty-state"><h2>Nothing here yet</h2><p>Add your first row to start the collection.</p><button class="button-primary" type="button" data-action="add-row">＋ Add a row</button></div>`}`;
  }

  function renderSettings() {
    return `${pageHeader({ title: 'Settings & export', updated_at: '' })}
      <section class="settings-panel">
        <div class="settings-group settings-row"><div><h2>Export your notes</h2><p>Write all pages to plain Markdown files in your local export folder.</p></div><button class="button-secondary" type="button" data-action="export">↓ Export pages</button></div>
        <div class="settings-group"><h2>Stored on this device</h2><p>Pages and databases live in a local SQLite database. Markdown exports are saved as regular files on your computer.</p>${exportLocation ? `<code class="export-path">${safeText(exportLocation)}</code>` : ''}</div>
        <div class="settings-group"><h2>Privacy</h2><p>This workspace is designed for one person on one machine. It has no accounts, tracking, or cloud storage.</p></div>
      </section>`;
  }

  function render() {
    const page = currentPage;
    updateBreadcrumb(page);
    renderNavigation();
    if (currentId === 'settings') content.innerHTML = renderSettings();
    else if (currentId === 'home' || !page) content.innerHTML = renderHome();
    else if (page.database) content.innerHTML = renderDatabase(page);
    else content.innerHTML = renderRegularPage(page);
    bindContent();
    if (page && !editing && !page.database && currentId !== 'settings') {
      renderPreview(page.content || '', content.querySelector('#page-content'), page);
    } else if (page && editing) {
      renderPreview(draft?.content ?? page.content ?? '', content.querySelector('#markdown-preview'), page);
    }
  }

  function bindContent() {
    const markdown = content.querySelector('#markdown-editor');
    const title = content.querySelector('#page-title-input');
    const updateDraft = () => {
      if (!draft) return;
      draft.title = title?.value ?? draft.title;
      draft.content = markdown?.value ?? draft.content;
      dirty = true;
      setSaveState('Unsaved changes', true);
      window.clearTimeout(previewTimer);
      previewTimer = window.setTimeout(() => renderPreview(draft.content, content.querySelector('#markdown-preview'), currentPage), 180);
    };
    markdown?.addEventListener('input', updateDraft);
    title?.addEventListener('input', updateDraft);
    content.querySelectorAll('.database-table input, .database-table select').forEach(input => input.addEventListener('change', () => saveDatabaseCell(input)));
  }

  async function openPage(id) {
    if (editing && dirty && currentPage) {
      try { await saveDraft(); } catch { return; }
    }
    currentId = String(id);
    editing = false;
    draft = null;
    dirty = false;
    syncRoute(currentId);
    document.querySelector('.sidebar')?.classList.remove('open');
    currentPage = null;
    content.innerHTML = '<div class="content-loading" aria-label="Loading page"></div>';
    renderNavigation();
    try {
      currentPage = await api(`/pages/${encodeURIComponent(currentId)}`);
      const meta = pageById(currentId);
      if (meta) meta.hasDatabase = Boolean(currentPage.database);
      render();
      content.focus({ preventScroll: true });
      window.scrollTo({ top: 0, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    } catch (error) {
      content.innerHTML = `<section class="error-panel"><h2>Couldn’t open this page</h2><p>${safeText(error.message)}</p><button class="button-secondary" type="button" data-action="retry">Try again</button></section>`;
      bindContent();
    }
  }

  async function saveDraft() {
    if (!dirty || !currentPage || !draft) return;
    setSaveState('Saving changes…', true);
    const saved = await api(`/pages/${currentPage.id}`, { method: 'PATCH', body: JSON.stringify(draft) });
    currentPage = { ...currentPage, ...saved };
    dirty = false;
    draft = { title: saved.title, content: saved.content };
    const meta = pageById(currentPage.id);
    if (meta) { meta.title = saved.title; meta.updated_at = saved.updated_at; }
    setSaveState('All changes saved');
    renderNavigation();
  }

  async function createPage({ title = 'Untitled', content: markdown = '' } = {}) {
    try {
      const page = await api('/pages', { method: 'POST', body: JSON.stringify({ title, content: markdown }) });
      await refreshPages();
      currentId = String(page.id);
      currentPage = page;
      editing = true;
      dirty = false;
      draft = { title: page.title, content: page.content };
      syncRoute(currentId);
      render();
      content.querySelector('#page-title-input')?.focus();
      content.querySelector('#page-title-input')?.select();
    } catch (error) { notify(`Could not create page: ${error.message}`, true); }
  }

  async function createDatabasePage() {
    const title = window.prompt('Name this database page', 'New database');
    if (title === null) return;
    const cleanTitle = title.trim();
    if (!cleanTitle) { notify('Add a page name first.', true); return; }
    try {
      currentPage = await api('/pages', { method: 'POST', body: JSON.stringify({ title: cleanTitle, content: '' }) });
      currentId = String(currentPage.id);
      await refreshPages();
      syncRoute(currentId);
      editing = false;
      draft = null;
      dirty = false;
      openSchemaDialog('create', []);
      render();
    } catch (error) { notify(`Could not create the database page: ${error.message}`, true); }
  }

  async function saveDatabaseCell(input) {
    const column = currentPage?.database?.columns.find(item => item.id === input.dataset.columnId);
    if (!column) return;
    const value = column.type === 'number' && input.value !== '' ? Number(input.value) : input.value;
    const payload = { values: { [column.id]: value } };
    input.disabled = true;
    try {
      const updated = await api(`/pages/${currentPage.id}/database/rows/${input.dataset.rowId}`, { method: 'PATCH', body: JSON.stringify(payload) });
      const index = currentPage.database.rows.findIndex(row => String(row.id) === String(updated.id));
      if (index >= 0) currentPage.database.rows[index] = updated;
      input.disabled = false;
      setSaveState('All changes saved');
      notify('Cell updated.');
    } catch (error) {
      input.disabled = false;
      notify(`Could not save this cell: ${error.message}`, true);
    }
  }

  async function addDatabaseRow() {
    try {
      const row = await api(`/pages/${currentPage.id}/database/rows`, { method: 'POST', body: JSON.stringify({ values: {} }) });
      currentPage.database.rows.push(row);
      render();
      const lastRow = content.querySelector(`tr[data-row-id="${row.id}"] input, tr[data-row-id="${row.id}"] select`);
      lastRow?.focus();
    } catch (error) { notify(`Could not add a row: ${error.message}`, true); }
  }

  async function deleteDatabaseRow(rowId) {
    if (!window.confirm('Delete this row? This cannot be undone.')) return;
    try {
      await api(`/pages/${currentPage.id}/database/rows/${rowId}`, { method: 'DELETE' });
      currentPage.database.rows = currentPage.database.rows.filter(row => String(row.id) !== String(rowId));
      render();
      notify('Row deleted.');
    } catch (error) { notify(`Could not delete the row: ${error.message}`, true); }
  }

  function openSchemaDialog(mode, columns) {
    schemaMode = mode;
    document.getElementById('schema-title').textContent = mode === 'edit' ? 'Edit database columns' : 'Set up your database';
    schemaForm.querySelector('[type="submit"]').textContent = mode === 'edit' ? 'Save columns' : 'Create database';
    schemaColumns.innerHTML = '';
    (columns.length ? columns : [{ name: 'Name', type: 'text' }]).forEach(column => appendSchemaRow(column));
    databaseDialog.hidden = false;
    schemaColumns.querySelector('.schema-column-name')?.focus();
  }

  function appendSchemaRow(column = {}) {
    const row = document.createElement('div');
    row.className = 'schema-column-row';
    if (column.id) row.dataset.columnId = column.id;
    row.innerHTML = `<input class="schema-column-name" type="text" placeholder="Column name" aria-label="Column name" value="${safeText(column.name || '')}" required>
      <select class="schema-column-type" aria-label="Column type"><option value="text">Text</option><option value="number">Number</option><option value="date">Date</option><option value="select">Select</option></select>
      <input class="column-options" type="text" aria-label="Select options" placeholder="Options, separated by commas" value="${safeText((column.options || []).join(', '))}">
      <button class="column-remove" type="button" aria-label="Remove column">×</button>`;
    row.querySelector('.schema-column-type').value = column.type || 'text';
    row.querySelector('.column-options').hidden = (column.type || 'text') !== 'select';
    row.querySelector('.schema-column-type').addEventListener('change', event => { row.querySelector('.column-options').hidden = event.target.value !== 'select'; });
    row.querySelector('.column-remove').addEventListener('click', () => {
      if (schemaColumns.children.length < 2) { notify('A database needs at least one column.', true); return; }
      row.remove();
    });
    schemaColumns.append(row);
  }

  async function saveSchema(event) {
    event.preventDefault();
    const columns = [...schemaColumns.querySelectorAll('.schema-column-row')].map(row => {
      const type = row.querySelector('.schema-column-type').value;
      const column = { name: row.querySelector('.schema-column-name').value.trim(), type };
      if (row.dataset.columnId) column.id = row.dataset.columnId;
      if (type === 'select') column.options = row.querySelector('.column-options').value.split(',').map(value => value.trim()).filter(Boolean);
      return column;
    }).filter(column => column.name);
    if (!columns.length) { notify('Add at least one named column.', true); return; }
    try {
      currentPage.database = await api(`/pages/${currentPage.id}/database`, { method: 'PUT', body: JSON.stringify({ columns }) });
      const meta = pageById(currentPage.id);
      if (meta) meta.hasDatabase = true;
      databaseDialog.hidden = true;
      renderNavigation();
      render();
      notify(schemaMode === 'edit' ? 'Database columns updated.' : 'Database created.');
    } catch (error) { notify(`Could not save the database: ${error.message}`, true); }
  }

  async function renderSearchResults(query) {
    const term = query.trim();
    if (!term) { searchResults.innerHTML = '<p class="search-hint">Type to search your workspace</p>'; return; }
    if (searchController) searchController.abort();
    searchController = new AbortController();
    searchResults.innerHTML = '<p class="search-hint">Searching your pages…</p>';
    try {
      const result = await api(`/search?q=${encodeURIComponent(term)}`, { signal: searchController.signal });
      const pageHits = (result.pages || []).map(page => ({ id: page.id, title: page.title, excerpt: page.excerpt, type: 'Page' }));
      const rowHits = (result.database_rows || []).map(row => ({ id: row.page_id, title: row.page_title, excerpt: row.excerpt, type: 'Database row' }));
      const hits = [...pageHits, ...rowHits];
      if (!hits.length) { searchResults.innerHTML = '<p class="search-hint">No pages found. Try another search.</p>'; return; }
      searchResults.innerHTML = hits.map((hit, index) => `<button class="search-result ${index === searchIndex ? 'selected' : ''}" type="button" data-search-page="${hit.id}"><span class="result-icon">${hit.type === 'Page' ? '▧' : '▤'}</span><span><strong>${safeText(hit.title)} <small class="result-kind">· ${hit.type}</small></strong><small>${safeText(hit.excerpt || '')}</small></span></button>`).join('');
      searchResults.querySelectorAll('[data-search-page]').forEach(item => item.addEventListener('click', () => { hideSearch(); openPage(item.dataset.searchPage); }));
    } catch (error) {
      if (error.name !== 'AbortError') searchResults.innerHTML = `<p class="search-hint">Search could not finish: ${safeText(error.message)}</p>`;
    }
  }

  function moveSearchSelection(delta) {
    const matches = searchResults.querySelectorAll('[data-search-page]');
    if (!matches.length) return;
    searchIndex = (searchIndex + delta + matches.length) % matches.length;
    matches.forEach((node, index) => node.classList.toggle('selected', index === searchIndex));
    matches[searchIndex].scrollIntoView({ block: 'nearest' });
  }

  function showSearch() {
    searchOverlay.hidden = false;
    searchInput.value = '';
    searchIndex = -1;
    renderSearchResults('');
    window.setTimeout(() => searchInput.focus(), 0);
  }
  function hideSearch() { searchOverlay.hidden = true; searchIndex = -1; }

  async function exportPages() {
    try {
      const result = await api('/export', { method: 'POST', body: '{}' });
      exportLocation = result.directory;
      notify(`Exported ${result.count} ${result.count === 1 ? 'page' : 'pages'} to ${result.directory}.`);
      if (currentId === 'settings') render();
    } catch (error) { notify(`Export failed: ${error.message}`, true); }
  }

  async function copyPageLink() {
    const url = `${location.origin}${location.pathname}#page/${currentPage.id}`;
    try { await navigator.clipboard.writeText(url); notify('Local page link copied.'); }
    catch { notify('Clipboard access is unavailable in this browser.', true); }
  }

  async function deleteCurrentPage() {
    if (!currentPage || !window.confirm(`Delete “${currentPage.title}” and its database? This cannot be undone.`)) return;
    try {
      await api(`/pages/${currentPage.id}`, { method: 'DELETE' });
      currentId = 'home';
      currentPage = null;
      editing = false;
      draft = null;
      dirty = false;
      syncRoute(currentId);
      await refreshPages();
      render();
      notify('Page deleted.');
    } catch (error) { notify(`Could not delete the page: ${error.message}`, true); }
  }

  async function runAction(action, source) {
    if (action === 'new-page') return createPage();
    if (action === 'new-database') return currentPage ? openSchemaDialog('create', []) : createDatabasePage();
    if (action === 'settings') { currentId = 'settings'; currentPage = null; editing = false; syncRoute(currentId); render(); return; }
    if (action === 'search') { showSearch(); return; }
    if (action === 'close-search') { hideSearch(); return; }
    if (action === 'close-database-dialog') { databaseDialog.hidden = true; return; }
    if (action === 'add-column') { appendSchemaRow(); return; }
    if (action === 'edit-schema') { openSchemaDialog('edit', currentPage?.database?.columns || []); return; }
    if (action === 'add-row') return addDatabaseRow();
    if (action === 'delete-row') return deleteDatabaseRow(source.dataset.rowId);
    if (action === 'export') return exportPages();
    if (action === 'share') return currentPage ? copyPageLink() : notify('Open a page to copy its local link.');
    if (action === 'page-menu') return deleteCurrentPage();
    if (action === 'open-sidebar') { document.querySelector('.sidebar')?.classList.add('open'); return; }
    if (action === 'close-sidebar') { document.querySelector('.sidebar')?.classList.remove('open'); return; }
    if (action === 'retry') return openPage(currentId);
    if (action === 'edit') {
      draft = { title: currentPage.title, content: currentPage.content || '' };
      dirty = false;
      editing = true;
      setSaveState('All changes saved');
      render();
      content.querySelector('#markdown-editor')?.focus();
      return;
    }
    if (action === 'cancel-edit') {
      editing = false;
      draft = null;
      dirty = false;
      setSaveState('All changes saved');
      render();
      return;
    }
    if (action === 'save-edit') {
      try {
        await saveDraft();
        editing = false;
        draft = null;
        render();
        notify('Your changes are saved.');
      } catch (error) { notify(`Could not save this page: ${error.message}`, true); }
    }
  }

  async function initialize() {
    try {
      await refreshPages();
      const match = location.hash.match(/^#page\/(\d+)$/);
      if (match && pageById(match[1])) await openPage(match[1]);
      else if (location.hash === '#settings') runAction('settings');
      else { currentId = 'home'; currentPage = null; render(); }
    } catch (error) {
      content.innerHTML = `<section class="error-panel"><h2>Fieldnotes couldn’t connect</h2><p>${safeText(error.message)} Make sure the local app server is running, then try again.</p><button class="button-secondary" type="button" data-action="retry-workspace">Retry connection</button></section>`;
      content.querySelector('[data-action="retry-workspace"]')?.addEventListener('click', initialize);
    }
  }

  content.addEventListener('click', event => {
    const action = event.target.closest('[data-action]');
    if (action) runAction(action.dataset.action, action);
  });
  [pagesNav, collectionsNav].forEach(nav => nav.addEventListener('click', event => {
    const target = event.target.closest('[data-page-id]');
    if (target) openPage(target.dataset.pageId);
  }));
  databaseDialog.addEventListener('click', event => {
    const action = event.target.closest('[data-action]');
    if (action) runAction(action.dataset.action, action);
  });
  content.addEventListener('click', event => {
    const target = event.target.closest('[data-page-id]');
    if (target) {
      event.preventDefault();
      openPage(target.dataset.pageId);
    }
  });
  document.querySelectorAll('.sidebar [data-action]').forEach(button => button.addEventListener('click', () => runAction(button.dataset.action, button)));
  document.querySelectorAll('.topbar [data-action]').forEach(button => button.addEventListener('click', () => runAction(button.dataset.action, button)));
  document.querySelector('.search-backdrop').addEventListener('click', hideSearch);
  document.querySelector('.modal-backdrop').addEventListener('click', () => { databaseDialog.hidden = true; });
  schemaForm.addEventListener('submit', saveSchema);
  searchInput.addEventListener('input', () => {
    searchIndex = -1;
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => renderSearchResults(searchInput.value), 180);
  });
  searchInput.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown') { event.preventDefault(); moveSearchSelection(1); }
    if (event.key === 'ArrowUp') { event.preventDefault(); moveSearchSelection(-1); }
    if (event.key === 'Enter') (searchResults.querySelector('.search-result.selected') || searchResults.querySelector('[data-search-page]'))?.click();
  });
  document.addEventListener('keydown', event => {
    const key = event.key.toLowerCase();
    if ((event.metaKey || event.ctrlKey) && key === 'k') { event.preventDefault(); showSearch(); }
    if ((event.metaKey || event.ctrlKey) && key === 'n') { event.preventDefault(); createPage(); }
    if (event.key === 'Escape') {
      hideSearch();
      databaseDialog.hidden = true;
      document.querySelector('.sidebar')?.classList.remove('open');
    }
  });
  window.addEventListener('hashchange', () => {
    const match = location.hash.match(/^#page\/(\d+)$/);
    if (match && String(match[1]) !== currentId) openPage(match[1]);
    else if (location.hash === '#home' && currentId !== 'home') { currentId = 'home'; currentPage = null; editing = false; render(); }
    else if (location.hash === '#settings' && currentId !== 'settings') runAction('settings');
  });

  initialize();
})();
