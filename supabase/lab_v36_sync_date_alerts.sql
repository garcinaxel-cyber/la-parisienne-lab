-- 2026-08-12 (applied live via Supabase MCP).
-- Delivery-date reassignment on an already-imported order, same architectural blind spot as
-- shop_name/note (lab-v35-era fixes): odoo-sync.ts only ever diffed QUANTITY per (order_ref,
-- sku) for already-imported refs — a commitment_date/delivery_date changed in Odoo AFTER import
-- (S03188/KAFEBEAN moved from 08-13 to 08-12, 2026-08-12) had no path back to the app.
--
-- Unlike shop_name/note, auto-correcting this one isn't a safe blind fix: lab_order_lines'
-- import_id groups MULTIPLE order_refs sharing one calendar day (confirmed 3 such imports live
-- right now), and lab_assignments cards can be SHARED across those order_refs (one card, several
-- breakdown[] entries) — moving a single order_ref's date means pulling its lines out of the old
-- import/cards without disturbing the other order_refs riding along in the same batch, splitting
-- any shared card's breakdown. That's real migration logic, not a column update — Axel chose to
-- surface it as a banner (same pattern as lab_sync_gaps) and keep doing the actual date-move by
-- hand for now, rather than risk a wrong auto-split.
create table if not exists lab_sync_date_alerts (
  order_ref text primary key,
  source_type text not null,
  old_date date not null,
  new_date date not null,
  state text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
alter table lab_sync_date_alerts enable row level security;
drop policy if exists "lab_sync_date_alerts_read" on lab_sync_date_alerts;
create policy "lab_sync_date_alerts_read" on lab_sync_date_alerts for select to authenticated using (true);
