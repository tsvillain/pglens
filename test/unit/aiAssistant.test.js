const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isReadOnly, buildSchemaContext, buildGrounding, classifyPrompt,
  validateSql, countRows, extractUsage, zeroRowsMessage, buildSystemPrompt,
  renderSampleRow, isSensitiveColumn, RESULT_SCHEMA, compileRedactRules, mentionsRedacted,
  generateSql,
} = require('../../src/ai/assistant');

// Fake pool over a 4-table schema: Dispute -> Project (FK), plus two unrelated
// tables. Order-independent SQL matching, like the other fakes in this file.
function fakePool() {
  return {
    query: async (sql) => {
      if (/information_schema\.columns/.test(sql)) {
        return {
          rows: [
            { table_name: 'Dispute', column_name: 'id', data_type: 'text', udt_name: 'text', is_nullable: 'NO' },
            { table_name: 'Dispute', column_name: 'projectId', data_type: 'text', udt_name: 'text', is_nullable: 'YES' },
            { table_name: 'Dispute', column_name: 'status', data_type: 'text', udt_name: 'text', is_nullable: 'YES' },
            { table_name: 'Project', column_name: 'id', data_type: 'text', udt_name: 'text', is_nullable: 'NO' },
            { table_name: 'Coupon', column_name: 'id', data_type: 'text', udt_name: 'text', is_nullable: 'NO' },
            { table_name: 'Payment', column_name: 'id', data_type: 'text', udt_name: 'text', is_nullable: 'NO' },
          ],
        };
      }
      if (/PRIMARY KEY/.test(sql)) return { rows: [] };
      if (/FOREIGN KEY/.test(sql)) {
        return { rows: [{ table_name: 'Dispute', column_name: 'projectId', ftable: 'Project', fcol: 'id' }] };
      }
      // Sample-row fetches (SELECT * FROM ... LIMIT n).
      if (/^SELECT \* FROM/.test(sql)) {
        return { rows: [{ id: 'du_1', status: 'lost' }] };
      }
      if (/pg_enum/.test(sql)) return { rows: [] };
      if (/pg_stats/.test(sql)) {
        return { rows: [{ tablename: 'Dispute', attname: 'status', vals: ['lost', 'won'] }] };
      }
      throw new Error('unexpected query');
    },
  };
}

test('isReadOnly accepts SELECT and CTE-SELECT', () => {
  assert.equal(isReadOnly('SELECT * FROM users'), true);
  assert.equal(isReadOnly('select id, name from users where active'), true);
  assert.equal(isReadOnly('WITH t AS (SELECT 1) SELECT * FROM t'), true);
  assert.equal(isReadOnly('SELECT count(*) FROM orders;'), true);
});

test('isReadOnly rejects writes and DDL', () => {
  assert.equal(isReadOnly('UPDATE users SET active = false'), false);
  assert.equal(isReadOnly('DELETE FROM users'), false);
  assert.equal(isReadOnly('INSERT INTO users (id) VALUES (1)'), false);
  assert.equal(isReadOnly('DROP TABLE users'), false);
  assert.equal(isReadOnly('TRUNCATE users'), false);
  // CTE that hides a write must still be rejected.
  assert.equal(
    isReadOnly('WITH d AS (DELETE FROM users RETURNING *) SELECT * FROM d'),
    false,
  );
});

test('isReadOnly rejects an empty or comment-only script', () => {
  assert.equal(isReadOnly(''), false);
  assert.equal(isReadOnly('-- just a comment'), false);
});

test('isReadOnly rejects a mixed multi-statement script', () => {
  assert.equal(isReadOnly('SELECT 1; DELETE FROM users'), false);
});

