/**
 * Postgres extensions panel (roadmap §7.4).
 *
 * Lists every extension the server makes available (pg_available_extensions),
 * with the installed version (null when not installed) and the default version
 * on offer. Install is a one-click CREATE EXTENSION IF NOT EXISTS, mirroring the
 * pg_stat_statements enable flow in ./slowQueries — the same privilege error
 * surfaces with a readable hint when the role can't create extensions.
 */

const { quoteIdent } = require('./identifier');

// Curated highlights from the roadmap, surfaced first so the common ones aren't
// buried in the alphabetical long tail. pgvector ships as the `vector` extension.
const POPULAR = new Set([
  'pg_trgm', 'vector', 'postgis', 'pg_stat_statements',
  'pgcrypto', 'uuid-ossp', 'citext', 'hstore',
]);

async function listExtensions(pool) {
  const { rows } = await pool.query(
    `SELECT name, default_version, installed_version, comment
       FROM pg_available_extensions
      ORDER BY name`,
    [],
  );
  // current_setting('is_superuser') is 'on'/'off'; lets the UI warn up front
  // rather than only after a failed install. Trusted extensions (PG13+) can
  // still be installed by non-superusers, so this is advisory, not a gate.
  const { rows: priv } = await pool.query(
    `SELECT current_setting('is_superuser') AS superuser`, []);
  return {
    superuser: priv[0]?.superuser === 'on',
    extensions: rows.map((r) => ({
      name: r.name,
      installedVersion: r.installed_version,   // null when not installed
      defaultVersion: r.default_version,
      comment: r.comment,
      installed: r.installed_version != null,
      popular: POPULAR.has(r.name),
    })),
  };
}

async function installExtension(pool, name) {
  // Only install names the server actually offers — a clean 400 beats a raw PG
  // error, and it bounds what quoteIdent ever sees.
  const { rows } = await pool.query(
    `SELECT 1 FROM pg_available_extensions WHERE name = $1`, [name]);
  if (rows.length === 0) {
    const err = new Error(`Extension "${name}" is not available on this server`);
    err.code = 'NOT_AVAILABLE';
    throw err;
  }
  await pool.query(`CREATE EXTENSION IF NOT EXISTS ${quoteIdent(name)}`, []);
  const { rows: after } = await pool.query(
    `SELECT installed_version FROM pg_available_extensions WHERE name = $1`, [name]);
  const installedVersion = after[0]?.installed_version ?? null;
  return { installed: installedVersion != null, installedVersion };
}

async function dropExtension(pool, name) {
  const { rows } = await pool.query(
    `SELECT 1 FROM pg_available_extensions WHERE name = $1`, [name]);
  if (rows.length === 0) {
    const err = new Error(`Extension "${name}" is not available on this server`);
    err.code = 'NOT_AVAILABLE';
    throw err;
  }
  // RESTRICT (the default, left implicit) — never CASCADE. If objects depend on
  // the extension the drop fails loudly rather than silently deleting them; the
  // route surfaces that error so the user decides what to remove first.
  await pool.query(`DROP EXTENSION IF EXISTS ${quoteIdent(name)}`, []);
  const { rows: after } = await pool.query(
    `SELECT installed_version FROM pg_available_extensions WHERE name = $1`, [name]);
  const installedVersion = after[0]?.installed_version ?? null;
  return { installed: installedVersion != null, installedVersion };
}

module.exports = { listExtensions, installExtension, dropExtension, POPULAR };
