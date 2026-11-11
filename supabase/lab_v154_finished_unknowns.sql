-- lab_v154 — "Không thấy" (product not found: photo + quantity + unit) on the finished-goods
-- inventory too (Axel, 2026-11-11: every Lab inventory has the same path). The unknown photos
-- table now belongs either to a raw/packaging count (count_id) or to a finished-goods session
-- (session_id). Matched rows remember the SKU put on them.
alter table public.lab_stock_count_unknowns alter column count_id drop not null;
alter table public.lab_stock_count_unknowns
  add column if not exists session_id uuid references public.lab_inventory_sessions(id) on delete cascade,
  add column if not exists resolved_sku text;
alter table public.lab_stock_count_unknowns drop constraint if exists lab_stock_count_unknowns_owner;
alter table public.lab_stock_count_unknowns
  add constraint lab_stock_count_unknowns_owner check (count_id is not null or session_id is not null);
create index if not exists lab_stock_count_unknowns_session on public.lab_stock_count_unknowns (session_id);
