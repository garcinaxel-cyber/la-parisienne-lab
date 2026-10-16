-- Products a shop received that were NOT on the delivery (Axel, 2026-10-16: Time City got 2 Le
-- Jardin that were on no slip). The shop declares them in its reception (photo required); the Lab
-- settles them on the Delivery gaps page:
--   customer_order : it was a customer's order (sales order) delivered to the wrong place. The
--                    customer is not charged (return on its delivery + invoice back to draft
--                    without these units), and the shop keeps the goods (transfer LAB -> shop).
--   lab_extra      : sent by mistake / unknown origin -> transfer LAB -> shop only.
--   shop_error     : nothing extra in fact -> nothing in Odoo.
-- Accessed only through the service role (server actions), like the other reception tables.
create table if not exists lab_offslip_items (
  id uuid primary key default gen_random_uuid(),
  delivery_order_id uuid references lab_delivery_orders(id) on delete set null,
  order_ref text,
  delivery_date date not null,
  shop_name text not null,
  sku text not null,
  product_name text not null,
  qty numeric not null check (qty > 0),
  photo_urls text[] not null default '{}',
  note text,
  declared_by_name text not null,
  declared_at timestamptz not null default now(),
  status text not null default 'open' check (status in ('open', 'closed')),
  lab_cause text check (lab_cause is null or lab_cause in ('customer_order', 'lab_extra', 'shop_error')),
  source_order_ref text,
  decided_by_name text,
  decided_at timestamptz,
  odoo_mode text check (odoo_mode is null or odoo_mode in ('sent', 'simulated')),
  odoo_log jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists lab_offslip_items_open_idx on lab_offslip_items (delivery_date) where status = 'open';
create index if not exists lab_offslip_items_shop_idx on lab_offslip_items (shop_name, delivery_date);
alter table lab_offslip_items enable row level security;
