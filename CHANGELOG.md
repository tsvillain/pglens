# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Improved query history & saved queries** (roadmap §5.5). Query
  history is now persisted per connection: the Advanced editor records
  every run (raw SQL, duration, row count, success/error) to
  `~/.pglens/query-history.json` via `GET/POST/DELETE /api/query-history`,
  with a per-connection 200-entry ring buffer. A **History** menu in the
  editor toolbar lists recent runs most-recent-first; click to reload the
  SQL, delete an entry, or clear all. **Saved queries** are a
  per-connection library of raw SQL with folder + tag organization and
  optional description, persisted to `~/.pglens/saved-queries.json` via
  `GET/POST/PUT/DELETE /api/saved-queries` (unique name per connection,
  atomic writes). A **Saved** menu groups queries by folder with
  name/folder/tag filtering, plus save / edit / delete and JSON
  export/import (`POST /api/saved-queries/import`, auto-suffixing name
  collisions). Saved queries support Postman-style `{{variable}}`
  placeholders — a distinct template layer from the editor's `:name`
  bound parameters (§5.2): `{{variables}}` are filled from saved defaults
  and substituted into the SQL on load (the user reviews/edits before
  running), while `:name` stays a server-side `$n` bind.

## [3.1.0] - 2026-05-29

Phase 1 — No-Code Editing Core. pglens moves from "viewer" to "client":
filter, sort, save views, edit, insert, follow foreign keys, aggregate,
and export/import — all without typing SQL. Every action has a working
"Show SQL" disclosure, and no-code UI never sends raw SQL fragments over
the wire; the server parses structured specs into parameterized queries.

### Added

- **Visual filter builder** above every table grid: column + type-aware
  operator (`=`, `!=`, ranges, `LIKE`/`ILIKE`, `IN`, `IS NULL`, jsonb
  `@>`, array `&&`) + value, with a "Show SQL" disclosure of the
  generated `WHERE`. `GET /api/tables/:tableName` accepts a structured
  filter spec parsed server-side into parameterized SQL. Cursor
  pagination falls back to `OFFSET` when a filter is present.
- **Visual multi-column sort builder**: drag-to-reorder `SortBar` chips
  (HTML5 DnD, no new deps) plus shift/cmd/ctrl-click multi-sort on
  grid headers with priority badges. `GET /api/tables/:tableName` gains
  a structured `sort` array parsed via `buildOrderBy` (identifiers
  validated against column metadata, direction whitelisted); the primary
  key is appended as a tie-break. Legacy `sortColumn`/`sortDirection`
  retained for the v2 client.
- **Saved views** — named bundles of filter + sort scoped to a
  `(connection, table)` pair, persisted to `~/.pglens/views.json` with
  atomic writes and a unique-name guard. `GET/POST/PUT/DELETE
  /api/views`; listing stays open so the sidebar works with no live
  pool. `ViewBar` with picker, dirty indicator, save / save-as /
  rename / delete; the selected view is URL state (`?view=<uuid>`) for
  deep links, and the sidebar nests views under each table with a count
  badge.
- **Type-aware inline editing**: double-click a cell to edit with a
  per-type widget (boolean toggle, date/datetime picker, JSON/array
  dialog with validation, UUID text + generate, bigint-safe number,
  text). `PATCH /api/tables/:tableName/rows` takes `{ where, set }` and
  emits a parameterized `UPDATE` pinned to the primary key (jsonb
  stringified + cast). Optimistic update with rollback on error,
  per-cell spinner, and auto-dismissing error pill. PK columns are not
  editable.
- **Schema-generated row insert form** via `POST
  /api/tables/:tableName/rows` and a parameterized `INSERT` builder
  (`src/db/insert.js`). Each field is tri-state — DEFAULT (omit) / NULL
  / value; an empty payload emits `DEFAULT VALUES`. NOT-NULL-without-
  default columns are required; defaults are ghosted. NOT NULL / CHECK /
  unique violations surface through the standard error envelope.
  Includes "Show SQL" and "Insert & add another".
