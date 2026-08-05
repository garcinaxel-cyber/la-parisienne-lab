-- ================================================================
-- lab_v31_odoo_sync_tiered_cron.sql — 2026-08-05
-- Replace the flat every-15-min odoo-hourly-sync with a two-tier schedule, based on the real
-- order-arrival distribution (Odoo sale.order + stock.replenishment.request create_date, last 30
-- days, 621 orders, checked live via the Odoo JSON-RPC session on 2026-08-05):
--
--   VN hour   05  06  07  08  09  10  11  12  13  14  15  16  17  18  19  20  21
--   orders     0   4  15  56  52  42  51  64 124  74  51  35   7   6   2   6  10
--
-- Real peak is 07h-16h VN (sustained high volume, 13h spikes to 124/month) — wider than the
-- naive guess from sync-detection timestamps (which only reflected the old cron's own cadence,
-- not actual order placement time). Everything outside that (05h-06h, 17h-21h VN) is genuinely
-- quiet — 0 to 10 orders/month per hour — so it's safe to slow down there without hurting
-- freshness where it actually matters. The manual "Sync Odoo" button and the exceptional-orders
-- flow are unaffected either way (both bypass this cron entirely for anything urgent).
--
--   07h-16h VN (UTC 00-09) : every 15 min, unchanged  → 40 calls/day
--   05h-06h + 17h-21h VN (UTC 22-23, 10-14) : every 30 min → 14 calls/day
--   total: 54 calls/day vs 68/day before (-21%), concentrated where it doesn't cost freshness.
-- ================================================================

select cron.unschedule('odoo-hourly-sync')
where exists (select 1 from cron.job where jobname = 'odoo-hourly-sync');

select cron.unschedule('odoo-sync-peak')
where exists (select 1 from cron.job where jobname = 'odoo-sync-peak');

select cron.unschedule('odoo-sync-offpeak')
where exists (select 1 from cron.job where jobname = 'odoo-sync-offpeak');

-- Peak: 07h-16h VN = 00-09h UTC, every 15 min
select cron.schedule(
  'odoo-sync-peak',
  '*/15 0-9 * * *',
  $$
  select net.http_get(
    url := 'https://la-parisienne-lab.vercel.app/api/odoo/cron?secret=<CRON_SECRET>',
    timeout_milliseconds := 55000
  );
  $$
);

-- Off-peak: 05h-06h + 17h-21h VN = 22-23h + 10-14h UTC, every 30 min
select cron.schedule(
  'odoo-sync-offpeak',
  '*/30 22-23,10-14 * * *',
  $$
  select net.http_get(
    url := 'https://la-parisienne-lab.vercel.app/api/odoo/cron?secret=<CRON_SECRET>',
    timeout_milliseconds := 55000
  );
  $$
);
