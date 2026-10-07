-- lab_v98 — event till: sales aggregated in the database. Applied in production on 2026-10-07.
-- The till used to read every sale order of the event, then its lines with
-- order_batch_id IN (<every order id>): one UUID per sale in the request URL and a 1 000-row
-- page cap, both of which a busy four-day fair reaches. These return a few rows whatever the
-- number of sales. Read-only; called by the server with the service role only.
create or replace function public.lab_event_sales_agg(p_shop text, p_by_day boolean default false)
returns table (sale_date date, sku text, product_name_vi text, qty numeric, revenue numeric)
language sql stable
set search_path = public
as $$
  select case when p_by_day then (o.created_at at time zone 'Asia/Ho_Chi_Minh')::date end as sale_date,
         l.sku,
         min(regexp_replace(l.product_name_vi, ' \(miễn phí\)$', '')) as product_name_vi,
         sum(l.qty)::numeric as qty,
         sum(l.qty * l.unit_price)::numeric as revenue
  from public.lab_online_orders o
  join public.lab_online_sale_lines l on l.order_batch_id = o.order_batch_id
  where o.shop_name = p_shop and o.source = 'event_stock' and l.is_fee = false and l.sku is not null
  group by 1, 2
  order by 1 nulls first, 2;
$$;

create or replace function public.lab_event_sales_totals(p_shop text)
returns table (order_count bigint, total_revenue numeric, cash_revenue numeric, transfer_revenue numeric)
language sql stable
set search_path = public
as $$
  select count(*)::bigint,
         coalesce(sum(o.amount_paid), 0)::numeric,
         coalesce(sum(o.amount_paid) filter (where o.payment_method is distinct from 'transfer'), 0)::numeric,
         coalesce(sum(o.amount_paid) filter (where o.payment_method = 'transfer'), 0)::numeric
  from public.lab_online_orders o
  where o.shop_name = p_shop and o.source = 'event_stock';
$$;

revoke all on function public.lab_event_sales_agg(text, boolean) from public, anon, authenticated;
revoke all on function public.lab_event_sales_totals(text) from public, anon, authenticated;
grant execute on function public.lab_event_sales_agg(text, boolean) to service_role;
grant execute on function public.lab_event_sales_totals(text) to service_role;
