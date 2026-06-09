# pglens

A no-code PostgreSQL workstation. View, explore, visualize, edit, and query your
PostgreSQL databases through a fast local web interface.

> **v3.2.0** adds Advanced Mode for engineers who want SQL. A per-tab
> `[ No-code | Advanced ]` toggle swaps any grid for a schema-aware Monaco
> editor seeded with the query no-code was about to run. It brings transaction
> mode (implicit `BEGIN`, per-tab `Commit`/`Rollback`, idle auto-rollback),
> multi-statement result tabs with `EXPLAIN ANALYZE` timing, and per-connection
> query history plus a saved-query library with `{{variables}}`, folders, and
> tags. Execution stays server-side parameterized — `:name` placeholders are
> rewritten to positional `$n` binds.
>
> **v3.1.0** turned pglens from a viewer into a client: filter, sort, save views,
> inline-edit, insert rows, follow foreign keys, aggregate, and export/import — all
> without typing SQL. Every no-code action has a "Show SQL" disclosure, and the UI
> never sends raw SQL fragments; the server parses structured specs into
> parameterized queries.
>
> **v3.0.0** was the foundation rewrite. The interface is a React 18 + TypeScript
> app, and the server is hardened with per-install auth, OS-keychain secrets, and
> localhost-only binding. See [Breaking Changes](#breaking-changes-in-v300) before
> upgrading from v2.x.

## Features

- 🔌 **Connection Manager**: Manage multiple database connections from a single UI
- 🔐 **Per-install Auth Token**: Every route is gated by a local token; passwords live in the OS keychain
- 💾 **Connection Persistence**: Saved connections are restored when you reopen the app
- 🚀 **Background Service**: Runs as a daemon process for persistent access
- 🗂️ **Table & View Browser**: View all tables and views in your database in a clean, searchable sidebar
- 🗃️ **Schema Selection**: Browse any schema in your database, not just `public`
- 🕸️ **Schema Visualization**: Interactive auto-laid-out graph (dagre) of table relationships, with filtering, hover spotlight, and minimap
- 📐 **Schema Export**: Export the diagram as SVG or Mermaid ER (copy or `.mmd` download)
- 🔎 **Visual Filter Builder**: Type-aware operators (`=`, ranges, `LIKE`/`ILIKE`, `IN`, `IS NULL`, jsonb `@>`, array `&&`) above every grid, with Show SQL
- ↕️ **Visual Multi-Column Sort**: Drag-to-reorder sort chips plus shift/cmd-click header multi-sort with priority badges
- 💾 **Saved Views**: Named filter + sort bundles per `(connection, table)`, deep-linkable via URL, nested under each table in the sidebar
- ✏️ **Inline Editing**: Double-click a cell to edit with a per-type widget (boolean, date/datetime, JSON/array, UUID, bigint-safe number); optimistic update with rollback
- ➕ **Row Insert Form**: Schema-generated form with tri-state DEFAULT / NULL / value fields and "Insert & add another"
- 🔗 **FK Click-Through**: Click a foreign-key cell to slide in the referenced row, follow chained FKs with breadcrumbs, or jump to all matching rows
- 🧮 **Per-Column Aggregations**: count / sum / avg / min / max / stddev / count distinct, type-gated and computed server-side against the active filter
- 📤 **Per-Table Export**: Stream CSV (RFC 4180) / JSON / SQL `INSERT`, respecting the active filter, sort, and chosen columns
- 📥 **CSV Import Wizard**: Map columns, choose insert mode (`INSERT`, `ON CONFLICT DO NOTHING`/`DO UPDATE`), dry-run preview, transactional execute
- 📦 **Import/Export Schema**: Export your database schema as SQL and import it into another connection
- 💽 **Streaming Backup**: Export a database dump with live byte/table progress and cancel
- 🔀 **Advanced Mode Toggle**: Per-tab `[ No-code | Advanced ]` switch that swaps the grid for a Monaco SQL editor seeded with the query no-code was about to run; mode and edits are preserved per tab
- ⌨️ **SQL Editor**: Schema-aware autocomplete (tables/columns scoped to `FROM`/`JOIN`), `:name` parameters rewritten to positional `$n` binds, and format-on-save via `sql-formatter` (`Cmd/Ctrl+Enter` to run)
- 🔁 **Transaction Mode**: `[ Auto-commit | Transaction ]` toggle holding a dedicated backend per tab — implicit `BEGIN`, `Commit`/`Rollback` buttons, "T" badge, close-confirmation, and idle auto-rollback
- 🧾 **Multi-Statement Results**: Result tabs for multi-statement scripts over the shared DataGrid, with `EXPLAIN ANALYZE` planning/execution timing and CSV/JSON export
- 🕘 **Query History & Saved Queries**: Per-connection run history plus a saved-query library with `{{variables}}`, folders, tags, and JSON export/import
- 🔎 **Spotlight Search**: Quick table search with `Cmd+K` / `Ctrl+K` for fast navigation
- 📊 **Data Viewer**: Browse table rows in a virtualized grid with page/sort
- 🔢 **Row Numbers**: Row numbers displayed for easier navigation and reference
- 📋 **Table Schema**: View table structure and column definitions directly from the UI
- 📝 **Cell Content Viewer**: Double-click any cell to view full content in a popup
- 🎨 **JSON/JSONB Viewer**: Collapsible, syntax-highlighted JSON tree
- 🕒 **Timezone Support**: View timestamps in local, UTC, or other timezones
- 📋 **Clipboard Support**: One-click copy for cell contents
- 🪟 **Multiple Tabs**: Open tables, the visualizer, and the query runner side-by-side in separate tabs
- 🔄 **Server-Side Sorting**: Click column headers to sort data directly on the database server
- 📄 **Pagination**: Navigate through large tables with Previous/Next buttons
- 👁️ **Column Visibility**: Show or hide columns to focus on what matters
- 🎨 **Theme Support**: Choose between light, dark, or system theme
- ⚡ **Optimized Performance**: Cached table metadata + parallelized count/data queries
- 🔒 **SSL Support**: Configurable SSL modes (Disable, Require, Prefer, Verify CA/Full)
- 📜 **Structured Logs**: `pino` JSON logs viewable with `pglens logs`
- **Easy Setup**: Install globally and run with a single command

## Installation

The easiest way to install pglens globally is using our installation scripts:

**macOS and Linux:**

```bash
curl -fsSL https://pglens.org/install.sh | bash
```

**Windows (PowerShell):**

```powershell
iwr https://pglens.org/install.ps1 -useb | iex
```

The installer is self-contained (it bundles Node if you don't have it), keeps pglens
under `~/.pglens`, and a re-run upgrades in place. **This is the supported install.**

> **Note on npm.** `npm install -g pglens` works but is **not recommended** — it installs
> outside `~/.pglens` and ends up shadowing the curl copy, which is the usual cause of
> "I upgraded but still see the old version". `pglens doctor` flags an npm install and
> prints the commands to remove it. Stick to the curl script above.

## Usage

### Start the Server

Start pglens as a background service:

```bash
pglens start
```

This will start the server on `http://127.0.0.1:54321` (or the next available port if 54321 is busy).
The URL — including your per-install auth token — is printed to the console. You can
reprint it at any time with:

```bash
pglens url      # full URL with token
pglens token    # token only
pglens logs -f  # tail structured logs
pglens doctor   # diagnose install problems (shadowed/stale binaries)
```

> **Auth:** Opening the printed URL stores an `HttpOnly` cookie, so subsequent visits
> work without the token in the address bar. The server binds `127.0.0.1` by default;
> override with the `PGLENS_BIND` environment variable.

### Connect to a Database

1. Open the URL printed by `pglens start` to see the **All Connections** landing page.
2. Click the **Add Connection** card or the **+** icon in the grid.
3. Enter your connection details using one of the tabs:
   - **Parameters** (Default): Enter Host, Port, Database, User, and Password separately.
   - **Connection URL**: Paste a standard PostgreSQL connection string (e.g., `postgresql://user:pass@localhost:5432/db`).
4. Select the **SSL Mode** appropriate for your server.
5. Click **Connect**. The server will be added to your grid.
6. To change the **Schema**, edit the connection and select from the dropdown (schemas are fetched from the database).
7. Click the server card to open the **Explorer** — tables and views for the selected schema will be listed.

### Stop the Server

To stop the background service:

```bash
pglens stop
```

## Troubleshooting

### `pglens --version` shows an old version after upgrading

Almost always one of two things — run `pglens doctor` and it will tell you which,
with the exact commands to fix it:

- **Stale shell hash.** Your shell cached the path to the old binary. Run `hash -r`
  (bash/zsh) or open a new terminal.
- **A shadowing npm copy on PATH.** If you also ran `npm install -g pglens`, that copy
  lives in your npm prefix and can win on `PATH` over the curl install in `~/.pglens`.
  `pglens doctor` lists every copy it finds and prints removal commands for the npm one.
  Your data (`~/.pglens/connections.json`, `token`, `logs/`) is never touched.

> **The curl install is canonical.** pglens lives under `~/.pglens` and upgrades by
> re-running the install script. If you have an `npm -g` copy, remove it (`pglens doctor`
> or `npm rm -g pglens`) — don't delete `~/.pglens`, that's the supported install.

## How It Works

1. **Start**: Run `pglens start` to launch the background service
2. **Connect**: Add one or more database connections via the Web UI
3. **Explore**:
   - Use the sidebar to browse tables across different connections
   - Double-click cells to view detailed content
   - Use the "Columns" menu to toggle visibility
   - Visualize table relationships using the Schema button; export as SVG or Mermaid
   - Run raw SQL from the query runner when you need the escape hatch
   - Export your database schema and import to another environment
   - Switch themes for comfortable viewing

## Development

To develop or modify pglens:

```bash
# Clone the repository
git clone https://github.com/tsvillain/pglens.git
cd pglens

# Install dependencies
npm install
```

### Run Server Locally

To run the server locally in foreground:

```bash
node bin/pglens serve
```

## Contributing

Contributions are welcome! Please read our [Contributing Guidelines](CONTRIBUTING.md) for details on:

- How to set up your development environment
- Code style and guidelines
- Pull request process
- Issue reporting

## Breaking Changes in v3.0.0

Upgrading from v2.x:

- **Auth token required.** Every route (except `/api/v3/health`) now requires a
  per-install token, stored at `~/.pglens/token`. Use the URL from `pglens url`
  or `pglens start`; the bare `http://localhost:54321` will no longer work without it.
- **Secrets moved to the OS keychain.** Passwords are no longer kept in plaintext
  `~/.pglens.*`. Existing `~/.pglens/connections.json` records are migrated to the
  OS keychain (macOS Keychain / Windows Credential Vault / libsecret) on first boot;
  that file becomes metadata-only. `GET /api/connections` now returns a **masked**
  connection string — passwords no longer leave the server.
- **Localhost-only binding.** The server binds `127.0.0.1` by default instead of all
  interfaces. Set `PGLENS_BIND` to override.
- **Frontend served at `/`.** The legacy vanilla `client/` is gone, replaced by the
  React/TS app. The migration-era `/v3/*` path 301-redirects to `/`, so old bookmarks
  keep working.
- **Standard error envelope.** API errors now return
  `{ error: { code, message, hint? }, errorMessage }`. Update any tooling that parsed
  the old error shape.

## Security Note

This tool is designed for local development use. v3.0.0 gates every route behind a
per-install token, binds `127.0.0.1` by default, keeps connection passwords in the OS
keychain, and writes its token and metadata files with mode `0600`. Even so, the web
interface runs over HTTP. **Do not expose the pglens port (54321) directly to the
internet.**

## License

MIT
