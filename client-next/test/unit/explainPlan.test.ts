import { describe, expect, it } from 'vitest'

import {
  describeNodeType,
  heatColor,
  nodeHeat,
  parseExplainPlan,
} from '@/lib/explainPlan'

// A representative EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) root: a Hash Join
// over a Seq Scan (the slow side) and a Hash of an Index Scan, with a Sort that
// spills. Times are per-loop; the inner Index Scan loops 3×.
const ANALYZED_ROOT = {
  Plan: {
    'Node Type': 'Hash Join',
    'Join Type': 'Inner',
    'Startup Cost': 10,
    'Total Cost': 200,
    'Plan Rows': 100,
    'Plan Width': 64,
    'Actual Startup Time': 5,
    'Actual Total Time': 50,
    'Actual Rows': 90,
    'Actual Loops': 1,
    'Hash Cond': '(o.customer_id = c.id)',
    'Shared Hit Blocks': 12,
    'Shared Read Blocks': 4,
    Plans: [
      {
        'Node Type': 'Seq Scan',
        'Parent Relationship': 'Outer',
        'Relation Name': 'orders',
        Alias: 'o',
        'Startup Cost': 0,
        'Total Cost': 120,
        'Plan Rows': 5,
        'Plan Width': 32,
        'Actual Startup Time': 0,
        'Actual Total Time': 30,
        'Actual Rows': 5000,
        'Actual Loops': 1,
        Filter: "(status = 'pending'::text)",
        'Rows Removed by Filter': 1000,
      },
      {
        'Node Type': 'Hash',
        'Parent Relationship': 'Inner',
        'Startup Cost': 5,
        'Total Cost': 5,
        'Plan Rows': 50,
        'Plan Width': 32,
        'Actual Startup Time': 2,
        'Actual Total Time': 6,
        'Actual Rows': 50,
        'Actual Loops': 3,
        Plans: [
          {
            'Node Type': 'Index Scan',
            'Parent Relationship': 'Outer',
            'Relation Name': 'customers',
            Alias: 'c',
            'Index Name': 'customers_pkey',
            'Startup Cost': 0,
            'Total Cost': 4,
            'Plan Rows': 50,
            'Plan Width': 32,
            'Actual Startup Time': 0,
            'Actual Total Time': 1,
            'Actual Rows': 50,
            'Actual Loops': 3,
            'Index Cond': '(id = o.customer_id)',
          },
        ],
      },
    ],
  },
  'Planning Time': 0.42,
  'Execution Time': 51.3,
  Triggers: [],
}

// Plain EXPLAIN (FORMAT JSON) — estimates only, no actual times. This is the
// shape Postgres returns as the `QUERY PLAN` column (a single-element array).
const PLAIN_ARRAY = [
  {
    Plan: {
      'Node Type': 'Seq Scan',
      'Relation Name': 'users',
      Alias: 'users',
      'Startup Cost': 0,
      'Total Cost': 35,
      'Plan Rows': 1000,
      'Plan Width': 50,
    },
  },
]

