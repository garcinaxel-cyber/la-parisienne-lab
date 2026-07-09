-- ================================================================
-- lab_v11_orderlines_rls.sql — 2026-07-09
-- Chefs/workers could not read lab_order_lines (only managers had a
-- policy) → the Upcoming/History per-order detail on the station came
-- back empty. Grant read on their own team's lines.
-- ZERO impact on catalogue tables.
-- ================================================================

DROP POLICY IF EXISTS "lab_order_lines_team_read" ON lab_order_lines;
CREATE POLICY "lab_order_lines_team_read" ON lab_order_lines FOR SELECT TO authenticated
  USING (current_role_of() IN ('chef','worker') AND team = current_lab_team()::text);
