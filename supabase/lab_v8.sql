-- ================================================================
-- lab_v8.sql — 2026-07-04
-- Import control report (Excel vs import reconciliation for assistants)
-- ZERO impact on catalogue tables — lab_imports only.
-- ================================================================

ALTER TABLE lab_imports
  ADD COLUMN IF NOT EXISTS control_report JSONB;

-- Done. Nullable, no data migration needed.
