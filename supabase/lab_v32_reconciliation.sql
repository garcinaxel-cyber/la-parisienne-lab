-- ================================================================
-- lab_v32_reconciliation.sql — 2026-08-07
-- Daily reconciliation check: independent audit of Odoo-vs-app quantities, on top of the
-- sync's own change detection (odoo-sync.ts only reacts to a diff it just saw; this
-- recomputes true demand vs what's tracked, for a rolling window, and catches BOTH
-- under-tracking (missing card) and over-tracking (duplicate card — the 2026-08-07
-- finger-cake incident, fixed by hand that day). Admin-only: no lab_manager, per Axel's
-- explicit instruction (this is a control tool, not an operational one).
-- ================================================================

CREATE TABLE IF NOT EXISTS lab_reconciliation_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_at        timestamptz NOT NULL DEFAULT now(),
  triggered_by  text NOT NULL DEFAULT 'cron',   -- 'cron' or the admin's full_name
  range_from    date NOT NULL,
  range_to      date NOT NULL,
  dates_checked int NOT NULL DEFAULT 0,
  issue_count   int NOT NULL DEFAULT 0,
  issues        jsonb NOT NULL DEFAULT '[]',
  error         text
);
CREATE INDEX IF NOT EXISTS lab_reconciliation_runs_run_at_idx ON lab_reconciliation_runs(run_at DESC);

ALTER TABLE lab_reconciliation_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "lab_reconciliation_admin" ON lab_reconciliation_runs;
CREATE POLICY "lab_reconciliation_admin" ON lab_reconciliation_runs FOR ALL TO authenticated
  USING (current_role_of() = 'admin'::user_role)
  WITH CHECK (current_role_of() = 'admin'::user_role);

-- Daily at 23:00 UTC = 06:00 Vietnam time — before the production day starts, so any
-- overnight drift is visible to the admin first thing in the morning.
select cron.unschedule('lab-reconciliation-daily')
where exists (select 1 from cron.job where jobname = 'lab-reconciliation-daily');

select cron.schedule(
  'lab-reconciliation-daily',
  '0 23 * * *',
  $$
  select net.http_get(
    url := 'https://la-parisienne-lab.vercel.app/api/odoo/reconciliation-check?secret=<CRON_SECRET>',
    timeout_milliseconds := 55000
  );
  $$
);