describe('parseExplainPlan', () => {
  it('returns null for input without a recognizable plan', () => {
    expect(parseExplainPlan(null)).toBeNull()
    expect(parseExplainPlan({})).toBeNull()
    expect(parseExplainPlan('not json')).toBeNull()
    expect(parseExplainPlan([{ foo: 1 }])).toBeNull()
  })

  it('parses the root object form (server timing.plan)', () => {
    const plan = parseExplainPlan(ANALYZED_ROOT)!
    expect(plan).not.toBeNull()
    expect(plan.root.nodeType).toBe('Hash Join')
    expect(plan.analyzed).toBe(true)
    expect(plan.planningMs).toBeCloseTo(0.42)
    expect(plan.executionMs).toBeCloseTo(51.3)
  })

  it('parses the bare array form (QUERY PLAN column)', () => {
    const plan = parseExplainPlan(PLAIN_ARRAY)!
    expect(plan.root.nodeType).toBe('Seq Scan')
    expect(plan.analyzed).toBe(false)
    expect(plan.planningMs).toBeNull()
  })

  it('unwraps a { "QUERY PLAN": [...] } row and a JSON string', () => {
    const fromRow = parseExplainPlan({ 'QUERY PLAN': PLAIN_ARRAY })
    expect(fromRow?.root.nodeType).toBe('Seq Scan')
    const fromString = parseExplainPlan(JSON.stringify(PLAIN_ARRAY))
    expect(fromString?.root.nodeType).toBe('Seq Scan')
  })

  it('assigns stable pre-order ids and flattens every node', () => {
    const plan = parseExplainPlan(ANALYZED_ROOT)!
    expect(plan.nodes.map((n) => n.id)).toEqual([0, 1, 2, 3])
    expect(plan.nodes.map((n) => n.nodeType)).toEqual([
      'Hash Join',
      'Seq Scan',
      'Hash',
      'Index Scan',
    ])
  })

  it('builds a readable label for scans and index scans', () => {
    const plan = parseExplainPlan(ANALYZED_ROOT)!
    const [join, seq, , index] = plan.nodes
    expect(join.label).toBe('Hash Join')
    expect(seq.label).toBe('Seq Scan on orders as o')
    expect(index.label).toBe('Index Scan using customers_pkey on customers')
  })

  it('multiplies per-loop actual time/rows by loops for totals', () => {
    const plan = parseExplainPlan(ANALYZED_ROOT)!
    const index = plan.nodes.find((n) => n.nodeType === 'Index Scan')!
    // 1ms per loop × 3 loops = 3ms total; 50 rows per loop × 3 = 150.
    expect(index.totalMs).toBeCloseTo(3)
    expect(index.actualRowsTotal).toBe(150)
  })

  it('computes exclusive (self) time as total minus children', () => {
    const plan = parseExplainPlan(ANALYZED_ROOT)!
    const join = plan.root
    // Hash Join total = 50ms; children totals = Seq Scan 30 + Hash (6×3=18) = 48.
    // Self time = 50 - 48 = 2ms.
    const hash = plan.nodes.find((n) => n.nodeType === 'Hash')!
    expect(hash.totalMs).toBeCloseTo(18)
    expect(join.totalMs).toBeCloseTo(50)
    expect(join.exclusiveMs).toBeCloseTo(2)
  })

  it('computes exclusive cost even without ANALYZE', () => {
    const plan = parseExplainPlan(ANALYZED_ROOT)!
    const join = plan.root
    // 200 total - (120 seq + 5 hash) = 75.
    expect(join.exclusiveCost).toBeCloseTo(75)
  })

  it('flags row misestimates with direction and factor', () => {
    const plan = parseExplainPlan(ANALYZED_ROOT)!
    const seq = plan.nodes.find((n) => n.nodeType === 'Seq Scan')!
    // Estimated 5, actually returned 5000 → under-estimated 1000×.
    expect(seq.estimateDirection).toBe('under')
    expect(seq.estimateFactor).toBeCloseTo(1000)
    expect(seq.rowsRemovedByFilter).toBe(1000)
  })

  it('leaves estimate metrics null on a plain EXPLAIN', () => {
    const plan = parseExplainPlan(PLAIN_ARRAY)!
    expect(plan.root.estimateFactor).toBeNull()
    expect(plan.root.exclusiveMs).toBeNull()
    expect(plan.root.totalMs).toBeNull()
  })

  it('collects qualifier details in display order', () => {
    const plan = parseExplainPlan(ANALYZED_ROOT)!
    const seq = plan.nodes.find((n) => n.nodeType === 'Seq Scan')!
    expect(seq.details).toEqual([{ label: 'Filter', value: "(status = 'pending'::text)" }])
    const join = plan.root
    expect(join.details).toEqual([
      { label: 'Join type', value: 'Inner' },
      { label: 'Hash cond', value: '(o.customer_id = c.id)' },
    ])
  })

  it('marks the slowest node by exclusive time when analyzed', () => {
    const plan = parseExplainPlan(ANALYZED_ROOT)!
    // Seq Scan owns 30ms of self time — the largest.
    const seq = plan.nodes.find((n) => n.nodeType === 'Seq Scan')!
    expect(plan.slowestNodeId).toBe(seq.id)
  })

  it('marks the slowest node by exclusive cost when not analyzed', () => {
    const root = {
      Plan: {
        'Node Type': 'Aggregate',
        'Total Cost': 100,
        'Plan Rows': 1,
        Plans: [
          { 'Node Type': 'Seq Scan', 'Relation Name': 't', 'Total Cost': 90, 'Plan Rows': 1000 },
        ],
      },
    }
    const plan = parseExplainPlan(root)!
    const seq = plan.nodes.find((n) => n.nodeType === 'Seq Scan')!
    expect(plan.analyzed).toBe(false)
    expect(plan.slowestNodeId).toBe(seq.id)
  })

  it('treats a Never Executed node as zero-contribution', () => {
    const root = {
      Plan: {
        'Node Type': 'Nested Loop',
        'Total Cost': 10,
        'Plan Rows': 1,
        'Actual Total Time': 5,
        'Actual Rows': 0,
        'Actual Loops': 1,
        Plans: [
          {
            'Node Type': 'Index Scan',
            'Relation Name': 't',
            'Total Cost': 5,
            'Plan Rows': 1,
            'Actual Loops': 0,
            'Never Executed': true,
          },
        ],
      },
    }
    const plan = parseExplainPlan(root)!
    const idx = plan.nodes.find((n) => n.nodeType === 'Index Scan')!
    expect(idx.neverExecuted).toBe(true)
    expect(idx.totalMs).toBeNull()
    expect(idx.actualRowsTotal).toBeNull()
  })

  it('parses triggers and drops ones that never fired', () => {
    const root = {
      Plan: { 'Node Type': 'Insert', 'Total Cost': 1, 'Plan Rows': 1 },
      Triggers: [
        { 'Trigger Name': 'audit', Relation: 't', Calls: 3, Time: 1.5 },
        { 'Trigger Name': 'noop', Relation: 't', Calls: 0, Time: 0 },
      ],
    }
    const plan = parseExplainPlan(root)!
    expect(plan.triggers).toHaveLength(1)
    expect(plan.triggers[0]).toMatchObject({ name: 'audit', calls: 3, timeMs: 1.5 })
  })
})

