/**
 * AI mode — schema-aware NL→SQL (roadmap §7.6).
 *
 * BYOK across three providers:
 *   - anthropic — via @anthropic-ai/sdk (optional dependency, loaded lazily)
 *   - openai    — via the Chat Completions REST API (global fetch, no SDK)
 *   - ollama    — via a local Ollama daemon's /api/chat (no key, configurable host)
 *
 * API keys live in the OS keychain via the same secret backend as connection
 * passwords (account `ai-key:<provider>`). Non-secret settings (active provider,
 * model, write toggle, ollama host) live in `~/.pglens/ai.json`.
 *
 * A request is grounded on the live schema, sample rows for the focused table,
 * the user's recent query history, and (optionally) the current view's filter.
 * Generated SQL is returned to the client for review/edit before it runs — pglens
 * never executes it here. By default only read-only SQL is produced; writes
 * require the user to opt in (`allowWrites`).
 */

const crypto = require('crypto');
const fs = require('fs');
const secrets = require('../db/secrets');
const { splitStatements } = require('../db/statements');
const { quoteIdent, quoteQualifiedIdent } = require('../db/identifier');
const { AI_CONFIG_FILE, ensureLayout } = require('../config/paths');
const logger = require('../log');

const PROVIDERS = ['anthropic', 'openai', 'ollama'];
const DEFAULT_MODELS = {
  anthropic: 'claude-opus-5',
  openai: 'gpt-4o',
  ollama: 'llama3.1',
};
const DEFAULT_OLLAMA_HOST = 'http://127.0.0.1:11434';

// ponytail: bound the prompt so a 500-table schema can't blow the token budget.
// A truncation note tells the model the context was clipped.
const MAX_SCHEMA_CHARS = 24_000;
const SAMPLE_ROWS = 3;
// How many prompt-relevant tables get sample rows (each costs one LIMIT-3 query).
const MAX_SAMPLED_TABLES = 3;
// Real values rendered per column ([values: …]) — enough to cover enums and
// status columns without letting a 20-distinct column dominate the line.
const MAX_COLUMN_VALUES = 10;
const MAX_VALUE_CHARS = 60;
// Wall-clock cap per model call; a hung Ollama daemon must not block the route.
const CALL_TIMEOUT_MS = 60_000;
// Validation-repair round-trips after the first attempt. Two, because small
// local models often need a second look at the Postgres error.
const MAX_REPAIR_ROUNDS = 2;
// Bumped whenever the prompt contract changes — telemetry slices by this so a
// prompt edit that regresses validation failures is attributable.
const PROMPT_VERSION = 'nl2sql-v6';

function keyAccount(provider) {
  return `ai-key:${provider}`;
}

// `responseClass` tags the error with one of the telemetry classes so the
// per-request log event can be sliced by failure mode (the article's three
// "200 OK" signals: schema_fail, refusal, and — via token/attempt counts — cost).
function httpError(status, message, hint, responseClass) {
  const e = new Error(message);
  e.statusCode = status;
  if (hint) e.hint = hint;
  if (responseClass) e.responseClass = responseClass;
  return e;
}

// Normalize each provider's usage block to { inputTokens, outputTokens }.
function extractUsage(provider, payload) {
  if (provider === 'anthropic') {
    const u = payload?.usage || {};
    return { inputTokens: u.input_tokens ?? null, outputTokens: u.output_tokens ?? null };
  }
  if (provider === 'openai') {
    const u = payload?.usage || {};
    return { inputTokens: u.prompt_tokens ?? null, outputTokens: u.completion_tokens ?? null };
  }
  if (provider === 'ollama') {
    return {
      inputTokens: payload?.prompt_eval_count ?? null,
      outputTokens: payload?.eval_count ?? null,
    };
  }
  return { inputTokens: null, outputTokens: null };
}

// The Anthropic SDK is required lazily (like keytar) so the server still boots
// when the optional dependency is absent; OpenAI/Ollama use global fetch.
function loadAnthropic() {
  const pkg = require('@anthropic-ai/sdk');
  return pkg.default || pkg;
}
function anthropicAvailable() {
  try { loadAnthropic(); return true; } catch { return false; }
}

