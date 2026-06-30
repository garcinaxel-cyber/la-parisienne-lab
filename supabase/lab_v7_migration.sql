-- ================================================================
-- lab_v7_migration.sql -- 2026-06-30
-- Adds image_url per variant + blocked_reason per assignment
-- Run in Supabase SQL Editor
-- ================================================================

-- 1) Variant image URL (for per-variant photos in production cards)
ALTER TABLE lab_fiche_variants
  ADD COLUMN IF NOT EXISTS image_url TEXT;

-- 2) Blocked reason (chefs can mark a product blocked with reason)
ALTER TABLE lab_assignments
  ADD COLUMN IF NOT EXISTS blocked_reason TEXT;

-- Done. No data migration needed -- both columns nullable.
