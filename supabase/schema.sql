-- ============================================================
-- PashuFeed Pro — Supabase / PostgreSQL Schema
-- Run this in Supabase → SQL Editor
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─────────────────────────────────────────
-- RATES / PRODUCTS
-- ─────────────────────────────────────────
CREATE TABLE rates (
  id            TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id       UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name          TEXT        NOT NULL,
  pack_size     NUMERIC     NOT NULL,
  price_per_bag NUMERIC     NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE rates ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner_rates" ON rates
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- ─────────────────────────────────────────
-- CUSTOMERS
-- ─────────────────────────────────────────
CREATE TABLE customers (
  id         TEXT  PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id    UUID  NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name       TEXT  NOT NULL,
  phone      TEXT,
  address    TEXT,
  type       TEXT  NOT NULL DEFAULT 'Direct Customer'
                   CHECK (type IN ('Direct Customer','Shop Dealer')),
  created_at DATE  NOT NULL DEFAULT CURRENT_DATE
);
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner_customers" ON customers
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- ─────────────────────────────────────────
-- STOCK
-- ─────────────────────────────────────────
CREATE TABLE stock (
  id         TEXT    PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id    UUID    NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  rate_id    TEXT    REFERENCES rates(id) ON DELETE SET NULL,
  name       TEXT    NOT NULL,
  pack_size  NUMERIC NOT NULL DEFAULT 0,
  bags       NUMERIC NOT NULL DEFAULT 0,
  low_alert  NUMERIC NOT NULL DEFAULT 5,
  supplier   TEXT,
  updated_at DATE    NOT NULL DEFAULT CURRENT_DATE
);
ALTER TABLE stock ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner_stock" ON stock
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- ─────────────────────────────────────────
-- SALES (bills)
-- ─────────────────────────────────────────
CREATE TABLE sales (
  id            TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id       UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  bill_no       TEXT        NOT NULL,
  customer_id   TEXT        NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  customer_name TEXT        NOT NULL,
  customer_type TEXT,
  total         NUMERIC     NOT NULL DEFAULT 0,
  paid_amount   NUMERIC     NOT NULL DEFAULT 0,
  pay_status    TEXT        NOT NULL DEFAULT 'unpaid'
                            CHECK (pay_status IN ('paid','unpaid','partial')),
  notes         TEXT,
  date          DATE        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE sales ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner_sales" ON sales
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- ─────────────────────────────────────────
-- SALE_ITEMS
-- ─────────────────────────────────────────
CREATE TABLE sale_items (
  id            TEXT    PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id       UUID    NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  sale_id       TEXT    NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  rate_id       TEXT    REFERENCES rates(id) ON DELETE SET NULL,
  name          TEXT    NOT NULL,
  pack_size     NUMERIC NOT NULL DEFAULT 0,
  bags          NUMERIC NOT NULL DEFAULT 0,
  price_per_bag NUMERIC NOT NULL DEFAULT 0,
  amount        NUMERIC NOT NULL DEFAULT 0
);
ALTER TABLE sale_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner_sale_items" ON sale_items
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- ─────────────────────────────────────────
-- PAYMENTS
-- ─────────────────────────────────────────
CREATE TABLE payments (
  id            TEXT    PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id       UUID    NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  customer_id   TEXT    NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  customer_name TEXT    NOT NULL,
  amount        NUMERIC NOT NULL DEFAULT 0,
  date          DATE    NOT NULL DEFAULT CURRENT_DATE,
  mode          TEXT
);
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner_payments" ON payments
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- ─────────────────────────────────────────
-- TARGETS (one row per user)
-- ─────────────────────────────────────────
CREATE TABLE targets (
  user_id    UUID    PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  daily      NUMERIC NOT NULL DEFAULT 0,
  monthly    NUMERIC NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE targets ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner_targets" ON targets
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- ─────────────────────────────────────────
-- BILL_SEQ (atomic bill number per user)
-- ─────────────────────────────────────────
CREATE TABLE bill_seq (
  user_id UUID    PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  seq     INTEGER NOT NULL DEFAULT 1000
);
ALTER TABLE bill_seq ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner_bill_seq" ON bill_seq
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- ─────────────────────────────────────────
-- INDEXES
-- ─────────────────────────────────────────
CREATE INDEX idx_sales_user_date   ON sales(user_id, date DESC);
CREATE INDEX idx_sales_customer    ON sales(customer_id);
CREATE INDEX idx_sale_items_sale   ON sale_items(sale_id);
CREATE INDEX idx_payments_customer ON payments(customer_id);
CREATE INDEX idx_stock_user        ON stock(user_id);
CREATE INDEX idx_customers_user    ON customers(user_id);

-- ─────────────────────────────────────────
-- STORED PROCEDURE: create_sale (atomic)
-- Atomically: increments bill seq, inserts
-- sale + items, deducts stock.
-- ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION create_sale(
  p_user_id       UUID,
  p_id            TEXT,
  p_customer_id   TEXT,
  p_customer_name TEXT,
  p_customer_type TEXT,
  p_total         NUMERIC,
  p_paid_amount   NUMERIC,
  p_pay_status    TEXT,
  p_notes         TEXT,
  p_date          TEXT,
  p_items         JSONB
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_seq     INTEGER;
  v_bill_no TEXT;
  v_item    JSONB;
BEGIN
  -- Atomic bill number increment
  INSERT INTO bill_seq (user_id, seq) VALUES (p_user_id, 1001)
  ON CONFLICT (user_id) DO UPDATE SET seq = bill_seq.seq + 1
  RETURNING seq INTO v_seq;
  v_bill_no := 'BILL-' || v_seq;

  -- Insert sale header
  INSERT INTO sales (
    id, user_id, bill_no, customer_id, customer_name,
    customer_type, total, paid_amount, pay_status, notes, date
  ) VALUES (
    p_id, p_user_id, v_bill_no, p_customer_id, p_customer_name,
    p_customer_type, p_total, p_paid_amount, p_pay_status, p_notes, p_date::DATE
  );

  -- Insert line items + deduct stock
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    INSERT INTO sale_items (
      id, user_id, sale_id, rate_id, name,
      pack_size, bags, price_per_bag, amount
    ) VALUES (
      gen_random_uuid()::text, p_user_id, p_id,
      v_item->>'rateId', v_item->>'name',
      (v_item->>'packSize')::NUMERIC, (v_item->>'bags')::NUMERIC,
      (v_item->>'pricePerBag')::NUMERIC, (v_item->>'amount')::NUMERIC
    );

    UPDATE stock
    SET bags       = GREATEST(0, bags - (v_item->>'bags')::NUMERIC),
        updated_at = CURRENT_DATE
    WHERE rate_id = v_item->>'rateId' AND user_id = p_user_id;
  END LOOP;

  RETURN jsonb_build_object(
    'id',           p_id,
    'billNo',       v_bill_no,
    'customerId',   p_customer_id,
    'customerName', p_customer_name,
    'customerType', p_customer_type,
    'total',        p_total,
    'paidAmount',   p_paid_amount,
    'payStatus',    p_pay_status,
    'notes',        p_notes,
    'date',         p_date
  );
END;
$$;

-- ─────────────────────────────────────────
-- STORED PROCEDURE: delete_sale (atomic)
-- Restores stock before deleting.
-- ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION delete_sale(
  p_sale_id TEXT,
  p_user_id UUID
) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_item RECORD;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM sales WHERE id = p_sale_id AND user_id = p_user_id) THEN
    RETURN FALSE;
  END IF;

  -- Restore stock
  FOR v_item IN SELECT rate_id, bags FROM sale_items WHERE sale_id = p_sale_id LOOP
    UPDATE stock
    SET bags = bags + v_item.bags
    WHERE rate_id = v_item.rate_id AND user_id = p_user_id;
  END LOOP;

  DELETE FROM sales WHERE id = p_sale_id AND user_id = p_user_id;
  RETURN TRUE;
END;
$$;