- **FK click-through navigation**: click any foreign-key cell to slide
  in a side panel with the full referenced row (fetched through the
  existing filtered read endpoint — no backend change). Supports chained
  FK navigation with breadcrumbs, "Show all rows in `<table>` where
  `<col>` = `<val>`" (jumps to the origin table with the equality filter
  pre-applied), and "Edit referenced row" inline. URL-carried FK values
  are type-coerced against column metadata.
- **Per-column aggregations strip** pinned to the bottom of every grid:
  count / sum / avg / min / max / stddev / count distinct /
  count true|false, type-gated and computed server-side against the
  active filter via `GET /api/tables/:tableName/aggregate`
  (`src/db/aggregate.js`, reuses `buildWhere`). Sticky `tfoot` fn picker
  with a Show SQL preview.
- **Per-table data export** to CSV (RFC 4180), JSON, or SQL `INSERT`
  via `GET /api/tables/:tableName/export`, respecting the current
  filter, sort, and a chosen column subset. Rows stream through a
  server-side cursor with drain-aware backpressure, so memory stays flat
  regardless of table size. `ExportMenu` dialog with format toggle,
  per-column picker, and Show SQL.
- **Per-table CSV import wizard**: upload, map CSV columns → table
  columns (auto-guessed by header), choose insert mode (`INSERT`,
  `ON CONFLICT DO NOTHING`, `ON CONFLICT … DO UPDATE`), dry-run preview
  of rows/conflicts, execute in a transaction.

### Changed

- **Neutral off-black dark mode**: replaced the bluish-slate palette
  with neutral grays (background ~`#161616`, surfaces lift to `#1c1c1c`,
  de-tinted borders).
- **Column metadata** returned by the table read now carries `udtName`,
  `isNullable`, `hasDefault`, and the raw default expression, so the
  frontend can pick the right edit/insert widget and ghost defaults.
- **Global DB dump** (`/api/export`) now reuses the shared `sqlLiteral()`
  serializer from `src/db/export.js` instead of a hand-coded copy,
  removing the risk of drift between the global-backup and per-table
  export paths. Output unchanged.

### Fixed

- **Connection store** now syncs the resolved connection id back after
  resolution, fixing stale-id state.

### Known limitations

- FK and enum columns in the inline editor and insert form degrade to a
  text input (with a `→ table.column` hint) until the FK lookup pipeline
  lands.

## [3.0.2] - 2026-05-22

### Fixed

- **`pglens doctor` no longer tells curl users to delete their working install.**
  Doctor had the install model backwards: it treated the curl install under
  `~/.pglens` as a "pre-3.0 leftover to remove" and, because the curl launcher is
  a wrapper script (not a symlink), failed to recognize the running copy as its
  own — so a single healthy install was reported as a stale duplicate. Following
  the cleanup recreated the same install, producing an endless "stale → delete →
  reinstall → stale" loop. The model is now inverted to match how pglens actually
  ships: **the curl install under `~/.pglens` is canonical**, and a
  `npm install -g pglens` copy is the foreign one doctor flags and removes. New
  problem codes: `npm-install`, `shadowed`, `not-on-path`, `no-install`,
  `pre3-leftover` (the genuine `~/.pglens/source` pre-3.0 layout). Data files are
  still never touched.
- **Update notice** now points to the curl installer
  (`curl -fsSL https://pglens.org/install.sh | bash`) instead of
  `npm i -g pglens@latest`, which would have created exactly the npm copy doctor
  flags.
- **Post-install notice** is suppressed during a curl install (the installer sets
  `PGLENS_NO_POSTINSTALL=1` around its `npm install`), so it no longer warns that
  the install "isn't on PATH" before the launcher and `PATH` line are written.

### Changed

- **README** demotes `npm install -g pglens` to "not recommended"; the curl
  script is documented as the supported, canonical install.

