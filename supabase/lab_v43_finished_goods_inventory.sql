-- v43 — Finished-goods inventory count → Odoo stock.quant.
-- Session-based physical count, scoped by default to the 3 long-storage categories
-- (Macaron / Biscuit Voyage / Tiramisu) with a search-based escape hatch for anything else.
-- Nothing is written to Odoo until the recap screen's "Envoyer à Odoo" is confirmed —
-- same dry-run-then-confirm-then-write pattern as delivery validation (lab_v42).
--
-- Applied live via Supabase MCP on 2026-08-19; this file mirrors that migration for repo history.

CREATE TABLE IF NOT EXISTS lab_inventory_sessions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inventory_date    date NOT NULL DEFAULT CURRENT_DATE,
  status            text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted')),
  created_by        uuid,
  created_by_name   text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  submitted_at      timestamptz,
  submitted_by      uuid,
  submitted_by_name text,
  odoo_push_status  text,   -- null | 'success' | 'partial' | 'error'
  odoo_push_error   text
);

CREATE TABLE IF NOT EXISTS lab_inventory_lines (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id       uuid NOT NULL REFERENCES lab_inventory_sessions(id) ON DELETE CASCADE,
  fiche_id         uuid REFERENCES lab_fiche_meta(id),
  variant_id       uuid REFERENCES lab_fiche_variants(id),
  sku              text NOT NULL,
  product_name_vi  text NOT NULL,
  product_name_en  text,
  category         text,
  qty_counted      numeric NOT NULL DEFAULT 0,
  qty_system       numeric,           -- Odoo on-hand snapshot, filled in at dry-run/submit time
  odoo_push_status text,              -- null | 'success' | 'error'
  odoo_push_error  text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE(session_id, sku)
);

CREATE INDEX IF NOT EXISTS idx_lab_inventory_lines_session ON lab_inventory_lines(session_id);

ALTER TABLE lab_inventory_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE lab_inventory_lines ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "lab_inventory_sessions_manager" ON lab_inventory_sessions;
CREATE POLICY "lab_inventory_sessions_manager" ON lab_inventory_sessions FOR ALL TO authenticated
  USING (current_role_of() IN ('admin','lab_manager','assistant'))
  WITH CHECK (current_role_of() IN ('admin','lab_manager','assistant'));

DROP POLICY IF EXISTS "lab_inventory_lines_manager" ON lab_inventory_lines;
CREATE POLICY "lab_inventory_lines_manager" ON lab_inventory_lines FOR ALL TO authenticated
  USING (current_role_of() IN ('admin','lab_manager','assistant'))
  WITH CHECK (current_role_of() IN ('admin','lab_manager','assistant'));
