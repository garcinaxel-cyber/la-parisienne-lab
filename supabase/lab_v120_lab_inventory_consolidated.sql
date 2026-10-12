-- lab_v120 — LAB finished-goods count: one consolidated Odoo adjustment per app session
-- (Axel, 2026-10-12). The session remembers its Odoo stock.inventory and its cut-off (T0).
-- Additive only. Existing sessions keep their per-SKU adjustments (columns stay null).
alter table public.lab_inventory_sessions add column if not exists odoo_inventory_id integer;
alter table public.lab_inventory_sessions add column if not exists odoo_cutoff_at timestamptz;
comment on column public.lab_inventory_sessions.odoo_inventory_id is 'Consolidated Odoo stock.inventory of this session (since 2026-10-12). Null = legacy per-SKU adjustments.';
comment on column public.lab_inventory_sessions.odoo_cutoff_at is 'T0 written on the Odoo adjustment: first line time for a same-day count, 15:00 VN of the date for a past date.';
