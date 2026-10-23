#!/usr/bin/env node
/**
 * AI NL→SQL eval harness — a manual confidence report, NOT a CI gate.
 * (`scripts/run-tests.js test/unit` never picks this directory up.)
 *
 * Usage:
 *   docker compose -f docker-compose.test.yml up -d
 *   node test/eval/run.js --provider anthropic [--model claude-…] [--db postgresql://…]
 *
 * Prereqs: the provider's API key already stored via pglens AI settings
 * (BYOK, OS keychain) — Ollama needs a reachable daemon instead.
 *
 * Flow: apply fixture.sql to a throwaway `ai_eval` schema, run every case in
 * cases.js through the real generateSql() pipeline (provider/model pinned via
 * configOverride, ~/.pglens/ai.json untouched), then grade by executing the
 * generated SQL against the golden SQL and comparing RESULT SETS — values
 * only, so aliases don't matter, but extra/missing columns fail by design.
 * Only read-only-gated SQL is ever executed, on the fixture schema, from this
 * CLI — the server-side pipeline still never runs model SQL.
 *
 * Pass rates are snapshots (providers aren't temperature-pinned): the exit
 * code is always 0 for graded runs; only infra failures (unreachable DB) exit 1.
 * Each call also emits the normal `ai.nl2sql` telemetry line, so runs are
 * comparable across PROMPT_VERSIONs in ~/.pglens/logs.
 */

const fs = require('fs');
const path = require('path');
const { parseArgs } = require('node:util');
const postgres = require('postgres');
const { createPoolWrapper } = require('../../src/db/connection');
const { generateSql, PROVIDERS } = require('../../src/ai/assistant');
const cases = require('./cases');

const SCHEMA = 'ai_eval';
const DEFAULT_DB = process.env.PGLENS_TEST_DB_URL
  || 'postgresql://pglens:pglens@localhost:55432/pglens_test';

function cell(v) {
  if (v === null || v === undefined) return '∅';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

// Rows → sorted (unless ordered) serialized value arrays, then compare.
function sameResults(a, b, ordered) {
  const ser = (rows) => rows.map((r) => JSON.stringify(Object.values(r).map(cell)));
  const sa = ser(a);
  const sb = ser(b);
  if (!ordered) {
    sa.sort();
    sb.sort();
  }
  return sa.length === sb.length && sa.every((x, i) => x === sb[i]);
}

async function runQuery(sqlClient, sql) {
  const reserved = await sqlClient.reserve();
  try {
    await reserved.unsafe(`SET search_path TO ${SCHEMA}`);
    await reserved.unsafe("SET statement_timeout = '5s'");
    return await reserved.unsafe(sql);
  } finally {
    reserved.release();
  }
}

async function gradeCase(sqlClient, pool, c, configOverride) {
  const started = Date.now();
  let res;
  try {
    res = await generateSql({
      pool,
      schema: SCHEMA,
      prompt: c.prompt,
      focusTable: c.focusTable,
      history: [],
      configOverride,
    });
  } catch (err) {
    return { pass: false, klass: 'error', detail: err.message, ms: Date.now() - started };
  }
  const ms = Date.now() - started;
  const tokens = (res.usage?.inputTokens || 0) + (res.usage?.outputTokens || 0);

  if (c.expect === 'refusal') {
    return res.refusal
      ? { pass: true, klass: 'refused', ms, tokens }
      : { pass: false, klass: 'success', detail: `expected refusal, got: ${res.sql}`, ms, tokens };
  }
  if (res.refusal) return { pass: false, klass: 'refused', detail: res.refusal, ms, tokens };
  if (res.validationError) {
    return { pass: false, klass: 'invalid', detail: res.validationError, ms, tokens };
  }
  if (!res.readOnly) {
    // Never execute non-read SQL, even against the throwaway fixture.
    return { pass: false, klass: 'write', detail: res.sql, ms, tokens };
  }

  try {
    const [got, want] = [await runQuery(sqlClient, res.sql), await runQuery(sqlClient, c.golden)];
    const pass = sameResults(got, want, c.ordered);
    return {
      pass,
      klass: 'success',
      rows: got.length,
      detail: pass ? undefined : `got ${got.length} rows, want ${want.length}: ${res.sql}`,
      ms,
      tokens,
    };
  } catch (err) {
    return { pass: false, klass: 'error', detail: `${err.message}: ${res.sql}`, ms, tokens };
  }
}

async function main() {
  const { values: args } = parseArgs({
    options: {
      provider: { type: 'string' },
      model: { type: 'string' },
      db: { type: 'string' },
    },
  });
  if (!args.provider || !PROVIDERS.includes(args.provider)) {
    console.error(`Usage: node test/eval/run.js --provider <${PROVIDERS.join('|')}> [--model …] [--db …]`);
    process.exit(1);
  }
  const configOverride = {
    provider: args.provider,
    ...(args.model && { model: args.model }),
  };

  const sqlClient = postgres(args.db || DEFAULT_DB, { max: 4, onnotice: () => {} });
  const pool = createPoolWrapper(sqlClient);
  try {
    await sqlClient.unsafe(fs.readFileSync(path.join(__dirname, 'fixture.sql'), 'utf8'));
  } catch (err) {
    console.error(`Could not apply fixture (is the docker test DB up?): ${err.message}`);
    await sqlClient.end();
    process.exit(1);
  }

  console.log(`eval: ${cases.length} cases, provider=${args.provider}`
    + `${args.model ? ` model=${args.model}` : ''}\n`);

  const results = [];
  for (const c of cases) {
    // Sequential on purpose — kind to Ollama, and keeps per-case latency honest.
    const r = await gradeCase(sqlClient, pool, c, configOverride);
    results.push({ ...r, id: c.id });
    const rows = r.rows != null ? `${r.rows} rows` : r.klass;
    const tok = r.tokens ? `${(r.tokens / 1000).toFixed(1)}k tok` : '';
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${c.id.padEnd(22)} ${rows.padEnd(10)}`
      + ` ${(r.ms / 1000).toFixed(1)}s ${tok}${!r.pass && r.detail ? `\n      ${r.detail}` : ''}`);
  }

  const passed = results.filter((r) => r.pass).length;
  console.log(`\npass rate: ${passed}/${results.length}`
    + ` (${Math.round((100 * passed) / results.length)}%)`);

  const byKlass = {};
  for (const r of results) byKlass[r.klass] = (byKlass[r.klass] || 0) + 1;
  console.log(`classes: ${Object.entries(byKlass).map(([k, n]) => `${k}=${n}`).join(' ')}`);

  const groups = {};
  for (const r of results) {
    const g = r.id.split('-')[0];
    groups[g] = groups[g] || { pass: 0, total: 0 };
    groups[g].total += 1;
    if (r.pass) groups[g].pass += 1;
  }
  console.log('groups:  '
    + Object.entries(groups).map(([g, s]) => `${g}=${s.pass}/${s.total}`).join(' '));

  await sqlClient.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