test('buildSchemaContext renders tables with PK/FK/NOT NULL', async () => {
  // Fake pool: returns canned rows by matching the SQL text. The three queries
  // run via Promise.all, so order-independent matching keeps this robust.
  const pool = {
    query: async (sql) => {
      if (/information_schema\.columns/.test(sql)) {
        return {
          rows: [
            { table_name: 'users', column_name: 'id', data_type: 'integer', udt_name: 'int4', is_nullable: 'NO' },
            { table_name: 'users', column_name: 'email', data_type: 'character varying', udt_name: 'varchar', is_nullable: 'NO' },
            { table_name: 'orders', column_name: 'id', data_type: 'integer', udt_name: 'int4', is_nullable: 'NO' },
            { table_name: 'orders', column_name: 'user_id', data_type: 'integer', udt_name: 'int4', is_nullable: 'YES' },
          ],
        };
      }
      if (/PRIMARY KEY/.test(sql)) {
        return { rows: [{ table_name: 'users', column_name: 'id' }, { table_name: 'orders', column_name: 'id' }] };
      }
      if (/FOREIGN KEY/.test(sql)) {
        return { rows: [{ table_name: 'orders', column_name: 'user_id', ftable: 'users', fcol: 'id' }] };
      }
      throw new Error('unexpected query');
    },
  };

  const text = await buildSchemaContext(pool, 'public', undefined);
  assert.match(text, /TABLE users \(/);
  assert.match(text, /id int4 NOT NULL PK/);
  assert.match(text, /email varchar NOT NULL/);
  assert.match(text, /user_id int4 FK -> users\.id/);
});

test('buildSchemaContext quotes mixed-case identifiers', async () => {
  const pool = {
    query: async (sql) => {
      if (/information_schema\.columns/.test(sql)) {
        return {
          rows: [
            { table_name: 'Dispute', column_name: 'id', data_type: 'text', udt_name: 'text', is_nullable: 'NO' },
            { table_name: 'Dispute', column_name: 'projectId', data_type: 'text', udt_name: 'text', is_nullable: 'YES' },
          ],
        };
      }
      if (/PRIMARY KEY/.test(sql)) return { rows: [{ table_name: 'Dispute', column_name: 'id' }] };
      if (/FOREIGN KEY/.test(sql)) {
        return { rows: [{ table_name: 'Dispute', column_name: 'projectId', ftable: 'Project', fcol: 'id' }] };
      }
      throw new Error('unexpected query');
    },
  };

  const text = await buildSchemaContext(pool, 'public', undefined);
  assert.match(text, /TABLE "Dispute" \(/);
  assert.match(text, /"projectId" text FK -> "Project"\.id/);
  // simple lower-case names stay bare
  assert.match(text, /\n {2}id text NOT NULL PK/);
});

test('validateSql returns the Postgres error for an unplannable query', async () => {
  const pool = {
    explain: async () => {
      throw new Error('column s.type does not exist');
    },
  };
  assert.equal(
    await validateSql(pool, 'public', 'SELECT s.type FROM "Subscription" s'),
    'column s.type does not exist',
  );
});

test('validateSql returns null when the query plans', async () => {
  const pool = { explain: async () => ({ rows: [] }) };
  assert.equal(await validateSql(pool, 'public', 'SELECT 1'), null);
});

test('validateSql skips multi-statement and non-explainable scripts', async () => {
  let explainCalls = 0;
  const pool = { explain: async () => { explainCalls += 1; return { rows: [] }; } };
  assert.equal(await validateSql(pool, 'public', 'SELECT 1; SELECT 2'), null);
  assert.equal(await validateSql(pool, 'public', 'SHOW search_path'), null);
  assert.equal(explainCalls, 0);
});

test('buildGrounding prunes to prompt-relevant tables plus FK neighbors', async () => {
  const g = await buildGrounding(fakePool(), 'public', {
    prompt: 'list all the disputes i lost',
  });
  // "disputes" → Dispute (scored) + Project (FK neighbor); unrelated tables cut.
  assert.match(g.text, /TABLE "Dispute" \(/);
  assert.match(g.text, /TABLE "Project" \(/);
  assert.doesNotMatch(g.text, /TABLE "Coupon"/);
  assert.doesNotMatch(g.text, /TABLE "Payment"/);
  assert.equal(g.tableCount, 2);
  assert.equal(g.totalTables, 4);
  assert.equal(g.exampleTable, 'Dispute');
  // Pruned-out tables still appear as a names-only directory, so the model can
  // point at a better table instead of guessing against the wrong one.
  assert.match(g.text, /Other tables in this schema/);
  assert.match(g.text, /Coupon/);
  assert.match(g.text, /Payment/);
});

test('buildGrounding omits the directory when nothing was pruned', async () => {
  const g = await buildGrounding(fakePool(), 'public', {
    prompt: 'show me everything from last week', // no scores → all tables rendered
  });
  assert.doesNotMatch(g.text, /Other tables in this schema/);
});

test('buildGrounding samples rows for prompt-scored tables', async () => {
  const g = await buildGrounding(fakePool(), 'public', {
    prompt: 'list all the disputes i lost',
  });
  // Top-scored table gets real rows so filter values (status='lost') are
  // grounded in seen data, not guessed.
  assert.match(g.text, /Sample rows from "Dispute":/);
  assert.match(g.text, /"status":"lost"/);
});

test('buildGrounding samples nothing without a scored prompt or focus table', async () => {
  const g = await buildGrounding(fakePool(), 'public', {
    prompt: 'show me everything from last week',
  });
  assert.doesNotMatch(g.text, /Sample rows from/);
});

test('buildGrounding falls back to all tables when nothing scores', async () => {
  const g = await buildGrounding(fakePool(), 'public', {
    prompt: 'show me everything from last week',
  });
  assert.equal(g.tableCount, 4);
});

test('classifyPrompt rejects clear off-topic, keeps data questions', async () => {
  const { schemaTokens } = await buildGrounding(fakePool(), 'public', {});
  assert.equal(classifyPrompt('create hello world in python', schemaTokens), 'off_topic');
  assert.equal(classifyPrompt('write a javascript function for me', schemaTokens), 'off_topic');
  assert.equal(classifyPrompt('list all the disputes i lost', schemaTokens), 'db');
  // Mentions a language but shares vocabulary with the schema → data question.
  assert.equal(classifyPrompt('disputes with status python', schemaTokens), 'db');
  // Plain data questions never match the off-topic patterns at all.
  assert.equal(classifyPrompt('total revenue by month', schemaTokens), 'db');
});

test('prefix matching finds Subscription from "subscribers"', async () => {
  const pool = {
    query: async (sql) => {
      if (/information_schema\.columns/.test(sql)) {
        return {
          rows: [
            { table_name: 'Subscription', column_name: 'id', data_type: 'text', udt_name: 'text', is_nullable: 'NO' },
            { table_name: 'Coupon', column_name: 'id', data_type: 'text', udt_name: 'text', is_nullable: 'NO' },
          ],
        };
      }
      if (/PRIMARY KEY|FOREIGN KEY/.test(sql)) return { rows: [] };
      if (/^SELECT \* FROM/.test(sql)) return { rows: [] };
      throw new Error('unexpected query');
    },
  };
  const g = await buildGrounding(pool, 'public', { prompt: 'last 10 subscribers and how much they paid' });
  assert.match(g.text, /TABLE "Subscription" \(/);
  assert.doesNotMatch(g.text, /TABLE "Coupon" \(/);
});

// Pool factory for the value-grounding tests: one `things` table whose columns
// and enum/stats rows are injectable.
function valuesPool({ columns, enums = [], stats = [] }) {
  return {
    query: async (sql) => {
      if (/information_schema\.columns/.test(sql)) return { rows: columns };
      if (/PRIMARY KEY|FOREIGN KEY/.test(sql)) return { rows: [] };
      if (/pg_enum/.test(sql)) return { rows: enums };
      if (/pg_stats/.test(sql)) return { rows: stats };
      if (/^SELECT \* FROM/.test(sql)) return { rows: [] };
      throw new Error('unexpected query');
    },
  };
}

test('buildGrounding renders enum labels inline on the column line', async () => {
  const pool = valuesPool({
    columns: [
      { table_name: 'Dispute', column_name: 'id', data_type: 'text', udt_name: 'text', is_nullable: 'NO' },
      { table_name: 'Dispute', column_name: 'status', data_type: 'USER-DEFINED', udt_name: 'dispute_status', is_nullable: 'NO' },
    ],
    enums: [
      { typname: 'dispute_status', enumlabel: 'open' },
      { typname: 'dispute_status', enumlabel: 'lost' },
      { typname: 'dispute_status', enumlabel: 'won' },
    ],
  });
  const g = await buildGrounding(pool, 'public', {});
  assert.match(g.text, /status dispute_status NOT NULL \[values: 'open', 'lost', 'won'\]/);
});

test('buildGrounding renders pg_stats common values for low-cardinality text columns', async () => {
  const g = await buildGrounding(fakePool(), 'public', {});
  assert.match(g.text, /status text \[values: 'lost', 'won'\]/);
});

test('value lists are capped at 10 and SQL-quote-escaped', async () => {
  const vals = ["it's", 'v02', 'v03', 'v04', 'v05', 'v06', 'v07', 'v08', 'v09', 'v10', 'v11', 'v12'];
  const pool = valuesPool({
    columns: [
      { table_name: 'things', column_name: 'kind', data_type: 'text', udt_name: 'text', is_nullable: 'YES' },
    ],
    stats: [{ tablename: 'things', attname: 'kind', vals }],
  });
  const g = await buildGrounding(pool, 'public', {});
  assert.match(g.text, /\[values: 'it''s', 'v02'.*'v10', …\]/);
  assert.doesNotMatch(g.text, /'v11'/);
});

test('pg_stats values on non-text columns are skipped', async () => {
  const pool = valuesPool({
    columns: [
      { table_name: 'things', column_name: 'qty', data_type: 'integer', udt_name: 'int4', is_nullable: 'YES' },
    ],
    stats: [{ tablename: 'things', attname: 'qty', vals: ['1', '2', '3'] }],
  });
  const g = await buildGrounding(pool, 'public', {});
  assert.doesNotMatch(g.text, /\[values:/);
});

test('grounding still builds when enum/stats introspection fails', async () => {
  const pool = valuesPool({
    columns: [
      { table_name: 'things', column_name: 'kind', data_type: 'text', udt_name: 'text', is_nullable: 'YES' },
    ],
  });
  const base = pool.query;
  pool.query = async (sql) => {
    if (/pg_enum|pg_stats/.test(sql)) throw new Error('permission denied');
    return base(sql);
  };
  const g = await buildGrounding(pool, 'public', {});
  assert.match(g.text, /TABLE things \(/);
  assert.doesNotMatch(g.text, /\[values:/);
});

test('zeroRowsMessage points the model at grounded values', () => {
  const msg = zeroRowsMessage('Request: cancelled orders', "SELECT 1 WHERE status = 'canceled'");
  assert.match(msg, /\[values: …\]/);
  assert.match(msg, /ILIKE/);
  assert.match(msg, /SELECT 1 WHERE status = 'canceled'/);
});

test('buildSystemPrompt carries the value-grounding contract', () => {
  const sys = buildSystemPrompt({
    schema: 'public', schemaText: 'TABLE users (\n  id int4\n)', allowWrites: false, exampleTable: 'users',
  });
  assert.match(sys, /\[values: …\]/);
  assert.match(sys, /ILIKE/);
  // Renumbering regression guards: read-only rule and JSON-reply rule survive.
  assert.match(sys, /8\. READ-ONLY/);
  assert.match(sys, /10\. Reply with ONLY this JSON/);
});

test('countRows wraps the statement and returns the live count', async () => {
  const queries = [];
  const pool = {
    transaction: async (handler) => handler({
      query: async (sql) => {
        queries.push(sql);
        if (/SELECT count\(\*\)/.test(sql)) return { rows: [{ n: '0' }] };
        return { rows: [] };
      },
    }),
  };
  const n = await countRows(pool, 'public', 'SELECT * FROM "Dispute" WHERE status = \'nope\'');
  assert.equal(n, 0);
  assert.ok(queries.some((q) => /statement_timeout/.test(q)));
  assert.ok(queries.some((q) => /FROM \(SELECT \* FROM "Dispute"/.test(q)));
});

test('countRows returns null for writes, multi-statement, and probe errors', async () => {
  const pool = { transaction: async () => { throw new Error('timeout'); } };
  assert.equal(await countRows(pool, 'public', 'DELETE FROM "Dispute"'), null);
  assert.equal(await countRows(pool, 'public', 'SELECT 1; SELECT 2'), null);
  assert.equal(await countRows(pool, 'public', 'SELECT * FROM "Dispute"'), null);
});

test('extractUsage normalizes each provider token block', () => {
  assert.deepEqual(
    extractUsage('anthropic', { usage: { input_tokens: 1840, output_tokens: 312 } }),
    { inputTokens: 1840, outputTokens: 312 },
  );
  assert.deepEqual(
    extractUsage('openai', { usage: { prompt_tokens: 900, completion_tokens: 50 } }),
    { inputTokens: 900, outputTokens: 50 },
  );
  assert.deepEqual(
    extractUsage('ollama', { prompt_eval_count: 700, eval_count: 120 }),
    { inputTokens: 700, outputTokens: 120 },
  );
  // Missing usage → nulls, never throws.
  assert.deepEqual(extractUsage('openai', {}), { inputTokens: null, outputTokens: null });
});

test('isReadOnly rejects SELECT INTO and side-effecting built-ins', () => {
  for (const sql of [
    'SELECT * INTO backup FROM users',
    'SELECT pg_terminate_backend(pid) FROM pg_stat_activity',
    'SELECT pg_cancel_backend(42)',
    "SELECT setval('orders_id_seq', 1)",
    "SELECT nextval('orders_id_seq')",
    'SELECT lo_unlink(16400)',
    "SELECT * FROM dblink('host=evil', 'select 1') AS t(x int)",
    "SELECT dblink_connect('host=evil')",
    "SELECT pg_read_file('/etc/passwd')",
    "SELECT * FROM pg_ls_dir('.')",
    'SELECT pg_sleep(10)',
    "SELECT set_config('search_path', 'x', false)",
    'SELECT pg_advisory_lock(1)',
    'WITH x AS (SELECT 1) SELECT pg_reload_conf() FROM x',
  ]) {
    assert.equal(isReadOnly(sql), false, sql);
  }
  // Names that only contain a denied word stay readable.
  assert.equal(isReadOnly('SELECT setval_count, lo_total FROM stats'), true);
});

test('countRows runs in a READ ONLY transaction and refuses unsafe SQL', async () => {
  const queries = [];
  const pool = {
    transaction: async (handler) => handler({
      query: async (sql) => {
        queries.push(sql);
        if (/SELECT count\(\*\)/.test(sql)) return { rows: [{ n: '3' }] };
        return { rows: [] };
      },
    }),
  };
  assert.equal(await countRows(pool, 'public', 'SELECT * FROM "Dispute"'), 3);
  assert.equal(queries[0], 'SET TRANSACTION READ ONLY');

  queries.length = 0;
  assert.equal(
    await countRows(pool, 'public', 'SELECT pg_terminate_backend(pid) FROM pg_stat_activity'),
    null,
  );
  assert.equal(await countRows(pool, 'public', 'SELECT * INTO t2 FROM t'), null);
  assert.deepEqual(queries, [], 'nothing reaches the database');
});

test('isSensitiveColumn catches credential-like names', () => {
  for (const c of ['password', 'password_hash', 'apiKey', 'refresh-token', 'mfa_secret', 'card_number']) {
    assert.equal(isSensitiveColumn(c), true, c);
  }
  for (const c of ['id', 'email', 'status', 'created_at', 'fullName']) {
    assert.equal(isSensitiveColumn(c), false, c);
  }
});

test('renderSampleRow redacts secrets, collapses bytea and clips the line', () => {
  const line = renderSampleRow({
    id: 1,
    password_hash: '$2b$10$abc',
    avatar: Buffer.alloc(50_000, 7),
    doc: { items: Array.from({ length: 2000 }, (_, i) => i) },
  });
  assert.ok(line.includes('"password_hash":"[redacted]"'));
  assert.ok(line.includes('<binary 50000 bytes>'));
  assert.ok(!line.includes('$2b$10$abc'));
  assert.ok(line.length <= 501);
});

test('buildGrounding with shareData off sends no samples or common values', async () => {
  const g = await buildGrounding(fakePool(), 'public', {
    prompt: 'disputes by status', shareData: false,
  });
  assert.ok(!/Sample rows/.test(g.text));
  assert.ok(!/\[values:/.test(g.text));
});

test('RESULT_SCHEMA uses anyOf for nullable fields', () => {
  for (const f of ['sql', 'refusal']) {
    assert.deepEqual(RESULT_SCHEMA.properties[f].anyOf, [{ type: 'string' }, { type: 'null' }]);
  }
});

test('compileRedactRules matches tables, table.column and *.column, case-insensitively', () => {
  const isRedacted = compileRedactRules(['Payments', 'users.email', '*.phone']);
  assert.equal(isRedacted('payments'), true);
  assert.equal(isRedacted('payments', 'amount'), true);
  assert.equal(isRedacted('Users', 'Email'), true);
  assert.equal(isRedacted('orders', 'email'), false);
  assert.equal(isRedacted('orders', 'phone'), true);
  assert.equal(isRedacted('users'), false, 'a column rule does not hide the table');
  assert.equal(isRedacted('users', 'password_hash'), true, 'built-in check still applies');
  assert.equal(isRedacted('users', 'id'), false);
});

test('mentionsRedacted drops queries naming a redacted table or column', () => {
  const rules = ['payments', 'users.email', '*.phone'];
  assert.equal(mentionsRedacted('SELECT * FROM payments', rules), true);
  assert.equal(mentionsRedacted("SELECT id FROM users WHERE email = 'a@b.c'", rules), true);
  assert.equal(mentionsRedacted('SELECT "phone" FROM t', rules), true);
  assert.equal(mentionsRedacted('SELECT id FROM users', rules), false);
  assert.equal(mentionsRedacted('SELECT payments_total FROM t', rules), false, 'whole words only');
});

test('buildGrounding: a redacted table gets no samples or values', async () => {
  const g = await buildGrounding(fakePool(), 'public', {
    prompt: 'disputes by status', redact: ['dispute'],
  });
  assert.ok(/TABLE "Dispute"/.test(g.text), 'names are still sent');
  assert.ok(!/Sample rows from "Dispute"/.test(g.text));
  assert.ok(!/'lost'/.test(g.text));
});

test('buildGrounding: a redacted column is masked in samples and has no value list', async () => {
  const g = await buildGrounding(fakePool(), 'public', {
    prompt: 'disputes by status', redact: ['*.status'],
  });
  assert.ok(/Sample rows from "Dispute"/.test(g.text));
  assert.ok(/"status":"\[redacted\]"/.test(g.text));
  assert.ok(!/'lost'/.test(g.text));
});

test('generateSql keeps low-confidence SQL and returns the guess as an assumption', async (t) => {
  const reply = {
    sql: 'SELECT * FROM "Dispute" WHERE status = \'lost\'',
    explanation: "No 'closed' status exists, so 'lost' is treated as closed.",
    refusal: null,
    confidence: 'low',
  };
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    json: async () => ({ message: { content: JSON.stringify(reply) } }),
  }));
  const pool = {
    ...fakePool(),
    explain: async () => ({ rows: [] }),
    transaction: async (handler) => handler({
      query: async (sql) => (/count\(\*\)/.test(sql) ? { rows: [{ n: '2' }] } : { rows: [] }),
    }),
  };
  const r = await generateSql({
    pool, schema: 'public', prompt: 'closed disputes',
    configOverride: { provider: 'ollama', available: true },
  });
  assert.equal(r.sql, reply.sql);
  assert.equal(r.refusal, null);
  assert.equal(r.assumption, reply.explanation);
  assert.equal(r.rowCount, 2);
  assert.deepEqual(r.meta.calls.map((c) => c.reason), ['initial']);
  assert.equal(r.meta.provider, 'ollama');
  assert.deepEqual(r.meta.sent.sampledTables, ['Dispute', 'Project']);
  assert.deepEqual(r.meta.hidden, { tables: [], columns: [] });
});

test('generateSql: assumption follows the SQL a zero-row rewrite replaces', async (t) => {
  const replies = [
    { sql: 'SELECT * FROM "Dispute" WHERE status = \'open\'', explanation: 'first guess', refusal: null, confidence: 'low' },
    { sql: 'SELECT * FROM "Dispute" WHERE status = \'lost\'', explanation: 'second guess', refusal: null, confidence: 'low' },
  ];
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    json: async () => ({ model: 'llama3.1', message: { content: JSON.stringify(replies.shift()) } }),
  }));
  let probes = 0;
  const pool = {
    ...fakePool(),
    explain: async () => ({ rows: [] }),
    transaction: async (handler) => handler({
      query: async (sql) => (/count\(\*\)/.test(sql) ? { rows: [{ n: probes++ ? '4' : '0' }] } : { rows: [] }),
    }),
  };
  const r = await generateSql({
    pool, schema: 'public', prompt: 'closed disputes',
    configOverride: { provider: 'ollama', available: true, redact: ['*.status'] },
  });
  assert.match(r.sql, /'lost'/);
  assert.equal(r.assumption, 'second guess');
  assert.deepEqual(r.meta.calls, [
    { reason: 'initial', model: 'llama3.1' },
    { reason: 'fix_zero_rows', model: 'llama3.1', kept: true },
  ]);
  assert.deepEqual(r.meta.hidden.columns, ['Dispute.status']);
});

test('generateSql works on runtimes without AbortSignal.any (Node < 18.17)', async (t) => {
  const original = AbortSignal.any;
  AbortSignal.any = undefined;
  t.after(() => { AbortSignal.any = original; });
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    json: async () => ({
      message: { content: JSON.stringify({ sql: 'SELECT 1', explanation: 'x', refusal: null, confidence: 'high' }) },
    }),
  }));
  const pool = {
    ...fakePool(),
    explain: async () => ({ rows: [] }),
    transaction: async (handler) => handler({ query: async () => ({ rows: [{ n: '1' }] }) }),
  };
  const r = await generateSql({
    pool, schema: 'public', prompt: 'count disputes',
    configOverride: { provider: 'ollama', available: true },
    signal: new AbortController().signal,
  });
  assert.equal(r.sql, 'SELECT 1');
});
