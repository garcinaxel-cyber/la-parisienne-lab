-- lab_v155 — Online sales Stats v2 (Axel, 2026-11-14). Read-only aggregation helpers for the
-- online-sales Stats tab (Ads + Customer service). Applied on 2026-11-14 as migration
-- online_sales_stats_v2_functions. Service role only; no table is written.
create or replace function public.online_ads_attribution(p_from date, p_to date)
returns jsonb language sql stable set search_path = public as $$
with conv as (select c.id, c.ad_id, c.first_message_at from inbox_conversations c),
ph as (select distinct m.conversation_id, right(regexp_replace(x[1],'\D','','g'),9) k
  from inbox_messages m, regexp_matches(coalesce(m.text,''), '((?:\+?84|0)[ .-]?\d{2,3}[ .-]?\d{3}[ .-]?\d{3,4})', 'g') x
  where m.direction='in'),
ord as (select o.order_batch_id::text ob, o.created_at, right(regexp_replace(coalesce(o.customer_phone,''),'\D','','g'),9) k,
   coalesce((select sum(qty*unit_price) from lab_manual_cake_ledger l where l.order_batch_id=o.order_batch_id and cancelled_at is null),0)
 + coalesce((select sum(qty*unit_price) from lab_online_sale_lines s where s.order_batch_id=o.order_batch_id and not is_fee),0) - coalesce(o.refund_amount,0) val
  from lab_online_orders o where o.source not in ('event_stock','event_void') and o.delivery_date between p_from and p_to),
co as (select c.id conv_id, c.ad_id, ord.ob, ord.val from conv c join ph on ph.conversation_id=c.id join ord on ord.k=ph.k and length(ph.k)=9 and ord.created_at >= c.first_message_at - interval '1 day'
  union select c.id, c.ad_id, ord.ob, ord.val from conv c join inbox_conversation_orders x on x.conversation_id=c.id join ord on ord.ob=x.order_batch_id::text),
dedup as (select distinct on (ob) ob, ad_id, conv_id, val from co order by ob, ad_id nulls last),
camp as (select distinct ad_id, campaign_id from ads_insights_daily),
spend as (select campaign_id, max(campaign_name) n, sum(spend) s, sum(messaging_started) chats from ads_insights_daily where date between p_from and p_to group by campaign_id),
per as (select s.n, s.s, s.chats, count(d.ob) orders, coalesce(sum(d.val),0) rev
  from spend s left join camp on camp.campaign_id=s.campaign_id left join dedup d on d.ad_id=camp.ad_id group by s.n, s.s, s.chats),
pconv as (select id from inbox_conversations where first_message_at >= p_from and first_message_at < p_to + 1)
select jsonb_build_object(
  'campaigns', coalesce((select jsonb_agg(jsonb_build_object('name', n, 'spend', round(s), 'chats', chats, 'orders', orders, 'revenue', rev) order by s desc) from per), '[]'::jsonb),
  'conversations', (select count(*) from pconv),
  'conversationsWithPhone', (select count(distinct conversation_id) from ph where conversation_id in (select id from pconv)),
  'chatOrders', (select count(*) from dedup),
  'chatRevenue', (select coalesce(sum(val),0) from dedup),
  'chatConversationsWithOrder', (select count(distinct conv_id) from dedup where conv_id in (select id from pconv))
);
$$;

create or replace function public.online_service_stats(p_from date, p_to date)
returns jsonb language sql stable set search_path = public as $$
with m as (select conversation_id, direction, sent_at, lag(direction) over (partition by conversation_id order by sent_at) prev_dir
  from inbox_messages where sent_at >= (p_from::timestamp at time zone 'Asia/Ho_Chi_Minh') - interval '3 days'
    and sent_at < ((p_to + 1)::timestamp at time zone 'Asia/Ho_Chi_Minh') + interval '3 days'),
turns as (select m.conversation_id, m.sent_at,
  (select min(o.sent_at) from inbox_messages o where o.conversation_id=m.conversation_id and o.direction='out' and o.sent_at > m.sent_at) reply_at
  from m where m.direction='in' and (m.prev_dir is distinct from 'in')
    and m.sent_at >= (p_from::timestamp at time zone 'Asia/Ho_Chi_Minh') and m.sent_at < ((p_to + 1)::timestamp at time zone 'Asia/Ho_Chi_Minh')),
t2 as (select extract(hour from sent_at at time zone 'Asia/Ho_Chi_Minh')::int h, extract(epoch from reply_at - sent_at)/60 mins from turns),
hh as (select h, count(*) n, percentile_cont(0.5) within group (order by mins) med, count(*) filter (where mins is null) never from t2 group by h)
select jsonb_build_object(
  'hours', coalesce((select jsonb_agg(jsonb_build_object('h', h, 'n', n, 'median', round(med::numeric, 1), 'never', never) order by h) from hh), '[]'::jsonb),
  'total', (select count(*) from t2),
  'daytimeMedian', (select round((percentile_cont(0.5) within group (order by mins))::numeric, 1) from t2 where h between 8 and 21 and mins is not null),
  'within5Pct', (select round(100.0 * count(*) filter (where mins <= 5) / nullif(count(*), 0)) from t2),
  'night', (select count(*) from t2 where h >= 22 or h < 8),
  'nightMaxHours', (select round((max(mins) filter (where (h >= 22 or h < 8) and mins < 24*60) / 60)::numeric, 0) from t2),
  'lateOrNever', (select count(*) from t2 where mins is null or mins > 60),
  'never', (select count(*) from t2 where mins is null)
);
$$;

revoke all on function public.online_ads_attribution(date, date) from public, anon, authenticated;
revoke all on function public.online_service_stats(date, date) from public, anon, authenticated;
grant execute on function public.online_ads_attribution(date, date) to service_role;
grant execute on function public.online_service_stats(date, date) to service_role;
