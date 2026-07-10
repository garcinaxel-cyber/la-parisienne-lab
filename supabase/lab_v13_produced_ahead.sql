-- ================================================================
-- lab_v13_produced_ahead.sql — 2026-07-10
-- Flag production completed AHEAD of the delivery day (chef producing
-- tomorrow's order the day before). Shown in a distinct blue color in the
-- station Done tab and the dashboard. Already applied in prod.
-- ZERO impact on catalogue tables.
-- ================================================================

ALTER TABLE lab_assignments
  ADD COLUMN IF NOT EXISTS produced_ahead boolean DEFAULT false;