## [3.0.1] - 2026-05-22

### Added

- **`pglens doctor`** command: diagnoses install problems — multiple `pglens`
  binaries on `PATH`, a leftover pre-3.0 self-install under `~/.pglens`, and
  orphaned `PATH` entries — and prints exact, data-safe cleanup commands.
- **Post-install notice**: when `npm install` lands behind a shadowing copy,
  a short warning points to `pglens doctor`. Never fails the install; opt out
  with `PGLENS_NO_POSTINSTALL=1` (also skipped in CI).

### Fixed

- **Install scripts** (`install/install.sh`, `install/install.ps1`, deployed to
  pglens.org) now **prepend** `~/.pglens/bin` to `PATH` so the curl-managed copy
  wins over any stray binary; warn if another `pglens` is already on `PATH`;
  install `pglens@latest` so re-running upgrades cleanly; and print correct
  "open a new terminal / `hash -r`" guidance. Also fixed a UTF-8 mojibake (`â`)
  in the success output.

## [3.0.0] - 2026-05-21

Foundation rewrite. The 5K-line vanilla `app.js` is gone, replaced by a
Vite + React 18 + TypeScript (strict) app served at `/` with shadcn/ui +
Tailwind, TanStack Query/Router/Table/Virtual, Zustand, `@xyflow/react`,
Monaco, and Zod. The legacy `/v3/*` prefix used during the strangler-fig
migration 301-redirects to `/` so existing bookmarks keep working.

### Added

- **New React/TS frontend** at `/`: landing connections grid, sidebar
  (connections, schemas, tables search), table viewer (TanStack Table +
  `@tanstack/react-virtual`, page/sort), schema visualizer
  (`@xyflow/react` with `@dagrejs/dagre` hierarchical auto-layout),
  connection dialog (URL + params modes), query runner (lazy-loaded
  Monaco editor, `Cmd/Ctrl+Enter` to run).
- **Per-install auth token** at `~/.pglens/token` (mode 0600). All
  routes except `/api/v3/health` require the token via cookie,
  `x-pglens-token` header, or one-shot `?token=` query param that gets
  swapped for an `HttpOnly` cookie and then stripped via 302.
- **OS keychain secrets** via `keytar` (macOS Keychain / Windows
  Credential Vault / libsecret). Existing `~/.pglens/connections.json`
  records are migrated transparently on first boot; the file becomes
  metadata-only.
- **Structured logging** with `pino` writing daily-rotating JSON lines
  to `~/.pglens/logs/pglens.log.N`.
- **CLI commands**: `pglens logs [-f] [-n N]`, `pglens token`, and the
  existing `pglens url` now embeds the token.
- **Standard error envelope** on every API response:
  `{ error: { code, message, hint? }, errorMessage }`.
- **Zod request validation** on every API route (body / query / params).
- **POST `/api/query`** — advanced-mode raw-SQL escape hatch with
  per-statement `SET search_path` scoped to the active schema.
- **Multi-tab workspace** with a tab bar that mirrors URL navigation;
  open tables, the schema visualizer, and the query runner side-by-side.
- **Spotlight (`Cmd/Ctrl+K`)** for fuzzy table search.
- **Theme switcher** (light / dark / system) persisted to `localStorage`;
  follows OS preference changes when set to system.
- **Asimovian** logo font for the `pglens` wordmark in the sidebar and
  landing page.
- **Schema visualizer upgrades**: dagre hierarchical auto-layout, LR/TB
  direction toggle, hover spotlight (dim non-neighbors, animate
  connected edges), smoothstep edges with arrow markers, filter input
  (tables + columns), node drag, redesigned theme-aware MiniMap with
  hover-synced highlight, `Fit` button.
- **Schema export menu**: SVG (vector), Copy Mermaid ER (with "Copied!"
  feedback), Download `.mmd` file.
