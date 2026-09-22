-- Shops' monthly OFFICIAL inventory — separate from lab_shop_stock_counts (the daily Kiểm kho,
-- which stays 100% Odoo-free, always — see src/app/shop/actions.ts's 2026-09-03 comment). This is
-- a dedicated single session per shop per calendar month, gated to the last day of the month
-- (isLastDayOfMonthVN), pushed to Odoo via the SAME cut-off/diff mechanism as the lab
-- (src/lib/odoo-inventory.ts), just against the shop's own warehouse location and with a single
-- grouped cut-off (startGroupedInventoryCutoff) covering every SKU at once instead of per-SKU —
-- see that file's doc comment for why. Axel, 2026-09-22.

create table if not exists lab_shop_official_inventory_sessions (
  id uuid primary key default gen_random_uuid(),
  shop_name text not null,
  period text not null, -- 'YYYY-MM', lab-local (vnPeriodStr) — one session per shop per month
  status text not null default 'draft', -- draft | submitted
  odoo_location_id bigint,
  odoo_inventory_id bigint, -- the single grouped stock.inventory covering this whole session
  odoo_push_status text, -- pending | success | partial | error
  odoo_push_error text,
  created_at timestamptz not null default now(),
  created_by uuid,
  created_by_name text,
  submitted_at timestamptz,
  submitted_by uuid,
  submitted_by_name text,
  updated_at timestamptz not null default now(),
  unique (shop_name, period)
);

create table if not exists lab_shop_official_inventory_lines (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references lab_shop_official_inventory_sessions(id) on delete cascade,
  sku text not null,
  product_name text,
  qty_theoretical numeric,
  qty_counted numeric not null default 0, -- uncounted stays 0 — pushed to Odoo as-is (Axel: "si
                                           -- ils comptent pas [un produit], c'est que c'est 0")
  odoo_count_line_id bigint,
  odoo_push_status text,
  odoo_push_error text,
  updated_at timestamptz not null default now(),
  updated_by_name text,
  unique (session_id, sku)
);

create index if not exists lab_shop_official_inventory_lines_session_idx
  on lab_shop_official_inventory_lines(session_id);

alter table lab_shop_official_inventory_sessions enable row level security;
alter table lab_shop_official_inventory_lines enable row level security;

-- Same posture as lab_shop_stock_counts: all real reads/writes go through server actions using
-- the service-role client, after requireShopOrStaffSession has verified the caller — this policy
-- only covers the admin dashboard's own direct Supabase client access, not the shop flow itself.
create policy lab_shop_official_inventory_sessions_manager on lab_shop_official_inventory_sessions
  for all using (current_role_of() = any (array['admin','lab_manager','assistant']::user_role[]))
  with check (current_role_of() = any (array['admin','lab_manager','assistant']::user_role[]));

create policy lab_shop_official_inventory_lines_manager on lab_shop_official_inventory_lines
  for all using (current_role_of() = any (array['admin','lab_manager','assistant']::user_role[]))
  with check (current_role_of() = any (array['admin','lab_manager','assistant']::user_role[]));
