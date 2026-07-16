-- lab_v18 — Manual birthday cakes created IN the app before they exist in Odoo.
-- A rushed cake can be produced immediately (a production card is created for the chefs),
-- while a reminder keeps it in the "to enter in Odoo" list. Phase 2 will match it to the
-- Odoo order at sync time (SKU + delivery date, human-confirmed) to avoid duplication.
--   assignment_id : the production card shown to the chefs
--   import_id     : the per-day "manual" container (lab_imports type=cake_addon, notes marker)
--   needs_odoo    : still to be entered in Odoo (cleared when matched)
--   matched_*     : set in Phase 2 when linked to the real Odoo order

CREATE TABLE IF NOT EXISTS lab_manual_cakes (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fiche_id          uuid,
  variant_id        uuid,
  product_sku       text,
  product_name_vi   text NOT NULL,
  product_name_en   text NOT NULL DEFAULT '',
  image_url         text,
  team              text,
  qty               int  NOT NULL DEFAULT 1,
  delivery_date     date NOT NULL,
  ready_time        text,
  delivered_by      text,
  delivery_address  text,
  message           text,
  customer_name     text,
  customer_phone    text,
  needs_odoo        boolean NOT NULL DEFAULT true,
  matched_order_ref text,
  matched_at        timestamptz,
  rejected_order_refs text[] NOT NULL DEFAULT '{}',  -- Odoo refs the assistant said are NOT this cake
  assignment_id     uuid REFERENCES lab_assignments(id) ON DELETE SET NULL,
  import_id         uuid REFERENCES lab_imports(id) ON DELETE SET NULL,
  created_by        uuid,
  created_by_name   text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS lab_manual_cakes_date_idx ON lab_manual_cakes(delivery_date);
CREATE INDEX IF NOT EXISTS lab_manual_cakes_assignment_idx ON lab_manual_cakes(assignment_id);

ALTER TABLE lab_manual_cakes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "lab_manual_cakes_manager" ON lab_manual_cakes;
CREATE POLICY "lab_manual_cakes_manager" ON lab_manual_cakes FOR ALL TO authenticated
  USING (current_role_of() IN ('admin','lab_manager','assistant'))
  WITH CHECK (current_role_of() IN ('admin','lab_manager','assistant'));
