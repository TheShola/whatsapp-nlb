-- database/schema.sql
-- Run this in your Supabase SQL editor to create the required tables.
-- Go to: Supabase Dashboard → SQL Editor → New Query → paste → Run

-- ── orders ────────────────────────────────────────────────────────────────────
-- One row per confirmed, paid order.

CREATE TABLE IF NOT EXISTS orders (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  reference        TEXT        UNIQUE NOT NULL,         -- Paystack ref e.g. TT-ABC-1234
  customer_phone   TEXT        NOT NULL,                -- e.g. +2348012345678
  customer_name    TEXT,
  delivery_address TEXT,
  items            JSONB       DEFAULT '[]'::jsonb,     -- [{name, qty, unitPrice}]
  subtotal         INTEGER     NOT NULL DEFAULT 0,      -- Naira
  delivery_fee     INTEGER     NOT NULL DEFAULT 0,      -- Naira
  total_paid       INTEGER     NOT NULL DEFAULT 0,      -- Naira
  chowdeck_id      TEXT,                                -- Chowdeck delivery ID
  status           TEXT        NOT NULL DEFAULT 'paid'
                   CHECK (status IN ('paid','dispatched','in_transit','delivered','rejected')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Auto-update updated_at on every row change
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER orders_updated_at
  BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Useful indexes
CREATE INDEX IF NOT EXISTS idx_orders_customer_phone ON orders(customer_phone);
CREATE INDEX IF NOT EXISTS idx_orders_status         ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_created_at     ON orders(created_at DESC);

-- ── delivery_events ───────────────────────────────────────────────────────────
-- One row per Chowdeck webhook event.
-- Used for delivery time analytics (e.g. avg time from dispatch to delivered).

CREATE TABLE IF NOT EXISTS delivery_events (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  order_reference  TEXT        NOT NULL REFERENCES orders(reference) ON DELETE CASCADE,
  delivery_id      TEXT        NOT NULL,               -- Chowdeck delivery ID
  event_type       TEXT        NOT NULL,               -- e.g. in_transit, arrived, success
  rider_name       TEXT,
  rider_phone      TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_delivery_events_order ON delivery_events(order_reference);
CREATE INDEX IF NOT EXISTS idx_delivery_events_type  ON delivery_events(event_type);

-- ── Analytics views ───────────────────────────────────────────────────────────
-- Handy pre-built queries you can use in Supabase Studio or connect to a BI tool.

-- Daily revenue summary
CREATE OR REPLACE VIEW daily_revenue AS
SELECT
  DATE(created_at)     AS order_date,
  COUNT(*)             AS total_orders,
  SUM(total_paid)      AS revenue_naira,
  AVG(delivery_fee)    AS avg_delivery_fee,
  AVG(total_paid)      AS avg_order_value
FROM orders
WHERE status NOT IN ('rejected')
GROUP BY DATE(created_at)
ORDER BY order_date DESC;

-- Average delivery duration (dispatch → delivered) in minutes
CREATE OR REPLACE VIEW avg_delivery_time AS
SELECT
  DATE(o.created_at)                                   AS order_date,
  COUNT(*)                                             AS deliveries,
  ROUND(
    AVG(
      EXTRACT(EPOCH FROM (
        d_end.created_at - d_start.created_at
      )) / 60
    )::NUMERIC, 1
  )                                                    AS avg_minutes_dispatch_to_delivered
FROM orders o
JOIN delivery_events d_start ON d_start.order_reference = o.reference
  AND d_start.event_type IN ('order.picked_up', 'in_transit')
JOIN delivery_events d_end   ON d_end.order_reference   = o.reference
  AND d_end.event_type   IN ('order.complete', 'success')
GROUP BY DATE(o.created_at)
ORDER BY order_date DESC;

-- Top items ordered (parse JSONB array)
CREATE OR REPLACE VIEW top_items AS
SELECT
  item->>'name'          AS item_name,
  SUM((item->>'qty')::INT) AS total_quantity
FROM orders,
     jsonb_array_elements(items) AS item
WHERE status NOT IN ('rejected')
GROUP BY item->>'name'
ORDER BY total_quantity DESC;
