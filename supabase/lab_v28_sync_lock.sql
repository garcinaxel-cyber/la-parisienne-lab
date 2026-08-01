-- lab_v28: single-row mutex to prevent concurrent Odoo syncs.
-- runAutoOdooSync is called both by the hourly pg_cron job AND by the manual
-- "Sync Odoo" button on every station page (4 teams). Neither path had any
-- concurrency guard beyond an order_ref-already-imported check done AFTER
-- fetching from Odoo — two overlapping runs could both see "not yet imported"
-- for the same new order and each create their own production card, doubling
-- the quantity to produce. This table gives the app an atomic claim/release
-- lock via a single UPDATE (safe even over PostgREST's pooled connections,
-- unlike a Postgres advisory lock which needs a stable session).

create table if not exists lab_sync_lock (
  id boolean primary key default true,
  locked_until timestamptz,
  constraint lab_sync_lock_single_row check (id)
);

insert into lab_sync_lock (id, locked_until)
values (true, null)
on conflict (id) do nothing;

alter table lab_sync_lock enable row level security;
-- No policies: only the service-role client (bypasses RLS) touches this table.
