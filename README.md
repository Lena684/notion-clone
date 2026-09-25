# Local Notes and Databases

A private, local-first notes and databases app with server-rendered HTML views
and a Node.js backend API. The service binds only to `127.0.0.1` and stores
data on this computer.

## Requirements and setup

- Node.js 20 or newer
- npm

From the repository directory:

```sh
npm install
npm start
```

The API is available at `http://127.0.0.1:3000`. Set `PORT` to choose another
local port. The server always binds to the IPv4 loopback address and does not
listen on the network.

Open `http://127.0.0.1:3000/` for the browser workspace. Express renders the
home page and each note/database page from SQLite on the server. The vanilla
JavaScript in `public/` enhances editing, search, and inline database updates
through the local API; it does not build the initial page views. The app
supports Markdown pages with a live preview, wiki links and backlinks, FTS5
search, simple inline-editable databases, and on-demand Markdown export.

For development with automatic restarts, run `npm run dev`.

## API

All request and response bodies use JSON. Errors use `{ "error": "..." }`.

The server-rendered browser routes are `GET /` (home), `GET /pages/:id` (a
page or database), and `GET /settings`. `POST /export` runs an export from the
settings form and redirects back to `/settings`. Static CSS and JavaScript
assets are served from `public/`.

| Method and path | Purpose |
| --- | --- |
| `GET /api/health` | Local service health |
| `GET /api/pages` | List pages |
| `POST /api/pages` | Create `{ "title": "...", "content": "..." }` |
| `GET /api/pages/:id` | Read a page, resolved wiki links, unresolved links, backlinks, and its database |
| `PATCH /api/pages/:id` | Update page `title` and/or Markdown `content` |
| `DELETE /api/pages/:id` | Delete a page and its database |
| `POST /api/markdown/preview` | Render `{ "markdown": "..." }` to sanitized HTML |
| `GET /api/pages/:id/database` | Read a page's database (or `null`) |
| `PUT /api/pages/:id/database` | Create/update `{ "columns": [...] }` |
| `DELETE /api/pages/:id/database` | Delete a page's database and rows |
| `POST /api/pages/:id/database/rows` | Add a row with `{ "values": { "column-id": value } }` |
| `PATCH /api/pages/:pageId/database/rows/:rowId` | Update row values and/or position |
| `DELETE /api/pages/:pageId/database/rows/:rowId` | Delete a row |
| `GET /api/search?q=term` | Search page Markdown and database rows through SQLite FTS5 |
| `POST /api/export` | Export all pages immediately |

Database columns have a stable `id`, `name`, and `type`: `text`, `number`,
`date`, or `select`. Select columns also have an `options` string array. Date
values use `YYYY-MM-DD`; empty cells may be omitted. The server validates row
values against their column definitions. Column ids should be retained when
updating a database schema so existing row values remain attached to the same
columns.

Page content is Markdown. Wiki links use `[[Page title]]`; an optional display
label is accepted as `[[Page title|label]]`. The page API resolves existing
targets case-insensitively and returns backlinks. Search is indexed on page
edits, page title changes, database schema changes, and row edits/deletions.

## Data locations

On Windows, the SQLite database and its journal files live in:

```text
%LOCALAPPDATA%\LocalNotes\notes.sqlite
```

On macOS and Linux the default database is:

```text
~/.local/share/local-notes/notes.sqlite
```

Markdown exports are written to the user-visible folder:

```text
~/Documents/Local Notes Export/
```

On Windows, `~` is the current user's home directory. Each exported file is
named from a title slug plus the page id, and contains a Markdown H1 with the
page title followed by its original Markdown content. Wiki-link text remains
unchanged. A manifest in the export folder tracks files created by the app, so
exports can remove stale files previously managed by the exporter without
deleting unrelated Markdown files in that folder.

Use `NOTES_DATA_DIR` to change the data directory, `NOTES_DATABASE_PATH` to
override the SQLite file path, and `NOTES_EXPORT_DIR` to change the export
folder. Paths can be absolute. These variables are useful for backups and
choosing a different user-visible export location.

## Markdown exports

Run a manual export with:

```sh
curl -X POST http://127.0.0.1:3000/api/export
```

While the app is running, it also exports the pages every night at 02:00 in the
computer's local time. The schedule is in-process: the app must be running for
the nightly export to run. Export failures are written to the local server
console and the next nightly run is still scheduled.

## Privacy and scope

This backend has no accounts, authentication, telemetry, external services,
remote storage, synchronization, or hosting configuration. It only listens on
loopback and writes to the local SQLite database and export directory.
