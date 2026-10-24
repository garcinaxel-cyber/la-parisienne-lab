-- Made without order (Axel, 2026-10-24): one row per lab day × product once someone answered
-- "where are the units the kitchen declared but no order took?" (Tasks · Delivery gaps ①).
create table if not exists lab_made_without_order (
  id uuid primary key default gen_random_uuid(),
  delivery_date date not null,
  sku text not null,
  product_name text,
  qty numeric not null,
  resolution text not null check (resolution in ('to_stock','lost','not_made')),
  resolved_by_name text,
  resolved_at timestamptz not null default now(),
  odoo_status text,
  odoo_error text,
  ref text,
  unique (delivery_date, sku)
);
alter table lab_made_without_order enable row level security;
create policy lab_made_without_order_staff on lab_made_without_order for select to authenticated
  using (exists (select 1 from profiles p where p.id = auth.uid() and p.role in ('admin','lab_manager','assistant')));