- **Streaming backup export** with a bottom-right progress toast
  showing bytes written, current table being dumped, and a cancel
  button.
- **Themed scrollbars** in both light and dark mode (`color-scheme` for
  Firefox + WebKit pseudo-elements).
- **Page-transition loading cues** in the table viewer: top progress
  bar, inline `updating…` spinner, and dimmed grid during refetch.
- **JSON/JSONB cell viewer**: collapsible, syntax-highlighted JSON tree
  in the cell content popup.
- **Unicode spinner** on every loading state with context-specific
  progress text (e.g. which table is loading, what step is running).
- **Quality gates**: 33 backend unit tests via `node:test`, 11 frontend
  unit tests via Vitest + jsdom, env-gated integration tests against
  `postgres:16-alpine` (`docker-compose.test.yml`), Playwright E2E
  spec. GitHub Actions CI matrix on Node 18/20/22 ×
  ubuntu/macOS/Windows for unit tests, with Linux jobs for integration
  - E2E.

### Changed

- **Frontend is now React/TS**, served at `/`. Vite `base: '/'`,
  TanStack Router at root. The legacy `/v3/*` path 301-redirects to `/`
  so old bookmarks keep working.
- **Server binds `127.0.0.1`** by default (override with
  `PGLENS_BIND`), preventing accidental LAN exposure.
- **Identifier escaping**: replaced the `^[a-zA-Z0-9_]+$` regex
  allowlist with a proper Postgres double-quote escaper. Mixed-case,
  Unicode, and quoted identifiers now work everywhere.
- `GET /api/connections` returns a **masked** `connectionString`
  (`postgresql://user:***@host:port/db`) instead of the raw URL.
  Passwords no longer leave the server.
- Edit connection dialog now **prefills** both URL and Parameters
  modes. Submitting the masked URL or leaving the password field blank
  preserves the existing keychain entry (`***` sentinel handled
  server-side).
- Schema dropdown in the sidebar **persists changes** via
  `PATCH /api/connections/:id/schema` and invalidates the dependent
  table + schema queries on switch.
- Switching tables no longer briefly renders the previous table's rows
  (placeholder data is now scoped to the same `tableName`).
- `Select` primitive: native chevron suppressed, replaced with a Lucide
  icon properly centered against the input's full height.
- **Faster table loads**: table metadata (columns, primary key) is now
  cached, and the row-count and data queries run in parallel instead of
  sequentially.

### Removed

- **Legacy vanilla `client/`** (5K-line `app.js` + `styles.css` +
  `index.html`). The directory has been deleted; the new React/TS
  client is now the only frontend.

### Security

- Per-install token gates every route except `/api/v3/health`.
- Server binds `127.0.0.1` by default.
- Connection passwords moved out of plaintext `~/.pglens.*` into the
  OS keychain.
- Token file and connections.json written with mode 0600.
- Constant-time token comparison via `crypto.timingSafeEqual`.

## [2.3.0] - 2026-04-01

### Added

- **Schema Selection**: Browse any schema in your database, not just `public`. Schema is selectable when editing a connection and persisted per connection.
- **Views Support**: Views are now listed alongside tables in the sidebar, dashboard, and spotlight search, distinguished with an eye icon and "view" label.
- **Schema API**: New `GET /api/schemas` endpoint to list available schemas for a connection.
- **Schema Visualization**: Interactive network graph to visualize table relationships within a schema.
- **Import/Export**: Export your database schema and import it into another connection.

### Changed

- Dashboard header now shows both table and view counts (e.g. "12 tables, 3 views").
- All SQL queries use the connection's schema instead of hardcoded `public`.
- Connection cards show schema name when non-public.
- Increased server start and port acquisition timeouts for more reliable startup.

## [2.2.0] - 2026-02-02

### Added