// ---- Settings ---------------------------------------------------------------

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(AI_CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeSettings(settings) {
  ensureLayout();
  fs.writeFileSync(AI_CONFIG_FILE, JSON.stringify(settings), { mode: 0o600 });
}

async function getConfig() {
  const s = readSettings();
  const provider = PROVIDERS.includes(s.provider) ? s.provider : 'anthropic';
  // Ollama needs no key — a reachable host is enough, so it's always "configured".
  const configured =
    provider === 'ollama' ? true : !!(await secrets.getPassword(keyAccount(provider)));
  return {
    available: process.env.PGLENS_AI_DISABLED !== '1',
    configured,
    provider,
    model: s.model || DEFAULT_MODELS[provider],
    allowWrites: !!s.allowWrites,
    ollamaHost: s.ollamaHost || DEFAULT_OLLAMA_HOST,
  };
}

async function setConfig({ apiKey, model, allowWrites, provider, ollamaHost } = {}) {
  const s = readSettings();
  if (provider !== undefined) {
    if (!PROVIDERS.includes(provider)) throw httpError(400, `Unknown provider "${provider}".`);
    s.provider = provider;
    // Switching provider resets the model to that provider's default unless the
    // caller set one explicitly in the same request.
    if (model === undefined) s.model = DEFAULT_MODELS[provider];
  }
  if (model !== undefined) {
    s.model = model || DEFAULT_MODELS[s.provider || 'anthropic'];
  }
  if (allowWrites !== undefined) s.allowWrites = !!allowWrites;
  if (ollamaHost !== undefined) s.ollamaHost = ollamaHost || DEFAULT_OLLAMA_HOST;
  writeSettings(s);

  if (apiKey !== undefined) {
    const account = keyAccount(provider || s.provider || 'anthropic');
    if (apiKey === null || apiKey === '') {
      await secrets.deletePassword(account);
    } else {
      await secrets.setPassword(account, apiKey);
    }
  }
  return getConfig();
}

// ---- Read-only guard --------------------------------------------------------

/**
 * Conservative read-only check used to enforce the "read-only unless writes
 * enabled" rule. Every statement must start with a read keyword AND contain no
 * write/DDL keyword anywhere (so a `WITH ... INSERT` CTE is also rejected).
 *
 * ponytail: lexical, not a parser — a string literal like `'please update'`
 * reads as a write and gets blocked. That false-positive is acceptable for a
 * gate whose failure mode is "ask the user to enable writes"; upgrade to a real
 * parse only if it bites.
 */
function isReadOnly(sql) {
  const stmts = splitStatements(sql);
  if (stmts.length === 0) return false;
  const allowedStart = /^\s*(with|select|explain|show|table|values)\b/i;
  const writeKeyword =
    /\b(insert|update|delete|truncate|drop|alter|create|grant|revoke|merge|call|do|copy)\b/i;
  return stmts.every((s) => allowedStart.test(s) && !writeKeyword.test(s));
}

// ---- Schema grounding -------------------------------------------------------

function typeName(dataType, udtName) {
  if (dataType === 'ARRAY') {
    return udtName.startsWith('_') ? `${udtName.slice(1)}[]` : `${udtName}[]`;
  }
  if (dataType === 'USER-DEFINED') return udtName;
  return udtName || dataType;
}

// Render an identifier the way it must be written in SQL: bare when it's a
// simple lower-case name, double-quoted otherwise. Postgres folds unquoted
// identifiers to lower case, so a mixed-case table like `Dispute` only resolves
// when quoted — showing the quotes here is what teaches the model to keep them.
function qid(name) {
  return /^[a-z_][a-z0-9_]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`;
}

// Free-text-ish types whose pg_stats most-common values are worth showing —
// these are the columns where a guessed literal silently matches nothing.
const TEXTY_UDT = new Set(['text', 'varchar', 'bpchar', 'citext']);

// SQL-quoted, clipped, capped value list: [values: 'pending', 'paid', …].
// Bracket form on purpose — a `--` comment would swallow the `,\n` join.
function renderValues(vals) {
  const shown = vals.slice(0, MAX_COLUMN_VALUES)
    .map((v) => `'${String(v).slice(0, MAX_VALUE_CHARS).replace(/'/g, "''")}'`);
  return `[values: ${shown.join(', ')}${vals.length > MAX_COLUMN_VALUES ? ', …' : ''}]`;
}

// Split an identifier into lower-case word tokens: `evidenceDueBy` →
// [evidence, due, by], `user_id` → [user, id].
function tokenizeIdent(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((t) => t.toLowerCase());
}

// Word tokens of the user's request, with naive singulars so "disputes"
// matches a table named Dispute.
function promptTokens(prompt) {
  const out = new Set();
  for (const t of tokenizeIdent(prompt)) {
    if (t.length < 3) continue;
    out.add(t);
    if (t.endsWith('s')) out.add(t.slice(0, -1));
  }
  return out;
}

// Token match for scoring: exact, or a shared prefix of ≥6 chars — so
// "subscribers" still finds the "Subscription" table. Loose matches only ever
// ADD a table to the context, so a false positive is harmless.
function tokensMatch(a, b) {
  if (a === b) return true;
  const n = Math.min(a.length, b.length);
  if (n < 6) return false;
  return a.slice(0, 6) === b.slice(0, 6);
}

function anyTokenMatch(promptTokenSet, identToken) {
  for (const t of promptTokenSet) {
    if (tokensMatch(t, identToken)) return true;
  }
  return false;
}

