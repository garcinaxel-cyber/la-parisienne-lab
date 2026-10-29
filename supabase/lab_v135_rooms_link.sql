-- v135 — Rooms linked to Odoo (Axel, 2026-10-29). From ROOMS_LINK_START_DAY on:
--   * a storage-confirmed slip moves stock in Odoo (internal transfer LAB/Stock → Room, Room → Room,
--     Room → LAB/Stock for a give-back to the Kho);
--   * the day's MOs are made per product AND per team, consuming in the team's room;
--   * a confirmed room count is applied to the room in Odoo (adjustment at the count's cut-off).
-- Additive only. Each row keeps what was done in Odoo so a retry never moves stock twice.
alter table public.lab_raw_withdrawals
  add column if not exists odoo_picking_id integer,
  add column if not exists odoo_picking_name text,
  add column if not exists odoo_state text,          -- done | error | skipped
  add column if not exists odoo_error text,
  add column if not exists odoo_at timestamptz,
  add column if not exists odoo_tries integer not null default 0;
create index if not exists lab_raw_withdrawals_odoo_todo_idx on public.lab_raw_withdrawals (confirmed_at)
  where status = 'confirmed' and (odoo_state is null or odoo_state = 'error');

alter table public.lab_room_count_sessions
  add column if not exists odoo_inventory_id integer,
  add column if not exists odoo_state text,          -- done | error
  add column if not exists odoo_error text,
  add column if not exists odoo_log jsonb,
  add column if not exists odoo_at timestamptz;
