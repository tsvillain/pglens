# pglens

A no-code PostgreSQL workstation. Browse, filter, edit, visualize, and query your
PostgreSQL databases from a fast local web UI. Every no-code action has a
"Show SQL" disclosure, and the UI never sends raw SQL fragments: the server turns
structured specs into parameterized queries. When you want to write SQL yourself,
any tab switches to Advanced mode. New in 3.6: ask in plain English and review
the SQL AI mode writes before you run it.

Website: [pglens.org](https://pglens.org) · Release history: [CHANGELOG.md](CHANGELOG.md)

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
  as SVG or Mermaid ER. The ERD editor lets you add tables, columns and foreign
  keys on the canvas and generates the DDL for review.
- **Schema diff & migrate** — compare two connections and get forward and
  backward migrations, dependency-ordered, with destructive statements flagged.
- **JSONB explorer, extensions panel, charts** — infer the keys inside JSONB
  columns, install or drop extensions, and chart any query result.
- **AI mode (Beta)** — ask a question in plain English and get PostgreSQL
  grounded on your live schema, opened in the editor for review. Bring your own
  key for Anthropic or OpenAI, or run a local Ollama model. See
  [AI mode](#ai-mode-beta).
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

> **npm is a mirror.** Releases are published to GitHub first, and the same tarball
> then goes to npm, so `npm install -g pglens` gets the same code. Prefer the curl
> script anyway: an npm copy lives outside `~/.pglens`, can shadow the curl install
> on `PATH` (the usual cause of "I upgraded but still see the old version"), and
> `pglens update` always installs from GitHub. `pglens doctor` finds an npm copy
> and prints the commands to remove it.

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

### AI mode (Beta)

The **Ask AI** panel on the right turns a question such as "orders from last
week that weren't shipped" into PostgreSQL for the connected database.

1. Open the panel's settings (gear icon) and pick a provider:
   - **Anthropic** or **OpenAI**: paste your API key. It is stored in the OS
     keychain, like connection passwords.
   - **Ollama**: no key. Point it at your Ollama host (default
     `http://127.0.0.1:11434`) to keep everything on your machine. 8b-class
     models write noticeably less accurate SQL; use a larger one if you can.
2. Ask a question and click **Generate SQL**.
3. Read the SQL, then **Open in editor** to edit and run it like any other query.

Before showing you SQL, pglens checks it: it plans the query with `EXPLAIN` and
lets the model fix errors, and it counts the rows a read-only query would
return, so you see "Matches ~N rows right now" or a warning when it matches
nothing. If the model had to guess what you meant, an amber **Assumption** line
says what it assumed. Expand the line under the answer to see which model
answered, how many calls it took, and what was sent.

**What is sent to the provider.** Table and column names and types, keys, enum
labels, and the list of other tables. With **Share sample rows and recent
queries** on (the default), also up to 3 sample rows from up to 3 tables
relevant to the question, common values of low-cardinality text columns, and
your last 5 successful queries on that connection. Values from credential-like
columns (password, hash, token, API key, secret, …) are never sent, and the
**Never send data from** list lets you withhold more: `payments` (a whole
table), `users.email` (one column) or `*.phone` (a column in every table).
Turn sharing off to send the schema only.

**Safety.** Generated SQL is read-only unless you enable writes in the AI
settings. The only model SQL pglens runs without your click is the row count,
which runs as `SELECT count(*)` in a read-only transaction with a 3-second
timeout. Set `PGLENS_AI_DISABLED=1` to hide AI mode entirely.

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

pglens sends no telemetry. Apart from the CLI checking GitHub Releases for a
newer version once a day (npm if GitHub is unreachable; set
`PGLENS_NO_UPDATE_CHECK=1` to turn it off), the only feature that talks to the
internet is AI mode with a cloud provider, and only when you ask a question; see
[AI mode](#ai-mode-beta) for exactly what is sent.

## License

MIT
