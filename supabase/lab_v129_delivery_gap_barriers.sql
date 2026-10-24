-- lab_v129 — delivery check gap barriers (Axel, 2026-10-24). Additive only.
-- How a production gap found at delivery check was settled, and the Odoo follow-up.
alter table lab_delivery_check_lines
  add column if not exists resolution text,            -- not_made | broken | undeclared | from_lab_stock | extra_stock | auto_transfer | out_of_stock
  add column if not exists resolution_qty numeric,
  add column if not exists resolution_at timestamptz,
  add column if not exists resolution_by_name text,
  add column if not exists resolution_odoo_status text, -- pending | done | error | none
  add column if not exists resolution_odoo_error text,
  add column if not exists resolution_ref text;         -- e.g. UB/00035, WH/MO/…, SP/…

-- Lab losses: photo + where the loss was declared from.
alter table lab_internal_losses
  add column if not exists photo_url text,
  add column if not exists source text not null default 'lab_scrap', -- lab_scrap | delivery_check
  add column if not exists delivery_date date,
  add column if not exists order_ref text,
  add column if not exists check_line_id uuid;

-- Transfers the app adds itself when the kitchen forgot to send to stock.
alter table lab_stock_transfers
  add column if not exists is_auto boolean not null default false,
  add column if not exists source_ref text;

-- "Recount this product" alerts raised when a stock product is out of stock at delivery check.
create table if not exists lab_stock_recount_alerts (
  id uuid primary key default gen_random_uuid(),
  sku text,
  product_name text,
  delivery_date date,
  order_ref text,
  check_line_id uuid,
  missing_qty numeric,
  raised_by_name text,
  raised_at timestamptz not null default now(),
  status text not null default 'open', -- open | done
  done_by_name text,
  done_at timestamptz,
  note text
);
create index if not exists lab_stock_recount_alerts_status_idx on lab_stock_recount_alerts(status, delivery_date);
alter table lab_stock_recount_alerts enable row level security;
drop policy if exists lab_stock_recount_alerts_manager on lab_stock_recount_alerts;
create policy lab_stock_recount_alerts_manager on lab_stock_recount_alerts for all to authenticated
  using (current_role_of() = any (array['admin'::user_role, 'lab_manager'::user_role, 'assistant'::user_role]))
  with check (current_role_of() = any (array['admin'::user_role, 'lab_manager'::user_role, 'assistant'::user_role]));
