-- v121 — Shop reception gaps (Axel, 2026-10-13, PREVIEW branch reception-gaps-preview).
-- "pour le moment je veux pas que ça impacte l'opérationnel": purely ADDITIVE. Two nullable
-- columns on lab_shop_receipt_lines that the production code never selects, plus two new tables.
-- Nothing existing is altered, renamed or backfilled.
--
-- Model (decisions doc claude/shop-reception-gaps-decisions-2026-10-13.md):
--   reference qty = qty_checked by the assistants ("Bếp"), falls back to qty_expected
--   qty_received  = everything physically received (damaged units included)
--   qty_damaged   = part of qty_received that arrived broken → a LAB loss, goes back with the driver
--   good qty      = qty_received − qty_damaged → what goes into the shop stock (Odoo IN)
--   missing = max(0, ref − received)   extra = max(0, received − ref)

ALTER TABLE lab_shop_receipt_lines ADD COLUMN IF NOT EXISTS gap_cause text
  CHECK (gap_cause IS NULL OR gap_cause IN ('missing','wrong_product'));
ALTER TABLE lab_shop_receipt_lines ADD COLUMN IF NOT EXISTS qty_damaged numeric
  CHECK (qty_damaged IS NULL OR qty_damaged >= 0);

-- One row per (check line, kind). Upserted on every shop confirm; a recount re-evaluates it.
CREATE TABLE IF NOT EXISTS lab_delivery_gaps (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  check_line_id             uuid NOT NULL REFERENCES lab_delivery_check_lines(id) ON DELETE CASCADE,
  delivery_order_id         uuid NOT NULL REFERENCES lab_delivery_orders(id) ON DELETE CASCADE,
  order_ref                 text NOT NULL,
  delivery_date             date NOT NULL,
  shop_name                 text NOT NULL,
  sku                       text,
  product_name              text NOT NULL,
  kind                      text NOT NULL CHECK (kind IN ('missing','extra','damaged')),
  qty                       numeric NOT NULL,
  ref_qty                   numeric,
  received_qty              numeric,
  shop_cause                text,          -- 'missing' | 'wrong_product' (what the shop picked)
  shop_note                 text,
  status                    text NOT NULL DEFAULT 'open'
                              CHECK (status IN ('open','waiting_shop','waiting_return','closed')),
  lab_cause                 text CHECK (lab_cause IS NULL OR lab_cause IN
                              ('found_at_lab','damaged_returned','lost_transport','shop_miscount','lab_sent_extra')),
  lab_message               text,
  decided_by_name           text,
  decided_at                timestamptz,
  return_confirmed_qty      numeric,
  return_confirmed_by_name  text,
  return_confirmed_at       timestamptz,
  loss_cancelled_at         timestamptz,   -- written-off unit sold anyway → Axel cancels the loss
  loss_cancelled_by_name    text,
  odoo_mode                 text,          -- 'simulated' | 'live'
  odoo_log                  jsonb NOT NULL DEFAULT '[]'::jsonb,
  closed_at                 timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (check_line_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_lab_delivery_gaps_status ON lab_delivery_gaps(status);
CREATE INDEX IF NOT EXISTS idx_lab_delivery_gaps_shop ON lab_delivery_gaps(shop_name, delivery_date);

ALTER TABLE lab_delivery_gaps ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "lab_delivery_gaps_manager" ON lab_delivery_gaps;
CREATE POLICY "lab_delivery_gaps_manager" ON lab_delivery_gaps FOR ALL TO authenticated
  USING (current_role_of() IN ('admin','lab_manager','assistant'))
  WITH CHECK (current_role_of() IN ('admin','lab_manager','assistant'));

-- What the Odoo engine planned / did for one reception (IN validation) — simulation log in preview.
CREATE TABLE IF NOT EXISTS lab_reception_odoo_runs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_order_id  uuid REFERENCES lab_delivery_orders(id) ON DELETE CASCADE,
  gap_id             uuid REFERENCES lab_delivery_gaps(id) ON DELETE CASCADE,
  order_ref          text,
  action             text NOT NULL,       -- 'validate_in' | 'resolve_gap' | 'damaged_return'
  mode               text NOT NULL,       -- 'simulated' | 'live'
  ok                 boolean NOT NULL DEFAULT true,
  plan               jsonb NOT NULL DEFAULT '{}'::jsonb,
  error              text,
  created_by_name    text,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_lab_reception_odoo_runs_order ON lab_reception_odoo_runs(delivery_order_id);

ALTER TABLE lab_reception_odoo_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "lab_reception_odoo_runs_manager" ON lab_reception_odoo_runs;
CREATE POLICY "lab_reception_odoo_runs_manager" ON lab_reception_odoo_runs FOR ALL TO authenticated
  USING (current_role_of() IN ('admin','lab_manager','assistant'))
  WITH CHECK (current_role_of() IN ('admin','lab_manager','assistant'));
