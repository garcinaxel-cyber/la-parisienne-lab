-- ============================================================
-- Lab V3 Migration
-- 1. Add breakdown JSONB to lab_assignments
--    (stores per-client qty breakdown so chefs can see it)
-- 2. Add is_lab_only to products
--    (B2B / non-catalogue products: is_active=false + is_lab_only=true)
-- Run in Supabase SQL Editor
-- ============================================================

-- 1. Breakdown column on lab_assignments
ALTER TABLE lab_assignments
  ADD COLUMN IF NOT EXISTS breakdown jsonb NOT NULL DEFAULT '[]';

-- 2. is_lab_only on the shared products table
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS is_lab_only boolean NOT NULL DEFAULT false;

-- Index for efficient filtering
CREATE INDEX IF NOT EXISTS products_lab_only_idx ON products(is_lab_only) WHERE is_lab_only = true;

-- Helpful comment
COMMENT ON COLUMN lab_assignments.breakdown
  IS 'JSON array of { shop_name: string, qty: number, order_ref: string } for per-client display in chef station';

COMMENT ON COLUMN products.is_lab_only
  IS 'When true: product is B2B / other channel, not shown on public catalogue. Set is_active=false to hide from catalogue.';
