-- ============================================================
-- BADRI TRADERS — v2 Migration
-- Run in Supabase → SQL Editor AFTER the base schema.sql
-- ============================================================

-- ── rates: add cost_price and is_public ──────────────────────
ALTER TABLE rates ADD COLUMN IF NOT EXISTS cost_price NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE rates ADD COLUMN IF NOT EXISTS is_public  BOOLEAN NOT NULL DEFAULT false;

-- ── sales: make customer_id nullable (walk-in / cash sales) ──
ALTER TABLE sales ALTER COLUMN customer_id DROP NOT NULL;

-- ── Update create_sale to accept null customer_id ─────────────
CREATE OR REPLACE FUNCTION create_sale(
  p_user_id       UUID,
  p_id            TEXT,
  p_customer_id   TEXT,        -- NULL for walk-in
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

  -- Insert sale header (customer_id may be NULL for walk-in)
  INSERT INTO sales (
    id, user_id, bill_no, customer_id, customer_name,
    customer_type, total, paid_amount, pay_status, notes, date
  ) VALUES (
    p_id, p_user_id, v_bill_no,
    NULLIF(p_customer_id, ''),   -- treat empty string as NULL
    p_customer_name,
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
    'customerId',   NULLIF(p_customer_id, ''),
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
