-- Links each lab_inventory_lines row to the Odoo "Inventory Adjustment" (stock.inventory +
-- lpr.stock.inventory.line) opened for that SKU the moment it's first counted — see
-- src/lib/odoo-inventory.ts's doc comment (2026-09-22, Axel) for the full why.
--
-- odoo_inventory_id / odoo_count_line_id: the Odoo record ids, set once on the FIRST save of a
-- line (ensureInventoryLineStarted) and never moved afterward — correcting a counted number must
-- never re-freeze the cut-off.
-- qty_theoretical: the theoretical_qty Odoo froze at that cut-off instant, cached locally so the
-- recap screen can show the real diff without an extra Odoo round-trip.
ALTER TABLE lab_inventory_lines
  ADD COLUMN IF NOT EXISTS odoo_inventory_id bigint,
  ADD COLUMN IF NOT EXISTS odoo_count_line_id bigint,
  ADD COLUMN IF NOT EXISTS qty_theoretical numeric;
