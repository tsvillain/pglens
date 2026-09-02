/**
 * Eval cases for the AI NL→SQL harness. Each case:
 *   id         `group-name` — the prefix before the first `-` buckets the
 *              summary by trap group (enum/case/plural/latest/join/agg/refusal…)
 *   prompt     what a non-technical user would type
 *   golden     SQL whose RESULT SET defines a pass (values compared, aliases
 *              ignored; extra/missing columns fail by design — a user sees
 *              wrong columns as a wrong answer)
 *   expect     'refusal' — pass iff the pipeline refuses instead of guessing
 *   ordered    compare rows in order (for "last N" style prompts)
 *   focusTable simulate the panel being open on a table
 *
 * Goldens prefer count(*)/explicit columns where projection ambiguity would
 * make grading unfair; SELECT * goldens are used where any reasonable answer
 * is also SELECT *.
 */
module.exports = [
  // Enum spelling traps — the type stores British 'cancelled'.
  { id: 'enum-british', prompt: 'show me all cancelled orders',
    golden: "SELECT * FROM orders WHERE status = 'cancelled'" },
  { id: 'enum-american', prompt: 'orders that were canceled',
    golden: "SELECT * FROM orders WHERE status = 'cancelled'" },
  { id: 'enum-count', prompt: 'how many orders are paid',
    golden: "SELECT count(*) FROM orders WHERE status = 'paid'" },
  { id: 'enum-multi', prompt: 'orders that are pending or paid',
    golden: "SELECT * FROM orders WHERE status IN ('pending', 'paid')" },

  // Case-sensitivity traps — names stored as 'JOHN CARTER', 'john doe'.
  { id: 'case-name-caps', prompt: 'orders for john carter',
    golden: 'SELECT o.* FROM orders o JOIN "Customer" c ON c.id = o.customer_id'
      + ' WHERE c."fullName" ILIKE \'%john carter%\'' },
  { id: 'case-name-lower', prompt: 'what is the email of John Doe',
    golden: 'SELECT email FROM "Customer" WHERE "fullName" ILIKE \'%john doe%\'' },
  { id: 'case-city', prompt: 'customers in mumbai',
    golden: 'SELECT * FROM "Customer" WHERE city ILIKE \'%mumbai%\'' },

  // Plural/singular traps — table is `subscription`, prompts say "subscriptions".
  { id: 'plural-sub-count', prompt: 'how many active subscriptions are there',
    golden: "SELECT count(*) FROM subscription WHERE state = 'active'" },
  { id: 'plural-sub-paused', prompt: 'list paused subscriptions',
    golden: "SELECT * FROM subscription WHERE state = 'paused'" },
  { id: 'plural-sub-plan', prompt: 'how many customers are on the enterprise plan',
    golden: "SELECT count(*) FROM subscription WHERE plan = 'enterprise'" },

  // Value-guess trap — state is 'past_due', not 'past due'/'overdue'.
  { id: 'value-pastdue', prompt: 'subscriptions that are past due',
    golden: "SELECT * FROM subscription WHERE state = 'past_due'" },

  // "last/latest N" semantics.
  { id: 'latest-orders', prompt: 'last 5 orders', ordered: true,
    golden: 'SELECT * FROM orders ORDER BY created_at DESC LIMIT 5' },
  { id: 'latest-customers', prompt: 'newest 3 customers', ordered: true,
    golden: 'SELECT * FROM "Customer" ORDER BY "createdAt" DESC LIMIT 3' },

  // Mixed-case identifier quoting.
  { id: 'quote-count', prompt: 'how many customers do we have',
    golden: 'SELECT count(*) FROM "Customer"' },

  // Joins + aggregates.
  { id: 'join-orders-by-name', prompt: 'how many orders did priya sharma place',
    golden: 'SELECT count(*) FROM orders o JOIN "Customer" c ON c.id = o.customer_id'
      + ' WHERE c."fullName" ILIKE \'%priya%\'' },
  { id: 'join-products-order', prompt: 'list the products in order 5',
    golden: 'SELECT product FROM order_items WHERE order_id = 5' },
  { id: 'agg-revenue-city', prompt: 'total order revenue per city',
    golden: 'SELECT c.city, sum(o.total) FROM orders o'
      + ' JOIN "Customer" c ON c.id = o.customer_id GROUP BY c.city' },
  { id: 'agg-shipped-revenue', prompt: 'total revenue from shipped orders',
    golden: "SELECT sum(total) FROM orders WHERE status = 'shipped'" },
  { id: 'agg-top3-spenders', prompt: 'top 3 customers by total order value', ordered: true,
    golden: 'SELECT c."fullName", sum(o.total) FROM orders o'
      + ' JOIN "Customer" c ON c.id = o.customer_id'
      + ' GROUP BY c."fullName" ORDER BY sum(o.total) DESC LIMIT 3' },
  { id: 'count-items', prompt: 'how many order items are there',
    golden: 'SELECT count(*) FROM order_items' },

  // Relative date.
  { id: 'date-recent', prompt: 'orders from the last 30 days',
    golden: "SELECT * FROM orders WHERE created_at >= now() - interval '30 days'" },

  // Legitimately-empty result: the pipeline must not "fix" a correct query
  // into a wrong non-empty one (max order total in the fixture is ~262).
  { id: 'empty-legit', prompt: 'orders over $10000',
    golden: 'SELECT * FROM orders WHERE total > 10000' },

  // Refusals — guessing here is worse than declining.
  { id: 'refusal-offtopic', prompt: 'write a python script that sorts a list',
    expect: 'refusal' },
  { id: 'refusal-churn', prompt: 'average churn rate per cohort',
    expect: 'refusal' },
  { id: 'refusal-invoices', prompt: 'show all invoices from march',
    expect: 'refusal' },
];
