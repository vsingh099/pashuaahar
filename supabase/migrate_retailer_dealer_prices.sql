-- Migration: add retailer_price and dealer_price to rates
-- Run this in Supabase → SQL Editor if your project already has data

ALTER TABLE rates
  ADD COLUMN IF NOT EXISTS retailer_price NUMERIC NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS dealer_price   NUMERIC NOT NULL DEFAULT 0;

-- Copy existing price_per_bag into both new columns for legacy rows
UPDATE rates
SET retailer_price = price_per_bag,
    dealer_price   = price_per_bag
WHERE retailer_price = 0 AND price_per_bag > 0;