// Unambiguous non-database asks (write me code, hello world). Kept narrow on
// purpose — "create a function" could be plpgsql, so it does NOT match. The
// gate additionally requires zero overlap with schema names before rejecting,
// so "list users who prefer python" (a data question) never trips it.
const OFF_TOPIC_RE = new RegExp(
  [
    /\bhello,? world\b/.source,
    /\b(?:in|using|with)\s+(?:python|javascript|typescript|java|c\+\+|c#|rust|golang|ruby|php|swift|kotlin|bash)\b/.source,
    /\b(?:python|javascript|typescript|java|rust|bash)\s+(?:code|script|function|program|app)\b/.source,
  ].join('|'),
  'i',
);

/**
 * Deterministic guardrail, run BEFORE any model call: reject a prompt that
 * matches a clearly-off-topic pattern AND shares no vocabulary with the schema.
 * Model-independent, so an 8b model that ignores instructions can't be talked
 * into fabricating SQL for it. Typo'd off-topic prompts ("pythin") slip past
 * this layer and are caught by the model-side refusal field instead.
 */
function classifyPrompt(prompt, schemaTokens) {
  if (!OFF_TOPIC_RE.test(prompt)) return 'db';
  for (const t of promptTokens(prompt)) {
    if (schemaTokens.has(t)) return 'db';
  }
  return 'off_topic';
}

/**
 * Introspect the schema and build the grounding text. When `prompt` is given,
 * tables are scored against it (name match ≫ column match), expanded one FK hop
 * (so joins survive pruning), and rendered best-first — a small model gets 3
 * relevant tables instead of 27, which is the single biggest accuracy lever for
 * 8b-class models. No score at all ⇒ fall back to every table (still bounded by
 * MAX_SCHEMA_CHARS, best-known-first).
 */
async function buildGrounding(pool, schema, { focusTable, prompt } = {}) {
  const [cols, pks, fks, enums, stats] = await Promise.all([
    pool.query(
      `SELECT table_name, column_name, data_type, udt_name, is_nullable
       FROM information_schema.columns
       WHERE table_schema = $1
       ORDER BY table_name, ordinal_position`,
      [schema],
    ),
    pool.query(
      `SELECT tc.table_name, kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
       WHERE tc.table_schema = $1 AND tc.constraint_type = 'PRIMARY KEY'`,
      [schema],
    ),
    pool.query(
      `SELECT kcu.table_name, kcu.column_name,
              ccu.table_name AS ftable, ccu.column_name AS fcol
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
       JOIN information_schema.constraint_column_usage ccu
         ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
       WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = $1`,
      [schema],
    ),
    // Enum labels — the complete legal value set for enum columns. Must join
    // pg_namespace: pg_enum alone returns every enum in the database.
    pool.query(
      `SELECT t.typname, e.enumlabel
       FROM pg_type t
       JOIN pg_enum e ON e.enumtypid = t.oid
       JOIN pg_namespace n ON n.oid = t.typnamespace
       WHERE n.nspname = $1
       ORDER BY t.typname, e.enumsortorder`,
      [schema],
    ).catch(() => ({ rows: [] })),
    // Most-common values from planner statistics — catalog only, no table
    // scan. Empty until ANALYZE/autovacuum has run, and only for columns the
    // role can read; both degrade to "no hints". most_common_vals is anyarray,
    // so the ::text::text[] double-cast is required (and quote-safe).
    // n_distinct is negative when a ratio; BETWEEN keeps true low-cardinality.
    pool.query(
      `SELECT tablename, attname, most_common_vals::text::text[] AS vals
       FROM pg_stats
       WHERE schemaname = $1 AND inherited = false
         AND n_distinct BETWEEN 1 AND 20 AND most_common_vals IS NOT NULL`,
      [schema],
    ).catch(() => ({ rows: [] })),
  ]);

  const pkSet = new Set(pks.rows.map((r) => `${r.table_name}\0${r.column_name}`));
  const fkMap = new Map();
  const neighbors = new Map(); // table -> Set(FK-adjacent tables, both directions)
  const addNeighbor = (a, b) => {
    if (!neighbors.has(a)) neighbors.set(a, new Set());
    neighbors.get(a).add(b);
  };
  for (const r of fks.rows) {
    fkMap.set(`${r.table_name}\0${r.column_name}`, `${qid(r.ftable)}.${qid(r.fcol)}`);
    addNeighbor(r.table_name, r.ftable);
    addNeighbor(r.ftable, r.table_name);
  }

  const enumLabels = new Map(); // udt_name -> [label, ...] in enum order
  for (const r of enums.rows) {
    if (!enumLabels.has(r.typname)) enumLabels.set(r.typname, []);
    enumLabels.get(r.typname).push(r.enumlabel);
  }
  const commonVals = new Map(); // `${table}\0${column}` -> [value, ...]
  for (const r of stats.rows) {
    commonVals.set(`${r.tablename}\0${r.attname}`, r.vals);
  }

  const byTable = new Map();
  for (const r of cols.rows) {
    if (!byTable.has(r.table_name)) byTable.set(r.table_name, []);
    byTable.get(r.table_name).push(r);
  }

  // Vocabulary of every table/column word — used by the off-topic gate.
  const schemaTokens = new Set();
  for (const [table, columns] of byTable) {
    for (const t of tokenizeIdent(table)) schemaTokens.add(t);
    for (const c of columns) for (const t of tokenizeIdent(c.column_name)) schemaTokens.add(t);
  }

  // Score tables against the prompt; select scored ones + their FK neighbors.
  let ordered = [...byTable.keys()];
  let promptScored = false;
  if (prompt) {
    const tokens = promptTokens(prompt);
    const scores = new Map();
    for (const [table, columns] of byTable) {
      let s = 0;
      for (const t of tokenizeIdent(table)) if (anyTokenMatch(tokens, t)) s += 3;
      for (const c of columns) {
        for (const t of tokenizeIdent(c.column_name)) if (anyTokenMatch(tokens, t)) s += 1;
      }
      if (s > 0) scores.set(table, s);
    }
    if (focusTable && byTable.has(focusTable)) {
      scores.set(focusTable, (scores.get(focusTable) || 0) + 5);
    }
    if (scores.size > 0) {
      promptScored = true;
      const picked = new Set(scores.keys());
      for (const table of [...picked]) {
        for (const n of neighbors.get(table) ?? []) picked.add(n);
      }
      ordered = [...picked].sort((a, b) => (scores.get(b) || 0) - (scores.get(a) || 0));
    }
  }

  let text = '';
  let truncated = false;
  let tableCount = 0;
  const rendered = new Set();
  for (const table of ordered) {
    const columns = byTable.get(table);
    const lines = columns.map((c) => {
      const key = `${table}\0${c.column_name}`;
      const parts = [`  ${qid(c.column_name)} ${typeName(c.data_type, c.udt_name)}`];
      if (c.is_nullable === 'NO') parts.push('NOT NULL');
      if (pkSet.has(key)) parts.push('PK');
      if (fkMap.has(key)) parts.push(`FK -> ${fkMap.get(key)}`);
      // Real values inline on the column line — the model picks filter
      // literals from the line it's already reading. Enum labels win (the
      // complete legal set); stats MCVs only for free-text-ish columns.
      const vals = enumLabels.get(c.udt_name)
        ?? (TEXTY_UDT.has(c.udt_name) ? commonVals.get(key) : undefined);
      if (vals && vals.length) parts.push(renderValues(vals));
      return parts.join(' ');
    });
    const block = `TABLE ${qid(table)} (\n${lines.join(',\n')}\n)\n\n`;
    if (text.length + block.length > MAX_SCHEMA_CHARS) {
      truncated = true;
      break;
    }
    text += block;
    rendered.add(table);
    tableCount += 1;
  }
  if (truncated) text += '-- (schema truncated to fit context)\n';

  // Directory of the tables NOT detailed above (pruned or truncated away).
  // Costs a line, prevents two failure modes: the model guessing a nonsense
  // table because the right one was pruned, and refusing "no such data" when
  // a relevant table simply wasn't detailed.
  const omitted = [...byTable.keys()].filter((t) => !rendered.has(t));
  if (omitted.length > 0) {
    text += 'Other tables in this schema (columns not shown — if one of these'
      + ' matches the request better, say so in "refusal" instead of guessing):\n'
      + omitted.map(qid).join(', ') + '\n';
  }

  // Sample real rows for the focused table AND the best-scoring tables, so
  // filter values are grounded in data the model has actually seen. A guessed
  // literal like status = 'canceled' is exactly what this prevents — on the
  // Query page there is no focused table, so scored tables are the only source
  // of real values. Without a scored prompt (browsing fallback), only the
  // focused table is sampled — sampling arbitrary tables wastes the budget.
  const sampleTargets = [];
  if (focusTable && rendered.has(focusTable)) sampleTargets.push(focusTable);
  if (promptScored) {
    for (const t of ordered) {
      if (sampleTargets.length >= MAX_SAMPLED_TABLES) break;
      if (rendered.has(t) && !sampleTargets.includes(t)) sampleTargets.push(t);
    }
  }
  const sampled = await Promise.all(
    sampleTargets.map((t) => sampleRows(pool, schema, t)),
  );
  sampled.forEach((s, i) => {
    if (s) text += `\nSample rows from ${qid(sampleTargets[i])}:\n${s}\n`;
  });

  return {
    text,
    schemaTokens,
    tableCount,
    totalTables: byTable.size,
    // First (highest-scoring) rendered table — seeds the few-shot example.
    exampleTable: ordered.length ? ordered[0] : null,
  };
}

// Back-compat wrapper (kept for tests and any external caller).
async function buildSchemaContext(pool, schema, focusTable, prompt) {
  return (await buildGrounding(pool, schema, { focusTable, prompt })).text;
}

async function sampleRows(pool, schema, table) {
  try {
    const r = await pool.query(
      `SELECT * FROM ${quoteQualifiedIdent(schema, table)} LIMIT ${SAMPLE_ROWS}`,
    );
    if (!r.rows.length) return null;
    return r.rows.map((row) => JSON.stringify(row, truncateCells)).join('\n');
  } catch (err) {
    // Missing table / permission error — grounding is best-effort.
    logger.debug?.({ err: err.message, table }, 'ai sample rows skipped');
    return null;
  }
}

// JSON.stringify replacer: clip long string cells so a wide TEXT/JSONB column
// can't dominate the prompt.
function truncateCells(_key, value) {
  if (typeof value === 'string' && value.length > 120) {
    return `${value.slice(0, 120)}…`;
  }
  return value;
}

// ---- Prompt assembly --------------------------------------------------------

// Rules are deliberately short — 8b-class models follow a handful of imperative
// lines plus concrete examples far better than a long policy list. The example
// uses a real table from THIS schema so quoting style is copied, not inferred,
// and the refusal example shows the off-topic path explicitly.
function buildSystemPrompt({ schema, schemaText, allowWrites, exampleTable }) {
  const readRule = allowWrites
    ? '8. Writes are allowed, but prefer the narrowest query that satisfies the request.'
    : '8. READ-ONLY: only SELECT (or WITH ... SELECT). Never INSERT/UPDATE/DELETE or DDL.';
  const ex = exampleTable ? qid(exampleTable) : '"users"';
  return [
    'You translate natural-language requests into ONE PostgreSQL query for the'
    + ` "${schema}" schema of the database described below. Nothing else.`,
    '',
    'Rules:',
    '1. Use ONLY the tables and columns listed under Schema. Never invent names.',
    '2. Copy identifiers EXACTLY as written, including double quotes'
    + ' (write FROM "Dispute", never FROM Dispute).',
    '3. If the request is not a question about this database, set "sql" to null'
    + ' and explain why in "refusal".',
    '4. If no table or column plausibly holds the requested concept, DO NOT'
    + ' guess a similar-sounding table. Set "sql" to null and say in "refusal"'
    + ' what the schema is missing (mention the closest table if one exists).',
    '5. Add WHERE conditions ONLY for what the request states or clearly'
    + ' implies. Never add extra filters (status checks, NOT NULL, date cutoffs)'
    + ' on your own, and never use a filter value the schema or sample rows'
    + " don't make plausible. When a column shows [values: …], those are real"
    + ' values from this database — filter with one of them, spelled exactly.',
    '6. For user-supplied free text (a person\'s name, a title, a description),'
    + ' match case-insensitively with ILIKE and % wildcards'
    + ' (e.g. "fullName" ILIKE \'%carter%\') — unless the exact value appears in'
    + ' a [values: …] list or the sample rows. Plain = on text is'
    + ' case-sensitive and usually matches nothing.',
    '7. "last/latest/newest N ..." means the N most recent rows: ORDER BY the'
    + ' creation-timestamp column DESC LIMIT N — not the largest by amount.',
    readRule,
    '9. Set "confidence" to "low" whenever you are guessing about tables,'
    + ' columns, or values; "high" only when the schema clearly supports the query.',
    '10. Reply with ONLY this JSON, no prose, no code fences:'
    + ' {"sql": string|null, "explanation": string, "refusal": string|null,'
    + ' "confidence": "high"|"low"}',
    '',
    'Examples:',
    `Request: how many rows are in ${ex}?`,
    `{"sql": "SELECT count(*) FROM ${ex.replace(/"/g, '\\"')}", "explanation": "Counts all rows.", "refusal": null, "confidence": "high"}`,
    'Request: churn rate for 2027',
    '{"sql": null, "explanation": "", "refusal": "The schema has no churn or retention data — nothing here records cancellations over time.", "confidence": "high"}',
    'Request: write a python script that sorts a list',
    '{"sql": null, "explanation": "", "refusal": "This is a general programming request, not a question about this database.", "confidence": "high"}',
    '',
    'Schema:',
    schemaText,
  ].join('\n');
}

function buildUserMessage({ prompt, focusTable, filterText, history }) {
  const parts = [`Request: ${prompt}`];
  if (focusTable) parts.push(`Focused table: ${focusTable}`);
  if (filterText) parts.push(`Filter already applied in the UI: ${filterText}`);
  if (history && history.length) {
    parts.push(
      'Recent queries (context only — do not reuse unless directly relevant):\n'
      + history.join('\n'),
    );
  }
  return parts.join('\n');
}

// ---- Model calls (per provider) ---------------------------------------------

const RESULT_SCHEMA = {
  type: 'object',
  properties: {
    sql: {
      type: ['string', 'null'],
      description: 'The PostgreSQL query, or null if the request cannot be answered with SQL.',
    },
    explanation: {
      type: 'string',
      description: 'One or two sentences on what the query does and any assumption made.',
    },
    refusal: {
      type: ['string', 'null'],
      description: 'One-sentence reason the request is out of scope, or null when SQL was produced.',
    },
    confidence: {
      type: 'string',
      enum: ['high', 'low'],
      description: 'high only when the schema clearly contains the requested data; low when guessing.',
    },
  },
  required: ['sql', 'explanation', 'refusal', 'confidence'],
  additionalProperties: false,
};

function parseModelJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    // Small local models sometimes wrap JSON in prose or fences; salvage the
    // outermost object before giving up.
    const m = text && text.match(/\{[\s\S]*\}/);
    if (m) {
      try { return JSON.parse(m[0]); } catch { /* fall through */ }
    }
    throw httpError(502, 'Model returned an unparseable response.', undefined, 'schema_fail');
  }
}

