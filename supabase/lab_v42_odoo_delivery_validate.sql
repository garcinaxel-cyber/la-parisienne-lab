-- 2026-08-17. New feature: "Valider la livraison sur Odoo" (Axel) — after the assistant checks
-- every line and validates the delivery-check itself + prints, a mandatory step writes the
-- delivered quantities back onto Odoo's stock.move lines and validates the picking (no
-- backorder, ever — confirmed with Axel: a shortfall is just recorded as-is, never carried
-- forward). REP orders only for this first pilot phase; sales orders (+ invoice creation) come
-- later once this is proven on a real order.
--
-- lab_delivery_orders already had odoo_push_status / odoo_push_error / odoo_picking_ids
-- (unused placeholders, scaffolded ahead of time in an earlier session) — reused here for the
-- push outcome. These new columns are purely the audit trail (who/when clicked the button),
-- mirroring the existing validated_at/by/by_name (checklist validation) and printed_at/by/by_name
-- pattern already on this table. Deliberately a SEPARATE "validated" concept from the existing
-- validated_at (checklist validation) — this one is specifically about the Odoo-side push.
alter table lab_delivery_orders add column if not exists odoo_validated_at timestamptz;
alter table lab_delivery_orders add column if not exists odoo_validated_by uuid;
alter table lab_delivery_orders add column if not exists odoo_validated_by_name text;
