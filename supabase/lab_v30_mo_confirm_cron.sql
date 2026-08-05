-- ================================================================
-- lab_v30_mo_confirm_cron.sql — 2026-08-05
-- Daily confirmation of the lab-day's remaining draft Odoo Manufacturing Orders.
-- Runs once at 15:15 UTC = 22:15 Vietnam time, 15 min after odoo-hourly-sync's last
-- tick of the day (14 UTC / 21:00 VN — see lab_v10_cron.sql), so every draft still
-- gets the full production day to absorb same-day quantity deltas before being
-- confirmed. See src/lib/odoo-mo-confirm.ts for the Bypass Subsequent handling
-- (semi-finished BOM components must get their child MO before the parent is
-- confirmed, or their own raw materials never get consumed).
-- ================================================================

select cron.unschedule('odoo-mo-confirm')
where exists (select 1 from cron.job where jobname = 'odoo-mo-confirm');

select cron.schedule(
  'odoo-mo-confirm',
  '15 15 * * *',
  $$
  select net.http_get(
    url := 'https://la-parisienne-lab.vercel.app/api/odoo/confirm-mos?secret=<CRON_SECRET>',
    timeout_milliseconds := 55000
  );
  $$
);