function clip(s) {
  return typeof s === 'string' && s.length > 200 ? `${s.slice(0, 200)}…` : s;
}

// Each provider call returns { result, usage } so the caller can both use the
// SQL and account for the token spend (the article's cost-per-request signal).

async function callAnthropic({ apiKey, model, system, user }) {
  if (!anthropicAvailable()) {
    throw httpError(503, 'Anthropic SDK not installed.', 'Run `npm i @anthropic-ai/sdk` or pick another provider.');
  }
  const Anthropic = loadAnthropic();
  // The SDK retries transient errors itself (maxRetries) and bounds each attempt.
  const client = new Anthropic({ apiKey, timeout: CALL_TIMEOUT_MS, maxRetries: 2 });
  const resp = await client.messages.create({
    model: model || DEFAULT_MODELS.anthropic,
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    system,
    messages: [{ role: 'user', content: user }],
    output_config: {
      format: { type: 'json_schema', name: 'sql_suggestion', schema: RESULT_SCHEMA },
    },
  });
  if (resp.stop_reason === 'refusal') {
    throw httpError(422, 'The model declined to answer this request.', undefined, 'refusal');
  }
  const text = (resp.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  return { result: parseModelJson(text), usage: extractUsage('anthropic', resp) };
}

async function callOpenAI({ apiKey, model, system, user }) {
  let resp;
  try {
    resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      body: JSON.stringify({
        model: model || DEFAULT_MODELS.openai,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'sql_suggestion', schema: RESULT_SCHEMA, strict: true },
        },
      }),
    });
  } catch (err) {
    const msg = err.name === 'TimeoutError' ? `OpenAI request timed out after ${CALL_TIMEOUT_MS / 1000}s.` : `Could not reach OpenAI: ${err.message}`;
    throw httpError(502, msg);
  }
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    const status = resp.status === 401 ? 401 : resp.status >= 500 ? 502 : 400;
    throw httpError(status, `OpenAI error (${resp.status}): ${clip(body)}`);
  }
  const data = await resp.json();
  return {
    result: parseModelJson(data.choices?.[0]?.message?.content || ''),
    usage: extractUsage('openai', data),
  };
}

