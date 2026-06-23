# pglens

A no-code PostgreSQL workstation. View, explore, visualize, edit, and query your
PostgreSQL databases through a fast local web interface — SQL is the escape hatch,
not the entry point. Every no-code action has a "Show SQL" disclosure, and the UI
never sends raw SQL fragments; the server parses structured specs into
parameterized queries.

See [CHANGELOG.md](CHANGELOG.md) for release history.

## Features

- **Browse & explore** — multi-connection manager, searchable table/view sidebar,
  any schema (not just `public`), virtualized data grid, JSON/JSONB tree viewer,
  cell content popup, timezone display, `Cmd/Ctrl+K` spotlight search.
- **No-code data client** — type-aware filter builder, multi-column sort, named
  saved views (deep-linkable), inline cell editing, row insert form, FK
  click-through, per-column aggregations.
- **Import / export** — stream CSV / JSON / SQL `INSERT`, CSV import wizard with
  dry-run, schema export/import, streaming database backup with progress.
- **Schema visualization** — interactive auto-laid-out relationship graph, export
  as SVG or Mermaid ER.
- **Advanced (SQL) mode** — per-tab `[ No-code | Advanced ]` toggle into a
  schema-aware Monaco editor, transaction mode (`BEGIN`/`Commit`/`Rollback`,
  idle auto-rollback), multi-statement result tabs with `EXPLAIN ANALYZE` timing,
  query history, and a saved-query library with `{{variables}}`.
- **Postgres-native ops** — EXPLAIN plan visualizer, index assistant, live
  activity dashboard, slow-query view.
- **Hardened by default** — per-install auth token, OS-keychain secrets,
  `127.0.0.1`-only binding, configurable SSL, structured `pino` logs
  (`pglens logs`).

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

## Contributing

Want to hack on pglens or send a patch? See [CONTRIBUTING.md](CONTRIBUTING.md) for
dev setup, code style, and the PR process.

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
