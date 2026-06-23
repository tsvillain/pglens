/**
 * Unit tests for EXPLAIN ANALYZE timing extraction (roadmap §5.4).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { extractExplainTiming } = require('../../src/db/explain');

// A FORMAT JSON plan row as porsager returns it (json column already parsed).
const planRow = (over = {}) => [{
  'QUERY PLAN': [{
    Plan: { 'Node Type': 'Seq Scan', 'Relation Name': 't' },
    'Planning Time': 0.42,
    'Execution Time': 3.14,
    ...over,
  }],
}];

test('extracts planning and execution time from a parsed plan', () => {
  const t = extractExplainTiming(planRow());
  assert.equal(t.planningMs, 0.42);
  assert.equal(t.executionMs, 3.14);
  assert.equal(t.plan.Plan['Node Type'], 'Seq Scan');
});

test('parses a plan delivered as a JSON string', () => {
  const rows = [{ 'QUERY PLAN': JSON.stringify(planRow()[0]['QUERY PLAN']) }];
  const t = extractExplainTiming(rows);
  assert.equal(t.planningMs, 0.42);
  assert.equal(t.executionMs, 3.14);
});

test('missing timing fields degrade to null', () => {
  const rows = [{ 'QUERY PLAN': [{ Plan: {} }] }];
  const t = extractExplainTiming(rows);
  assert.equal(t.planningMs, null);
  assert.equal(t.executionMs, null);
  assert.deepEqual(t.plan, { Plan: {} });
});

test('empty or malformed input is safe', () => {
  for (const bad of [null, undefined, [], [{}], [{ 'QUERY PLAN': 'not json' }]]) {
    assert.deepEqual(extractExplainTiming(bad), {
      planningMs: null,
      executionMs: null,
      plan: null,
    });
  }
});