async function callOllama({ ollamaHost, model, system, user }) {
  const host = (ollamaHost || DEFAULT_OLLAMA_HOST).replace(/\/+$/, '');
  let resp;
  try {
    resp = await fetch(`${host}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      body: JSON.stringify({
        model: model || DEFAULT_MODELS.ollama,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        stream: false,
        // Ollama structured outputs: a JSON-schema object constrains the reply.
        // Older daemons ignore it and still emit JSON, which parseModelJson handles.
        format: RESULT_SCHEMA,
        options: { temperature: 0 },
      }),
    });
  } catch (err) {
    const msg = err.name === 'TimeoutError'
      ? `Ollama timed out after ${CALL_TIMEOUT_MS / 1000}s (model may be loading).`
      : `Could not reach Ollama at ${host}: ${err.message}`;
    throw httpError(502, msg, 'Is `ollama serve` running, and the host correct in AI settings?');
  }
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw httpError(resp.status >= 500 ? 502 : 400, `Ollama error (${resp.status}): ${clip(body)}`);
  }
  const data = await resp.json();
  return {
    result: parseModelJson(data.message?.content || ''),
    usage: extractUsage('ollama', data),
  };
}

function callModel(provider, opts) {
  switch (provider) {
    case 'anthropic': return callAnthropic(opts);
    case 'openai': return callOpenAI(opts);
    case 'ollama': return callOllama(opts);
    default: throw httpError(400, `Unknown provider "${provider}".`);
  }
}

function friendlyError(provider, err) {
  if (err.status === 401) return `${provider} rejected the API key (401). Update it in AI settings.`;
  if (err.status === 429) return `${provider} rate limit hit (429). Try again shortly.`;
  return err.message || 'AI request failed.';
}

// ---- Validation + repair ----------------------------------------------------

// Statements a plain EXPLAIN can plan. Utility statements (SHOW, SET, ...) can't
// be EXPLAINed, so we skip validation for them rather than report a false error.
const EXPLAINABLE = /^\s*(select|with|insert|update|delete|values|table)\b/i;

/**
 * Catch hallucinated columns/tables and type errors the way Postgres itself
 * would: plan the statement with `EXPLAIN` (no ANALYZE, so nothing executes —
 * safe even for writes). Returns the Postgres error message on failure, or null
 * when the statement plans cleanly / can't be validated this way.
 */
async function validateSql(pool, schema, sql) {
  const stmts = splitStatements(sql);
  // EXPLAIN takes a single statement; skip multi-statement scripts.
  if (stmts.length !== 1 || !EXPLAINABLE.test(stmts[0])) return null;
  try {
    await pool.explain(schema, stmts[0], []);
    return null;
  } catch (err) {
    return err.message;
  }
}

function repairMessage(userMsg, badSql, error) {
  return [
    userMsg,
    '',
    'Your previous SQL was invalid and must be corrected.',
    `Previous SQL: ${badSql}`,
    `PostgreSQL rejected it with: ${error}`,
    'Return corrected JSON, using only tables and columns from the schema.',
  ].join('\n');
}

/**
 * Row-count probe for a validated, READ-ONLY statement: run it as
 * `SELECT count(*) FROM (…)` under a short statement_timeout. This is how the
 * server learns what the user would otherwise discover by hand — that a
 * plausible-looking query matches nothing (invented filter, wrong join path).
 * Returns the count, or null when the probe doesn't apply or timed out.
 * Read-only-ness is checked by the caller; nothing here can write.
 */
const PROBE_TIMEOUT_MS = 3_000;

async function countRows(pool, schema, sql) {
  const stmts = splitStatements(sql);
  if (stmts.length !== 1 || !/^\s*(select|with)\b/i.test(stmts[0])) return null;
  try {
    let count = null;
    await pool.transaction(async (tx) => {
      await tx.query(`SET LOCAL search_path TO ${quoteIdent(schema)}`);
      await tx.query(`SET LOCAL statement_timeout = '${PROBE_TIMEOUT_MS}ms'`);
      const r = await tx.query(
        `SELECT count(*) AS n FROM (${stmts[0]}) pglens_probe`,
      );
      count = Number(r.rows[0].n);
    });
    return Number.isFinite(count) ? count : null;
  } catch (err) {
    // Timeout or a construct count(*) can't wrap — inconclusive, not fatal.
    logger.debug?.({ err: err.message }, 'ai row-count probe skipped');
    return null;
  }
}

function zeroRowsMessage(userMsg, sql) {
  return [
    userMsg,
    '',
    'Your previous SQL is valid but returned 0 rows on the live database.',
    `Previous SQL: ${sql}`,
    'Check each WHERE predicate one at a time against the Schema section:',
    "- a filter literal must be one of that column's [values: …] entries or"
    + ' appear in the sample rows. If yours is not there, replace it with the'
    + " closest real value (e.g. 'canceled' → 'cancelled').",
    "- text equality is case-sensitive; for names/titles use ILIKE '%…%'.",
    '- drop any filter the request did not explicitly ask for, and re-check'
    + ' join columns against the FK arrows.',
    'Return corrected JSON.',
  ].join('\n');
}

// One structured telemetry event per request — the article's core advice for
// apps that "fail with 200 OK". Goes to the existing pino log (`~/.pglens/logs`)
// as a single JSON line under `ai`, so failure modes (schema_fail / refusal /
// validation_fail) and token spend per request are queryable after the fact.
// ponytail: this IS the observability surface for a local single-user tool —
// pager rules, multi-window burn rates, shadow-eval sampling and request-replay
// from the article are team-scale ops that arrive (if ever) with team mode (v4).
function logTelemetry(event) {
  logger.info({ ai: event }, 'ai.nl2sql');
}

// ---- Public entry point -----------------------------------------------------

// `configOverride` is for the eval harness only (test/eval/run.js) — it lets a
// run pin provider/model without mutating ~/.pglens/ai.json. The HTTP route
// never passes it; API keys still resolve from the keychain either way.
async function generateSql({ pool, schema, prompt, focusTable, filterText, history, configOverride }) {
  const requestId = crypto.randomUUID();
  const started = Date.now();
  // Token spend is summed across attempts so a repair round-trip shows its real
  // cost (the article's "retry loops inflate cost" signal).
  const used = { inputTokens: 0, outputTokens: 0 };
  const addUsage = (u) => {
    if (u?.inputTokens) used.inputTokens += u.inputTokens;
    if (u?.outputTokens) used.outputTokens += u.outputTokens;
  };
  let attempts = 0;
  let cfg;
  let responseClass = 'error';
  let validationError = null;
  let tablesSent = null;
  let tablesTotal = null;
  let rowCount = null;

  try {
    cfg = await getConfig();
    if (configOverride) cfg = { ...cfg, ...configOverride };
    if (!cfg.available) {
      throw httpError(503, 'AI mode is disabled (PGLENS_AI_DISABLED=1).');
    }

    const provider = cfg.provider;
    let apiKey = null;
    if (provider !== 'ollama') {
      apiKey = await secrets.getPassword(keyAccount(provider));
      if (!apiKey) {
        throw httpError(400, `No ${provider} API key configured.`, 'Add your key in AI settings.', 'no_key');
      }
    }

    const grounding = await buildGrounding(pool, schema, { focusTable, prompt });
    tablesSent = grounding.tableCount;
    tablesTotal = grounding.totalTables;

    // Hard guardrail: unambiguous non-database asks never reach a model.
    // Deterministic, so it holds regardless of how small the model is.
    if (classifyPrompt(prompt, grounding.schemaTokens) === 'off_topic') {
      responseClass = 'refusal';
      return {
        sql: '',
        explanation: '',
        refusal: 'This looks like a general programming request, not a question'
          + ' about your database — pglens only turns data questions into SQL.',
        readOnly: true, validationError: null, rowCount: null, usage: { ...used },
      };
    }

    const system = buildSystemPrompt({
      schema,
      schemaText: grounding.text,
      allowWrites: cfg.allowWrites,
      exampleTable: grounding.exampleTable,
    });
    const userMsg = buildUserMessage({ prompt, focusTable, filterText, history });

    const call = async (user) => {
      attempts += 1;
      try {
        const out = await callModel(provider, {
          apiKey, model: cfg.model, ollamaHost: cfg.ollamaHost, system, user,
        });
        addUsage(out.usage);
        return out.result;
      } catch (err) {
        if (err.statusCode) throw err; // already an httpError (refusal / parse / transport)
        throw httpError(err.status === 401 ? 401 : 502, friendlyError(provider, err));
      }
    };

    const result = await call(userMsg);
    const refusal = (result.refusal || '').trim();
    let sql = (result.sql || '').trim();

    // Out-of-scope request (e.g. "write hello world in python"): the model
    // declined instead of fabricating SQL. Surface the reason, run nothing.
    if (refusal && !sql) {
      responseClass = 'refusal';
      return {
        sql: '', explanation: '', refusal,
        readOnly: true, validationError: null, rowCount: null, usage: { ...used },
      };
    }
    if (!sql) throw httpError(502, 'Model returned no SQL.', undefined, 'schema_fail');

    // The model produced SQL but flagged itself as guessing. A plausible-looking
    // wrong query is worse than no query in a no-code tool, so surface the doubt
    // as a refusal instead of handing over SQL (the sql/explanation stay out of
    // the response on purpose).
    if (result.confidence === 'low') {
      responseClass = 'low_confidence';
      const why = (result.explanation || '').trim();
      return {
        sql: '',
        explanation: '',
        refusal: 'The model was not confident your schema contains this data'
          + (why ? ` (its guess: ${why})` : '')
          + '. Try rephrasing with the table or column you have in mind.',
        readOnly: true, validationError: null, rowCount: null, usage: { ...used },
      };
    }
    let explanation = result.explanation || '';

    // Plan the SQL against the live DB to catch hallucinated columns/tables.
    // On failure, feed the Postgres error back and let the model retry — small
    // models often need two rounds, and each round sees the newest error.
    validationError = await validateSql(pool, schema, sql);
    for (let round = 0; validationError && round < MAX_REPAIR_ROUNDS; round++) {
      try {
        const repaired = await call(repairMessage(userMsg, sql, validationError));
        const fixedSql = (repaired.sql || '').trim();
        if (!fixedSql) break;
        sql = fixedSql;
        explanation = repaired.explanation || explanation;
        validationError = await validateSql(pool, schema, sql);
      } catch {
        // Keep the last attempt and surface its error if the repair call fails.
        break;
      }
    }

    let readOnly = isReadOnly(sql);
    if (!cfg.allowWrites && !readOnly) {
      throw httpError(
        400,
        'The generated statement writes data, but write access is disabled.',
        'Enable write access in AI settings to allow this — then review it carefully.',
        'write_blocked',
      );
    }

    // Zero-row probe: a valid query that matches nothing is the "plausible but
    // wrong" failure the EXPLAIN check can't catch (invented filter, wrong join
    // path). Probe read-only SQL; on 0 rows give the model ONE shot to fix it,
    // and surface the count so the UI can warn when it stays at 0.
    rowCount = null;
    if (!validationError && readOnly) {
      rowCount = await countRows(pool, schema, sql);
      if (rowCount === 0) {
        try {
          const repaired = await call(zeroRowsMessage(userMsg, sql));
          const fixedSql = (repaired.sql || '').trim();
          if (fixedSql && fixedSql !== sql
              && isReadOnly(fixedSql)
              && !(await validateSql(pool, schema, fixedSql))) {
            const fixedCount = await countRows(pool, schema, fixedSql);
            // Only adopt the rewrite when it actually finds rows — otherwise
            // the original (with its 0-row warning) is the honest answer.
            if (fixedCount !== null && fixedCount > 0) {
              sql = fixedSql;
              explanation = repaired.explanation || explanation;
              rowCount = fixedCount;
              readOnly = true;
            }
          }
        } catch {
          // Probe repair is best-effort; keep the original + warning.
        }
      }
    }

    responseClass = validationError ? 'validation_fail' : 'success';
    return {
      sql, explanation, refusal: null, readOnly, validationError,
      rowCount, usage: { ...used },
    };
  } catch (err) {
    responseClass = err.responseClass || 'error';
    throw err;
  } finally {
    logTelemetry({
      requestId,
      provider: cfg?.provider,
      model: cfg?.model,
      promptVersion: PROMPT_VERSION,
      attempts,
      tokensIn: used.inputTokens || null,
      tokensOut: used.outputTokens || null,
      latencyMs: Date.now() - started,
      tablesSent,
      tablesTotal,
      rowCount,
      responseClass,
      schemaValid: responseClass !== 'schema_fail',
      validationError: validationError || undefined,
    });
  }
}

module.exports = {
  getConfig,
  setConfig,
  generateSql,
  PROVIDERS,
  // exported for tests
  isReadOnly,
  buildSchemaContext,
  buildGrounding,
  classifyPrompt,
  promptTokens,
  validateSql,
  countRows,
  extractUsage,
  zeroRowsMessage,
  buildSystemPrompt,
};