- **Row Numbers**: Table rows now display row numbers for easier navigation and reference.
- **Table Schema Viewer**: View table structure and column definitions directly from the UI.
- **Spotlight Search**: Quick table search with `Cmd+K` / `Ctrl+K` keyboard shortcut for fast navigation.
- **Connection Persistence**: Desktop app now saves connections and restores them on restart.
- **Auto-Updates**: Desktop app automatically checks for updates and notifies when new versions are available.

### Changed

- Cleaner codebase with reduced unnecessary comments.

## [2.1.0] - 2026-01-11

### Added

- **Default Landing Page**: The app now defaults to an "All Connections" grid view on startup.
- **Simplified Sidebar**: Connection management (Edit/Delete) is now centralized on the Landing Page.
- **Smart View Switching**: Table list and search are hidden until a server is explicitly selected.

### Changed

- **Navigation Flow**: "Add Connection" and Logo clicks efficiently return you to the Landing Page.
- **Auto-Connect Disabled**: Adding a new connection returns to the grid instead of auto-opening the server.

### Fixed

- **View Persistence**: Reconnecting to an active server no longer overwrites open tabs with a loading screen.
- **Connection Updates**: Fixed issue where the connection grid would not update immediately after adding a server.

## [2.0.0] - 2026-01-01

### Added

- **Server-Side Sorting**: Table sorting is now performed on the database server, ensuring correct ordering across all data pages.
- **Connection Parameters Mode**: New tabbed interface in connection dialog allowing separate input for Host, Port, User, Password, and Database.
- **Global Loading Overlay**: Blocks user interaction during data fetching to prevent race conditions.
- **Dynamic Port Selection**: Server automatically finds an available port if 54321 is busy.
- **`pglens url` Command**: CLI command to display the currently running server URL.
- **Database Query Timeout**: Enforced 30-second timeout on all database operations.

### Changed

- Connection dialog now defaults to "Parameters" input mode for better usability.
- Switched to offset-based pagination when a custom sort order is active.
- Improved connection error handling and validation.

## [1.1.0] - 2025-11-21

### Added

- Cell content popup dialog for viewing full cell values (double-click any table cell)
- JSON formatting support for JSONB and JSON values in cell content popup with proper indentation
- Timezone selector for date/time values with multi-timezone display
- Select All button in column selector for quick column visibility management
- Copy-to-clipboard functionality in cell content popup

### Fixed

- JSONB columns now display as readable JSON instead of showing as object

### Changed

- Table cells now truncate with ellipsis for better table readability
- Improved cell content viewing experience with dedicated popup dialog

## [1.0.0] - Initial Release

### Added

- PostgreSQL database viewer with web interface
- Table browser with searchable sidebar
- Multi-tab support for viewing multiple tables simultaneously
- Data viewer with pagination (100 rows per page)
- Client-side column sorting
- Column visibility toggle
- Column resizing functionality
- Theme support (light, dark, system)
- Cursor-based pagination for efficient large table navigation
- Automatic primary key detection for optimized pagination
- Refresh data functionality
- PM2 deployment support documentation
- SSL mode configuration via `--sslmode` flag with support for: `disable`, `require`, `prefer`, `verify-ca`, `verify-full`
- Automatic SSL mode recommendations when connection fails
- Enhanced error messages with context-aware suggestions

### Security

- SQL injection prevention via table name sanitization
- Input validation for pagination parameters

[Unreleased]: https://github.com/tsvillain/pglens/compare/v3.0.0...HEAD
[3.0.0]: https://github.com/tsvillain/pglens/compare/v2.3.0...v3.0.0
[2.3.0]: https://github.com/tsvillain/pglens/compare/v2.2.0...v2.3.0
[2.2.0]: https://github.com/tsvillain/pglens/compare/v2.1.0...v2.2.0
[2.1.0]: https://github.com/tsvillain/pglens/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/tsvillain/pglens/compare/v1.1.0...v2.0.0
[1.1.0]: https://github.com/tsvillain/pglens/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/tsvillain/pglens/releases/tag/v1.0.0
