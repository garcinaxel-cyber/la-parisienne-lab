-- ================================================================
-- lab_v46_check_and_blocked_tracking.sql — 2026-08-20
-- Two additive changes, both requested by Axel:
--
-- 1. Blocked-card traceability. lab_assignments.blocked_reason was a bare string with no
--    who/when — an analytics "3× manque temps" line was a dead end, impossible to go find
--    the actual card. blocked_at/blocked_by_name are stamped by StationView on block (see
--    StationView.tsx saveBlocked()) and deliberately NEVER cleared on unblock — with no
--    separate event-log table (kept out on purpose, storage-conscious), these two columns can
--    only remember the LAST block on a card, not a full history if it was blocked >1 time. A
--    lightweight compromise: still lets the "blocking frequency over time" analytics chart see
--    real dates without a new table.
--
-- 2. Unify the daily reconciliation check into "Check": one button/cron run now produces 4
--    sub-results instead of just reconciliation. Reusing lab_reconciliation_runs (RLS, cron,
--    admin page all already wired) rather than 4 new tables — additive columns only, existing
--    issues/issue_count keep meaning "reconciliation" exactly as before (zero risk to the
--    existing cron/action code paths if this migration ships ahead of the code that fills the
--    new columns). check_range_from/to is the 3 new checks' own trailing 7-day window,
--    separate from reconciliation's own forward-looking range_from/to.
--    7-day retention (Axel, 2026-08-20) via a new purge cron below.
-- ================================================================

ALTER TABLE lab_assignments
  ADD COLUMN IF NOT EXISTS blocked_at timestamptz,
  ADD COLUMN IF NOT EXISTS blocked_by_name text;

ALTER TABLE lab_reconciliation_runs
  ADD COLUMN IF NOT EXISTS check_range_from date,
  ADD COLUMN IF NOT EXISTS check_range_to   date,
  ADD COLUMN IF NOT EXISTS delivery_coverage_issues jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS delivery_coverage_count  int  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS production_stock_issues  jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS production_stock_count   int  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS stock_odoo_issues         jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS stock_odoo_count          int  NOT NULL DEFAULT 0;

-- 7-day retention for check runs (Axel, 2026-08-20 — down from the implicit "forever" the
-- table had before). Scheduled 10 min after the existing 'lab-reconciliation-daily' cron
-- (23:00 UTC / 06:00 VN, lab_v32) so the fresh run of the day is never at risk of racing its
-- own purge.
SELECT cron.unschedule('lab-check-runs-purge')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'lab-check-runs-purge');

SELECT cron.schedule(
  'lab-check-runs-purge',
  '10 23 * * *',
  $$DELETE FROM lab_reconciliation_runs WHERE run_at < now() - interval '7 days'$$
);