describe('nodeHeat / heatColor', () => {
  it('scales time heat by exclusive time over the plan max', () => {
    const plan = parseExplainPlan(ANALYZED_ROOT)!
    const seq = plan.nodes.find((n) => n.nodeType === 'Seq Scan')!
    // Seq Scan is the slowest exclusive node, so its time heat is 1.
    expect(nodeHeat(seq, plan, 'time')).toBeCloseTo(1)
    expect(nodeHeat(plan.root, plan, 'time')).toBeLessThan(1)
    expect(nodeHeat(seq, plan, 'none')).toBe(0)
  })

  it('falls back to plan rows for the rows metric without actuals', () => {
    const plan = parseExplainPlan(PLAIN_ARRAY)!
    expect(nodeHeat(plan.root, plan, 'rows')).toBeCloseTo(1)
  })

  it('returns a color only above the low-contribution threshold', () => {
    expect(heatColor(0)).toBeNull()
    expect(heatColor(0.01)).toBeNull()
    expect(heatColor(1)).toMatch(/^hsl\(/)
    // Hotter fractions trend toward red (hue 0).
    expect(heatColor(1)).toBe('hsl(0, 75%, 45%)')
  })
})

describe('describeNodeType', () => {
  it('describes known node types', () => {
    expect(describeNodeType('Seq Scan')).toMatch(/every row/i)
    expect(describeNodeType('Hash Join')).toMatch(/hash table/i)
  })

  it('falls back gracefully for unknown node types', () => {
    expect(describeNodeType('Frobnicate')).toBe('A "Frobnicate" plan node.')
  })
})
