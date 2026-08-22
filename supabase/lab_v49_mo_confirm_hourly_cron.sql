-- ================================================================
-- lab_v49_mo_confirm_hourly_cron.sql — 2026-08-22
-- Axel: "je voudrais me rapprocher d'une production en temps réel sur Odoo, le stock a un
-- décalage car le done est à 22h" — the MO's product_qty is already refreshed continuously
-- during the day (odoo-sync-peak/offpeak, every 15-30 min, see lab_v31), but the MO only moves
-- REAL stock (raw materials consumed, finished goods received) once button_mark_done runs — and
-- that only happened once/day at 22:15 VN (lab_v30_mo_confirm_cron.sql). This is the actual lag.
--
-- Safe to run more often: confirmDoneMOs()/produceMOs() (odoo-mo-confirm.ts) are idempotent and
-- never depend on lab_assignments partial quantities — they just confirm+validate whatever the
-- MO's own product_qty already is (kept correct by the 15-min stock sync). If more stock for the
-- same product is sent AFTER an hourly run already validated it, syncStockToOdoo simply opens a
-- fresh small draft MO for the delta (documented behaviour, odoo-mo-confirm.ts:83-85) — picked up
-- by the next hourly run. Trade-off: a product can end up with 2-3 MOs/day instead of 1
-- (cosmetic fragmentation in Odoo), in exchange for stock being current within ~1h instead of
-- until 22h15.
--
-- Adds an HOURLY run 08h-16h VN (= 01h-09h UTC, VN = UTC+7) covering the production day.
-- The existing 'odoo-mo-confirm' job (15:15 UTC = 22:15 VN) is left UNCHANGED — it remains the
-- end-of-day closing run that gives any very-late same-day addition the full day to land before
-- being swept up, exactly as before.
-- ================================================================

select cron.unschedule('odoo-mo-confirm-hourly')
where exists (select 1 from cron.job where jobname = 'odoo-mo-confirm-hourly');

select cron.schedule(
  'odoo-mo-confirm-hourly',
  '0 1-9 * * *',
  $$
  select net.http_get(
    url := 'https://la-parisienne-lab.vercel.app/api/odoo/confirm-mos?secret=<CRON_SECRET>',
    timeout_milliseconds := 55000
  );
  $$
);
