-- ================================================================
-- lab_v10_cron.sql — 2026-07-09
-- Hourly Odoo auto-sync via pg_cron + pg_net (Supabase built-ins).
-- Calls the lab app's cron endpoint which creates DRAFT imports
-- (an assistant reviews and publishes — nothing goes live alone).
-- ZERO impact on catalogue tables.
-- Replace <CRON_SECRET> with the value set in Vercel env.
-- ================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Remove a previous schedule if re-running
select cron.unschedule('odoo-hourly-sync')
where exists (select 1 from cron.job where jobname = 'odoo-hourly-sync');

-- Every hour at :05, from 05:00 to 21:00 UTC+7 (= 22:00–14:00 UTC) — workshop hours
select cron.schedule(
  'odoo-hourly-sync',
  '5 * * * *',
  $$
  select net.http_get(
    url := 'https://la-parisienne-lab.vercel.app/api/odoo/cron?secret=<CRON_SECRET>',
    timeout_milliseconds := 55000
  );
  $$
);
