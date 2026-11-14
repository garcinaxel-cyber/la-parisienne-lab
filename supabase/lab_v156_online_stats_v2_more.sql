-- lab_v156 — Online sales Stats v2, round 2 (Axel, 2026-11-14). Applied as Supabase migration
-- "online_sales_stats_v2_more". Read-only SQL helpers, service role only, no table written:
--   · online_ads_attribution(p_from, p_to)  — v155 + per-campaign impressions/reach/clicks and a
--     daily series (spend, chats, revenue traced to ads)
--   · online_service_stats(p_from, p_to)    — v155 + per Facebook page, per weekday, per day
--   · online_overview_extras(p_from, p_to)  — NEW: lab vs shop stock vs import, money to collect,
--     refunds, delivery fees, new vs returning customers, revenue by weekday
-- Full current definitions: select pg_get_functiondef('public.<name>(date,date)'::regprocedure);
-- They are also allow-listed as read-only RPCs in src/lib/preview-guard.ts.
revoke all on function public.online_overview_extras(date, date) from public, anon, authenticated;
grant execute on function public.online_overview_extras(date, date) to service_role;
