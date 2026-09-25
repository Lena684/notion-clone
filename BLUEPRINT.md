# Local Notes and Databases App — Blueprint

## Goal

Build a personal, local-first notes and databases app that can replace the
author's Notion workflow. Notes must remain ordinary Markdown files that can be
exported independently of the app. This document is the product and technical
blueprint for future implementation agents.

## Product requirements

### Pages and Markdown

- Pages are Markdown documents stored in SQLite.
- Provide a plain textarea for editing and a live preview pane rendered with
  `marked`.
- Markdown is the content format; do not model page content as editor blocks.
- Support `[[Wiki-style]]` links between pages.
- Render a backlinks section at the bottom of each page, listing pages that
  link to it.

### Simple databases

- A page can define a simple table/database.
- Supported column types are text, number, date, and select.
- Rows are editable inline.
- Store row data as JSON in SQLite.
- Keep the feature intentionally simple; this is not a general-purpose
  spreadsheet or relational database builder.

### Search

- Add a search box to the page header.
- Search page content and database content with SQLite FTS5.
- Keep the search index in sync with edits and database changes.

### Export and data ownership

- Export all pages to plain `.md` files in a user-visible folder on a nightly
  schedule.
- Preserve wiki links as Markdown text in exports.
- Document how to run an export on demand as well as how the nightly export is
  scheduled.
- Document exactly where the SQLite database and exported files live on disk.

### Privacy and network boundary

- Run as a local web app and bind only to `localhost` / loopback.
- No accounts, telemetry, external services, or remote data storage.
- Do not add authentication or hosting/deployment configuration; this app is
  for one person on their own machine.

## Technical constraints

- Node.js with Express and `better-sqlite3` on the server.
- Server-rendered pages with a small amount of vanilla JavaScript.
- No frontend framework and no frontend build step.
- Use SQLite FTS5 for full-text search.
- Use `marked` to render Markdown previews and page content.

## Out of scope

- Real-time collaboration.
- Cross-device synchronization.
- A block editor.
- User accounts or authentication.
- Hosting configuration or a hosted service.
- Telemetry or analytics.

## Expected deliverables

- A runnable local Node/Express application using SQLite.
- Server-rendered page list, page view/edit, search, wiki links/backlinks, and
  simple inline-editable databases.
- Nightly Markdown export and a way to trigger export manually.
- A `README.md` with setup/run steps, export instructions, and the on-disk
  locations of the database and Markdown exports.

## Acceptance checklist

- [ ] The app starts locally and listens on loopback only.
- [ ] A user can create, view, and edit Markdown pages in a textarea with a live
  preview.
- [ ] Wiki links navigate between pages, and each page shows its backlinks.
- [ ] A page can contain a database with text, number, date, and select
  columns; rows can be edited inline and persist after restart.
- [ ] Search finds relevant page and database content through FTS5.
- [ ] Pages can be exported to plain `.md` files manually and by the nightly
  schedule.
- [ ] The README explains setup and where all user data is stored.
- [ ] No account, telemetry, external service, sync, hosting, or collaboration
  feature has been introduced.

