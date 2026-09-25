-- OEM Orders tracker, steps 4-7 (Axel, 2026-09-25). Additive only.
-- 1) lab_mm_deliveries(): read-only projection of the delivery check restricted to OEM SKUs
--    (MM- / OEM-). The delivery tables stay admin/lab_manager/assistant-only; this function lets
--    Team Hung's station see the same Deliveries tab without widening those tables' RLS.
-- 2) Setting odoo_mo_enabled: packaging entries create + validate the finished-product MO in
--    Odoo only when 'true' (off by default so the preview can be tested without touching Odoo;
--    entries saved while off stay "pending" and can be pushed later from the log).

create or replace function lab_mm_deliveries()
returns table (
  order_ref text, delivery_date date, customer text, sku text,
  qty_planned numeric, qty_expected numeric, qty_checked numeric, line_status text,
  order_status text, validated_at timestamptz, validated_by_name text,
  not_delivered boolean, odoo_push_status text, odoo_validated_at timestamptz
)
language sql stable security definer set search_path = public as $$
  with planned as (
    select p.order_ref, p.delivery_date::date as delivery_date, max(p.shop_name)::text as customer, p.sku, sum(p.qty) as qty
      from lab_order_packaging_lines p
     where p.sku ~ '^(MM|OEM)-'
     group by p.order_ref, p.delivery_date, p.sku
  ), checked as (
    select o.order_ref, o.delivery_date::date as delivery_date, coalesce(o.customer_name, o.shop_name)::text as customer, l.sku,
           sum(l.qty_expected) as qty_expected,
           sum(case when l.status::text = 'pending' then null else coalesce(l.qty_checked, l.qty_expected) end) as qty_checked,
           case when bool_and(l.status::text <> 'pending') then 'checked' else 'pending' end as line_status,
           max(o.status::text) as order_status, max(o.validated_at) as validated_at, max(o.validated_by_name) as validated_by_name,
           bool_or(o.marked_not_delivered) as not_delivered, max(o.odoo_push_status::text) as odoo_push_status,
           max(o.odoo_validated_at) as odoo_validated_at
      from lab_delivery_check_lines l
      join lab_delivery_orders o on o.id = l.delivery_order_id
     where l.sku ~ '^(MM|OEM)-'
     group by o.order_ref, o.delivery_date, coalesce(o.customer_name, o.shop_name), l.sku
  )
  select coalesce(c.order_ref, p.order_ref)::text, coalesce(c.delivery_date, p.delivery_date), coalesce(c.customer, p.customer),
         coalesce(c.sku, p.sku)::text, p.qty::numeric, c.qty_expected::numeric, c.qty_checked::numeric, c.line_status, c.order_status, c.validated_at,
         c.validated_by_name::text, coalesce(c.not_delivered, false), c.odoo_push_status, c.odoo_validated_at
    from planned p
    full join checked c on c.order_ref = p.order_ref and c.delivery_date = p.delivery_date and c.sku = p.sku
   where current_role_of() = any (array['admin','lab_manager','assistant','chef','worker']::user_role[])
   order by 2 desc, 1, 4;
$$;
revoke all on function lab_mm_deliveries() from public, anon;
grant execute on function lab_mm_deliveries() to authenticated;

insert into lab_mm_settings (key, value) values ('odoo_mo_enabled', 'false')
on conflict (key) do nothing;

-- lab_v92 (applied separately): Odoo reference (MO name / scrap id) on packaging entries.
alter table lab_mm_packaging_log add column if not exists odoo_ref text;
create index if not exists lab_mm_packaging_log_date_idx on lab_mm_packaging_log (pack_date desc);
create index if not exists lab_mm_production_log_date_idx on lab_mm_production_log (prod_date desc);
