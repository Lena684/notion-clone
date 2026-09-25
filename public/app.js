(() => {
  const API = '/api';
  const serverStateNode = document.getElementById('server-page-state');
  let serverState = { view: 'home', page: null, pages: [] };
  try { if (serverStateNode) serverState = JSON.parse(serverStateNode.textContent); } catch { /* The server-rendered HTML remains usable without enhancement. */ }

  let pages = Array.isArray(serverState.pages) ? serverState.pages : [];
  let currentPage = serverState.page || null;
  let currentView = serverState.view || 'home';
  let currentId = currentPage ? String(currentPage.id) : currentView;
  let draft = null;
  let dirty = false;
  let editing = false;
  let previewTimer;
  let previewSequence = 0;
  let searchTimer;
  let searchController;
  let searchIndex = -1;
  let schemaMode = 'create';
  let schemaPageId = null;
  let schemaForNewPage = false;
  let toastTimer;
  let exportLocation = '';

  const content = document.getElementById('workspace-content');
  const searchOverlay = document.getElementById('search-overlay');
  const searchInput = document.getElementById('search-input');
  const searchResults = document.getElementById('search-results');
  const databaseDialog = document.getElementById('database-dialog');
  const schemaColumns = document.getElementById('schema-columns');
  const schemaForm = document.getElementById('schema-form');
  const toastNode = document.getElementById('toast');

  const safeText = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
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
    if (!indicator) return;
    indicator.classList.toggle('saving', saving);
    indicator.innerHTML = `<i></i> ${safeText(label)}`;
  }

  function navigateToPage(id) {
    window.location.assign(`/pages/${encodeURIComponent(id)}`);
  }

  function decorateWikiLinks(container, page) {
    if (!container || !page) return;
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
          anchor.href = `/pages/${target.id}`;
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
    const links = (page.backlinks || []).map(item => `<a class="backlink-item" href="/pages/${item.id}" data-page-id="${item.id}"><span aria-hidden="true">↗</span>${safeText(item.title)}</a>`).join('');
    return `<section class="backlinks"><h3>Linked mentions</h3>${links || '<p class="backlinks-empty">No pages link here yet.</p>'}</section>`;
  }

  function startEditing() {
    if (!currentPage || !['page', 'database'].includes(currentView)) return;
    const title = content.querySelector('.page-title');
    const body = content.querySelector('#page-content');
    const toolbar = content.querySelector('.page-tools');
    if (!title || !body || !toolbar) return;

    draft = { title: currentPage.title, content: currentPage.content || '' };
    dirty = false;
    editing = true;
    const titleInput = document.createElement('input');
    titleInput.id = 'page-title-input';
    titleInput.className = 'title-edit page-title';
    titleInput.setAttribute('aria-label', 'Page title');
    titleInput.value = draft.title;
    title.replaceWith(titleInput);

    const editor = document.createElement('section');
    editor.className = 'editor-grid';
    editor.setAttribute('aria-label', 'Markdown editor and preview');
    editor.innerHTML = `<div class="editor-pane"><label class="pane-label" for="markdown-editor"><span>Markdown</span><span>Plain text</span></label><textarea class="markdown-editor" id="markdown-editor" spellcheck="true" aria-label="Edit page in Markdown"></textarea></div><div class="editor-pane"><div class="pane-label"><span>Preview</span><span>Live</span></div><div class="preview-pane"><article class="page-body" id="markdown-preview"><div class="content-loading" aria-label="Loading preview"></div></article></div></div>`;
    editor.querySelector('#markdown-editor').value = draft.content;
    body.replaceWith(editor);
    toolbar.innerHTML = '<button class="tool-button" type="button" data-action="cancel-edit">Cancel</button><button class="button-primary compact-primary" type="button" data-action="save-edit">Save changes</button><span class="tool-spacer"></span>';
    setSaveState('All changes saved');
    renderPreview(draft.content, editor.querySelector('#markdown-preview'), currentPage);
    titleInput.focus();
    titleInput.select();
  }

  async function saveDraft() {
    if (!dirty || !currentPage || !draft) return;
    setSaveState('Saving changes…', true);
    await api(`/pages/${currentPage.id}`, { method: 'PATCH', body: JSON.stringify(draft) });
    dirty = false;
    setSaveState('All changes saved');
    window.location.reload();
  }

  async function createPage() {
    try {
      const page = await api('/pages', { method: 'POST', body: JSON.stringify({ title: 'Untitled', content: '' }) });
      navigateToPage(page.id);
    } catch (error) { notify(`Could not create page: ${error.message}`, true); }
  }

  async function createDatabasePage() {
    const title = window.prompt('Name this database page', 'New database');
    if (title === null) return;
    const cleanTitle = title.trim();
    if (!cleanTitle) { notify('Add a page name first.', true); return; }
    try {
      const page = await api('/pages', { method: 'POST', body: JSON.stringify({ title: cleanTitle, content: '' }) });
      window.location.assign(`/pages/${page.id}?create-database=1`);
    } catch (error) { notify(`Could not create the database page: ${error.message}`, true); }
  }

  async function saveDatabaseCell(input) {
    const column = currentPage?.database?.columns.find(item => item.id === input.dataset.columnId);
    if (!column) return;
    const value = column.type === 'number' && input.value !== '' ? Number(input.value) : input.value;
    input.disabled = true;
    try {
      await api(`/pages/${currentPage.id}/database/rows/${input.dataset.rowId}`, { method: 'PATCH', body: JSON.stringify({ values: { [column.id]: value } }) });
      input.disabled = false;
      setSaveState('All changes saved');
    } catch (error) {
      input.disabled = false;
      notify(`Could not save this cell: ${error.message}`, true);
    }
  }

  async function addDatabaseRow() {
    if (!currentPage?.database) return;
    try {
      await api(`/pages/${currentPage.id}/database/rows`, { method: 'POST', body: JSON.stringify({ values: {} }) });
      window.location.reload();
    } catch (error) { notify(`Could not add a row: ${error.message}`, true); }
  }

  async function deleteDatabaseRow(rowId) {
    if (!currentPage || !window.confirm('Delete this row? This cannot be undone.')) return;
    try {
      await api(`/pages/${currentPage.id}/database/rows/${rowId}`, { method: 'DELETE' });
      window.location.reload();
    } catch (error) { notify(`Could not delete the row: ${error.message}`, true); }
  }

  function openSchemaDialog(mode, columns, { pageId = currentPage?.id, newPage = false } = {}) {
    schemaMode = mode;
    schemaPageId = pageId;
    schemaForNewPage = newPage;
    document.getElementById('schema-title').textContent = mode === 'edit' ? 'Edit database columns' : 'Set up your database';
    schemaForm.querySelector('[type="submit"]').textContent = mode === 'edit' ? 'Save columns' : 'Create database';
    schemaColumns.innerHTML = '';
    (columns.length ? columns : [{ name: 'Name', type: 'text' }]).forEach(appendSchemaRow);
    databaseDialog.hidden = false;
    schemaColumns.querySelector('.schema-column-name')?.focus();
  }

  function appendSchemaRow(column = {}) {
    const row = document.createElement('div');
    row.className = 'schema-column-row';
    if (column.id) row.dataset.columnId = column.id;
    row.innerHTML = `<input class="schema-column-name" type="text" placeholder="Column name" aria-label="Column name" value="${safeText(column.name || '')}" required><select class="schema-column-type" aria-label="Column type"><option value="text">Text</option><option value="number">Number</option><option value="date">Date</option><option value="select">Select</option></select><input class="column-options" type="text" aria-label="Select options" placeholder="Options, separated by commas" value="${safeText((column.options || []).join(', '))}"><button class="column-remove" type="button" aria-label="Remove column">×</button>`;
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
      await api(`/pages/${schemaPageId}/database`, { method: 'PUT', body: JSON.stringify({ columns }) });
      databaseDialog.hidden = true;
      if (schemaForNewPage) window.location.assign(`/pages/${schemaPageId}`);
      else window.location.reload();
    } catch (error) { notify(`Could not save the database: ${error.message}`, true); }
  }

  async function renderSearchResults(query) {
    const term = query.trim();
    if (!term) { searchResults.innerHTML = '<p class="search-hint">Type to search your workspace</p>'; return; }
    searchController?.abort();
    searchController = new AbortController();
    searchResults.innerHTML = '<p class="search-hint">Searching your pages…</p>';
    try {
      const result = await api(`/search?q=${encodeURIComponent(term)}`, { signal: searchController.signal });
      const pageHits = (result.pages || []).map(page => ({ id: page.id, title: page.title, excerpt: page.excerpt, type: 'Page' }));
      const rowHits = (result.database_rows || []).map(row => ({ id: row.page_id, title: row.page_title, excerpt: row.excerpt, type: 'Database row' }));
      const hits = [...pageHits, ...rowHits];
      if (!hits.length) { searchResults.innerHTML = '<p class="search-hint">No pages found. Try another search.</p>'; return; }
      searchResults.innerHTML = hits.map((hit, index) => `<a class="search-result ${index === searchIndex ? 'selected' : ''}" href="/pages/${hit.id}" data-search-page="${hit.id}"><span class="result-icon">${hit.type === 'Page' ? '▧' : '▤'}</span><span><strong>${safeText(hit.title)} <small class="result-kind">· ${hit.type}</small></strong><small>${safeText(hit.excerpt || '')}</small></span></a>`).join('');
      searchResults.querySelectorAll('[data-search-page]').forEach(item => item.addEventListener('click', () => hideSearch()));
    } catch (error) {
      if (error.name !== 'AbortError') searchResults.innerHTML = `<p class="search-hint">Search could not finish: ${safeText(error.message)}</p>`;
    }
  }

  function moveSearchSelection(delta) {
    const matches = searchResults.querySelectorAll('[data-search-page]');
    if (!matches.length) return;
    searchIndex = searchIndex < 0 ? (delta < 0 ? matches.length - 1 : 0) : (searchIndex + delta + matches.length) % matches.length;
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
    } catch (error) { notify(`Export failed: ${error.message}`, true); }
  }

  async function copyPageLink() {
    if (!currentPage) return notify('Open a page to copy its local link.');
    try { await navigator.clipboard.writeText(`${location.origin}/pages/${currentPage.id}`); notify('Local page link copied.'); }
    catch { notify('Clipboard access is unavailable in this browser.', true); }
  }

  async function deleteCurrentPage() {
    if (!currentPage || !window.confirm(`Delete “${currentPage.title}” and its database? This cannot be undone.`)) return;
    try {
      await api(`/pages/${currentPage.id}`, { method: 'DELETE' });
      window.location.assign('/');
    } catch (error) { notify(`Could not delete the page: ${error.message}`, true); }
  }

  async function runAction(action, source) {
    if (action === 'new-page') return createPage();
    if (action === 'new-database') {
      if (!currentPage) return createDatabasePage();
      return openSchemaDialog('create', [], { pageId: currentPage.id });
    }
    if (action === 'settings') return window.location.assign('/settings');
    if (action === 'search') return showSearch();
    if (action === 'close-search') return hideSearch();
    if (action === 'close-database-dialog') { databaseDialog.hidden = true; return; }
    if (action === 'add-column') return appendSchemaRow();
    if (action === 'edit-schema') return openSchemaDialog('edit', currentPage?.database?.columns || []);
    if (action === 'add-row') return addDatabaseRow();
    if (action === 'delete-row') return deleteDatabaseRow(source.dataset.rowId);
    if (action === 'export') return exportPages();
    if (action === 'share') return copyPageLink();
    if (action === 'page-menu') return deleteCurrentPage();
    if (action === 'open-sidebar') { document.querySelector('.sidebar')?.classList.add('open'); return; }
    if (action === 'close-sidebar') { document.querySelector('.sidebar')?.classList.remove('open'); return; }
    if (action === 'edit') return startEditing();
    if (action === 'cancel-edit') { window.location.reload(); return; }
    if (action === 'save-edit') {
      try { await saveDraft(); } catch (error) { notify(`Could not save this page: ${error.message}`, true); }
    }
  }

  function hydrateServerPage() {
    if (currentPage) {
      const article = content.querySelector('#page-content');
      decorateWikiLinks(article, currentPage);
      content.querySelectorAll('.database-table input, .database-table select').forEach(input => input.addEventListener('change', () => saveDatabaseCell(input)));
    }
    if (currentPage && new URLSearchParams(location.search).has('create-database') && !currentPage.database) {
      history.replaceState(null, '', location.pathname);
      openSchemaDialog('create', [], { pageId: currentPage.id, newPage: true });
    }
    // Keep the server-rendered page markup intact; interactions enhance this initial view in place.
  }

  content.addEventListener('click', event => {
    const action = event.target.closest('[data-action]');
    if (action) runAction(action.dataset.action, action);
  });
  content.addEventListener('input', event => {
    if (!editing || !draft || !event.target.matches('#page-title-input, #markdown-editor')) return;
    draft.title = content.querySelector('#page-title-input')?.value ?? draft.title;
    draft.content = content.querySelector('#markdown-editor')?.value ?? draft.content;
    dirty = true;
    setSaveState('Unsaved changes', true);
    window.clearTimeout(previewTimer);
    previewTimer = window.setTimeout(() => renderPreview(draft.content, content.querySelector('#markdown-preview'), currentPage), 180);
  });
  databaseDialog.addEventListener('click', event => {
    const action = event.target.closest('[data-action]');
    if (action) runAction(action.dataset.action, action);
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
    if (event.key === 'Enter') searchResults.querySelector('.search-result.selected')?.click() || searchResults.querySelector('[data-search-page]')?.click();
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
  window.addEventListener('beforeunload', event => {
    if (editing && dirty) { event.preventDefault(); event.returnValue = ''; }
  });

  hydrateServerPage();
})();
