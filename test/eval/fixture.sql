-- Throwaway schema for the AI NL→SQL eval harness (test/eval/run.js).
-- Deliberate traps mirror the failures seen in real-world testing:
--   * enum with the British spelling 'cancelled' (prompts say "canceled")
--   * mixed-case table/columns that only resolve when double-quoted
--   * case-varied people names ('JOHN CARTER', 'john doe') — plain = misses
--   * low-cardinality text columns (city, plan, state) as pg_stats MCV sources
--   * singular table name `subscription` while prompts say "subscriptions"
-- Deterministic seed; safe to re-apply (drops the schema first).

DROP SCHEMA IF EXISTS ai_eval CASCADE;
CREATE SCHEMA ai_eval;
SET search_path TO ai_eval;

CREATE TYPE order_status AS ENUM ('pending', 'paid', 'shipped', 'cancelled');

CREATE TABLE "Customer" (
  id serial PRIMARY KEY,
  "fullName" text NOT NULL,
  email text NOT NULL,
  city text,
  "createdAt" timestamptz NOT NULL
);

CREATE TABLE orders (
  id serial PRIMARY KEY,
  customer_id int NOT NULL REFERENCES "Customer"(id),
  status order_status NOT NULL,
  total numeric(10,2) NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE order_items (
  id serial PRIMARY KEY,
  order_id int NOT NULL REFERENCES orders(id),
  product text NOT NULL,
  qty int NOT NULL,
  unit_price numeric(10,2) NOT NULL
);

CREATE TABLE subscription (
  id serial PRIMARY KEY,
  customer_id int NOT NULL REFERENCES "Customer"(id),
  plan text NOT NULL,
  state text NOT NULL,
  started_at date NOT NULL
);

-- Three hand-written trap customers, then deterministic filler.
INSERT INTO "Customer" ("fullName", email, city, "createdAt") VALUES
  ('JOHN CARTER',  'john.carter@example.com', 'Austin', '2026-01-05 09:00:00+00'),
  ('john doe',     'jdoe@example.com',        'Berlin', '2026-02-11 09:00:00+00'),
  ('Priya Sharma', 'priya@example.com',       'Mumbai', '2026-03-20 09:00:00+00');
INSERT INTO "Customer" ("fullName", email, city, "createdAt")
SELECT 'Customer ' || i,
       'customer' || i || '@example.com',
       (ARRAY['Mumbai', 'Berlin', 'Austin'])[((i - 1) % 3) + 1],
       timestamptz '2026-01-01 09:00:00+00' + (i || ' days')::interval
FROM generate_series(4, 20) i;

INSERT INTO orders (customer_id, status, total, created_at)
SELECT ((i - 1) % 20) + 1,
       (ARRAY['pending', 'paid', 'shipped', 'cancelled'])[((i - 1) % 4) + 1]::order_status,
       round((37.50 * ((i % 7) + 1))::numeric, 2),
       timestamptz '2026-07-01 12:00:00+00' - ((i % 120) || ' days')::interval
FROM generate_series(1, 120) i;

INSERT INTO order_items (order_id, product, qty, unit_price)
SELECT ((i - 1) % 120) + 1,
       (ARRAY['Widget', 'Gadget', 'Sprocket', 'Flange', 'Doohickey'])[((i - 1) % 5) + 1],
       (i % 3) + 1,
       round((9.99 + (i % 10))::numeric, 2)
FROM generate_series(1, 200) i;

INSERT INTO subscription (customer_id, plan, state, started_at)
SELECT i,
       (ARRAY['free', 'pro', 'enterprise'])[((i - 1) % 3) + 1],
       (ARRAY['active', 'active', 'past_due', 'paused'])[((i - 1) % 4) + 1],
       date '2026-01-01' + (i * 7)
FROM generate_series(1, 20) i;

-- REQUIRED: pg_stats.most_common_vals is null until ANALYZE has run, and the
-- MCV grounding this harness exists to measure depends on it.
ANALYZE;
