-- v48 — Shop-side daily product-loss (scrap) recording.
-- Axel, 2026-08-21: chaque boutique doit pouvoir enregistrer ses pertes de produits tous les
-- jours, avec une raison, en s'appuyant sur le mécanisme "scrap" natif d'Odoo (stock.scrap +
-- scrap_reason_tag_ids). Point critique explicite: le lieu de destruction est le SHOP, jamais
-- le LAB — enforced entirely in application code (odoo-scrap.ts), never here.
--
-- Same RLS pattern as lab_shop_receipt_lines (v44): the 'shop' role is NEVER referenced in RLS.
-- All shop reads/writes go through server actions using the service-role client (bypasses RLS),
-- with the access-control boundary enforced in the server action itself via requireShopSession().
-- This table is the local audit trail; odoo_scrap_id links back to the stock.scrap record Odoo
-- created (null if the Odoo write failed — recorded locally regardless so nothing is silently
-- lost, per the same "never lose a report" principle as lab_shop_receipt_lines).

CREATE TABLE IF NOT EXISTS lab_shop_losses (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_name          text NOT NULL,
  sku                text,
  product_name       text NOT NULL,
  qty                numeric NOT NULL CHECK (qty > 0),
  reason_tag_id      integer,
  reason_tag_name    text NOT NULL,
  note               text,
  odoo_scrap_id      integer,
  odoo_sync_error    text,
  reported_by_name   text NOT NULL,
  reported_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lab_shop_losses_shop_date ON lab_shop_losses(shop_name, reported_at DESC);

ALTER TABLE lab_shop_losses ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "lab_shop_losses_manager" ON lab_shop_losses;
CREATE POLICY "lab_shop_losses_manager" ON lab_shop_losses FOR ALL TO authenticated
  USING (current_role_of() IN ('admin','lab_manager','assistant'))
  WITH CHECK (current_role_of() IN ('admin','lab_manager','assistant'));
-- No 'shop' role, no anon policy — the shop portal reads/writes via the service-role key
-- server-side only, same pattern as lab_shop_receipt_lines.
