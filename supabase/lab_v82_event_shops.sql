-- Event shops (Axel, 2026-09-12): temporary pop-up "shop" tied to an Odoo warehouse Axel
-- configures himself. The app never creates the Odoo warehouse — it only looks it up by code
-- and stores the link here. `name` doubles as the shop_name used everywhere downstream
-- (lab_shop_losses, lab_shop_stock_count_items, lab_online_orders, etc.) exactly like a real
-- shop's display name in SHOP_CONFIG, so every existing per-shop tab works for an event for free
-- once requireShopSession/requireShopOrStaffSession resolve to it.
--
-- Access is a single PIN (Axel: "un seul PIN") used both to enter the event portal AND to
-- confirm sales/orders inside it — no Supabase auth account. Staff reach it via a discreet
-- button inside their OWN shop's normal portal session (Axel: staff already have their shop's
-- app open), so this table is looked up by pin_hash only, never by a user_id.
--
-- Only one ACTIVE row may share the same name / pin_hash / warehouse_code at a time (partial
-- unique indexes) — closing an event (active=false) frees all three for reuse without deleting
-- history.
create table if not exists lab_event_shops (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  warehouse_code text not null,
  odoo_warehouse_id integer not null,
  pin_hash text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  closed_at timestamptz,
  created_by uuid references auth.users(id)
);

create unique index if not exists lab_event_shops_active_name_idx
  on lab_event_shops (lower(name)) where active;
create unique index if not exists lab_event_shops_active_pin_idx
  on lab_event_shops (pin_hash) where active;
create unique index if not exists lab_event_shops_active_warehouse_idx
  on lab_event_shops (warehouse_code) where active;

alter table lab_event_shops enable row level security;

-- Server-side only (service-role client) — same posture as lab_shop_managers: no anon/authenticated
-- policy at all, every read/write goes through a server action that has already checked the caller.
