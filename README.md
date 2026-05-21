# pglens

A no-code PostgreSQL workstation. View, explore, visualize, and query your
PostgreSQL databases through a fast local web interface.

> **v3.0.0** is a foundation rewrite. The interface is now a React 18 + TypeScript
> app, and the server is hardened with per-install auth, OS-keychain secrets, and
> localhost-only binding. See [Breaking Changes](#breaking-changes-in-v300) before
> upgrading.

## Features

- 🔌 **Connection Manager**: Manage multiple database connections from a single UI
- 🔐 **Per-install Auth Token**: Every route is gated by a local token; passwords live in the OS keychain
- 💾 **Connection Persistence**: Saved connections are restored when you reopen the app
- 🚀 **Background Service**: Runs as a daemon process for persistent access
- 🗂️ **Table & View Browser**: View all tables and views in your database in a clean, searchable sidebar
- 🗃️ **Schema Selection**: Browse any schema in your database, not just `public`
- 🕸️ **Schema Visualization**: Interactive auto-laid-out graph (dagre) of table relationships, with filtering, hover spotlight, and minimap
- 📐 **Schema Export**: Export the diagram as SVG or Mermaid ER (copy or `.mmd` download)
- 📥 **Import/Export**: Export your database schema as SQL and import it into another connection
- 💽 **Streaming Backup**: Export a database dump with live byte/table progress and cancel
- ⌨️ **Query Runner**: Advanced-mode raw-SQL escape hatch with a Monaco editor (`Cmd/Ctrl+Enter` to run)
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

### Alternative: Install via npm

If you already have Node.js installed, you can use npm:

```bash
npm install -g pglens
```

Or install locally in your project:

```bash
npm install pglens
```

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
- **A shadowing copy on PATH.** If you installed once with the curl script and again
  with `npm`, two `pglens` binaries exist (e.g. `~/.pglens/bin` and your npm prefix).
  Whichever comes first on `PATH` wins. `pglens doctor` lists every copy it finds and
  prints removal commands. Your data (`~/.pglens/connections.json`, `token`, `logs/`)
  is never touched.

> **Pick one install method.** Mixing the curl installer and `npm -g` is the usual
> cause of shadowed binaries. If you use `npm`, remove the `~/.pglens/bin` copy and the
> matching `PATH` line in your shell rc (`pglens doctor` shows you where).

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
