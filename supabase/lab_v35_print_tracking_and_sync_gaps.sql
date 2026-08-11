-- 2026-08-11 (applied live via Supabase MCP).
-- 1) Track when a delivery-check bon was printed, so the UI can show a color-coded "already
--    printed" indicator (Axel: "peut on rajouter un code couleur dans l'interface delivery
--    check si on a deja imprime la feuille").
alter table lab_delivery_orders add column if not exists printed_at timestamptz;
alter table lab_delivery_orders add column if not exists printed_by uuid;
alter table lab_delivery_orders add column if not exists printed_by_name text;
alter table lab_delivery_orders add column if not exists print_count integer not null default 0;

-- 2) Coverage check: every 15-min cron tick now records any Odoo order (sale.order /
-- stock.replenishment.request, same accepted-state + date window as runOdooSync) that ended up
-- with ZERO representation anywhere in the app — not in lab_order_lines, not in
-- lab_order_packaging_lines. This is exactly the class of bug that made REP/2026/01005-01007
-- invisible (2026-08-11) — Axel asked for a standing check so a future case like it surfaces on
-- its own instead of being found by accident. Read-only table, cron (service role) is the only
-- writer; delivery-check's index page reads it to show a banner.
create table if not exists lab_sync_gaps (
  order_ref text primary key,
  source_type text not null,
  delivery_date date,
  state text,
  reason text not null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
alter table lab_sync_gaps enable row level security;
drop policy if exists "lab_sync_gaps_read" on lab_sync_gaps;
create policy "lab_sync_gaps_read" on lab_sync_gaps for select to authenticated using (true);
