-- ================================================================
-- lab_v12_autosync.sql — 2026-07-10
-- Make the auto-sync self-sufficient:
--  - lab_excluded_skus: permanent non-production list (packaging, drinks…)
--  - lab_odoo_changes: queue of Odoo modifications detected by the cron,
--    awaiting human review (never auto-applied)
-- ZERO impact on catalogue tables. Already applied in prod.
-- ================================================================

CREATE TABLE IF NOT EXISTS lab_excluded_skus (
  sku text PRIMARY KEY,
  product_name text,
  reason text,
  excluded_by uuid,
  created_at timestamptz DEFAULT now()
);
ALTER TABLE lab_excluded_skus ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "lab_excluded_manager" ON lab_excluded_skus;
CREATE POLICY "lab_excluded_manager" ON lab_excluded_skus FOR ALL TO authenticated
  USING (current_role_of() = ANY (ARRAY['admin'::user_role,'lab_manager'::user_role,'assistant'::user_role]))
  WITH CHECK (current_role_of() = ANY (ARRAY['admin'::user_role,'lab_manager'::user_role,'assistant'::user_role]));

CREATE TABLE IF NOT EXISTS lab_odoo_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_ref text NOT NULL,
  cancelled boolean DEFAULT false,
  items jsonb NOT NULL,
  delivery_date date,
  status text DEFAULT 'pending',    -- pending | resolved | dismissed
  detected_at timestamptz DEFAULT now(),
  resolved_at timestamptz
);
ALTER TABLE lab_odoo_changes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "lab_odoo_changes_manager" ON lab_odoo_changes;
CREATE POLICY "lab_odoo_changes_manager" ON lab_odoo_changes FOR ALL TO authenticated
  USING (current_role_of() = ANY (ARRAY['admin'::user_role,'lab_manager'::user_role,'assistant'::user_role]))
  WITH CHECK (current_role_of() = ANY (ARRAY['admin'::user_role,'lab_manager'::user_role,'assistant'::user_role]));
