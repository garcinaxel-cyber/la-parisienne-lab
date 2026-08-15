-- 2026-08-14 (applied live via Supabase MCP).
-- Mascarpone 0.2 (REP/2026/01043) silently vanished — odoo-packaging-sync.ts rounded
-- quantity_requested with Math.round() then dropped any qty that rounded to 0, and the
-- destination columns were `integer` anyway. Same class of bug as lab_v37 (qty_checked) but on
-- the import side, before delivery-check ever sees the line. Widen both to numeric(10,3);
-- companion code fix removes the rounding in odoo-packaging-sync.ts.
alter table lab_order_packaging_lines alter column qty type numeric(10,3);
alter table lab_delivery_check_lines alter column qty_expected type numeric(10,3);
