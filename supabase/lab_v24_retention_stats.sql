-- v24 — Data retention (60 days) + daily aggregates for long-term analytics.
-- Raw detail (imports, order lines, production cards, transfers, manual orders,
-- Odoo change log) is kept 60 days: the app never needs more, and Odoo remains the
-- system of record. BEFORE anything is purged, each day is summarised into
-- lab_daily_stats (day × team × product) — a few KB per day, kept forever —
-- which powers the Analytics 6-month / 1-year ranges.

-- ── 1. Aggregate table ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS lab_daily_stats (
  day           date NOT NULL,
  team          text NOT NULL,
  sku           text,
  product_name  text NOT NULL DEFAULT '',
  qty_ordered   int  NOT NULL DEFAULT 0,  -- planned units from client orders (extras excluded)
  qty_produced  int  NOT NULL DEFAULT 0,  -- actually produced (done + partial, extras included)
  qty_extra     int  NOT NULL DEFAULT 0,  -- of which extra production
  cards_total   int  NOT NULL DEFAULT 0,  -- production cards (non-cancelled)
  cards_done    int  NOT NULL DEFAULT 0,  -- done or in-stock
  cards_blocked int  NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS lab_daily_stats_key
  ON lab_daily_stats(day, team, coalesce(sku, product_name));
CREATE INDEX IF NOT EXISTS lab_daily_stats_day ON lab_daily_stats(day);

ALTER TABLE lab_daily_stats ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "lab_daily_stats_read" ON lab_daily_stats;
CREATE POLICY "lab_daily_stats_read" ON lab_daily_stats FOR SELECT TO authenticated
  USING (current_role_of() IN ('admin','lab_manager','assistant'));
-- writes happen only via the SECURITY DEFINER function below (cron/postgres)

-- ── 2. Aggregation: recompute ONE day from the raw cards ────────────────────
CREATE OR REPLACE FUNCTION lab_aggregate_day(p_day date) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  DELETE FROM lab_daily_stats WHERE day = p_day;
  INSERT INTO lab_daily_stats
    (day, team, sku, product_name, qty_ordered, qty_produced, qty_extra, cards_total, cards_done, cards_blocked)
  SELECT
    p_day, a.team, max(v.sku), coalesce(max(a.product_name_vi), ''),
    coalesce(sum(CASE WHEN NOT coalesce(a.is_extra,false) AND NOT coalesce(a.cancelled,false)
                      THEN a.qty_to_produce ELSE 0 END), 0),
    coalesce(sum(CASE WHEN coalesce(a.cancelled,false) THEN 0
                      WHEN a.status = 'done'    THEN coalesce(nullif(a.qty_produced,0), a.total_qty)
                      WHEN a.status = 'partial' THEN coalesce(a.qty_produced,0)
                      ELSE 0 END), 0),
    coalesce(sum(CASE WHEN coalesce(a.is_extra,false) AND a.status = 'done' AND NOT coalesce(a.cancelled,false)
                      THEN coalesce(a.qty_produced,0) ELSE 0 END), 0),
    count(*) FILTER (WHERE NOT coalesce(a.cancelled,false)),
    count(*) FILTER (WHERE NOT coalesce(a.cancelled,false) AND a.status IN ('done','skip')),
    count(*) FILTER (WHERE NOT coalesce(a.cancelled,false) AND a.status = 'blocked')
  FROM lab_assignments a
  JOIN lab_imports i ON i.id = a.import_id AND i.status = 'published' AND i.delivery_date = p_day
  LEFT JOIN lab_fiche_variants v ON v.id = a.variant_id
  GROUP BY a.team, coalesce(v.sku, a.product_name_vi);
END $$;

-- ── 3. Purge: aggregate then delete raw data older than p_keep_days ─────────
CREATE OR REPLACE FUNCTION lab_purge_old(p_keep_days int DEFAULT 60) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE d date;
BEGIN
  -- safety: (re)aggregate every day about to be purged
  FOR d IN SELECT DISTINCT delivery_date FROM lab_imports
           WHERE status = 'published' AND delivery_date < current_date - p_keep_days LOOP
    PERFORM lab_aggregate_day(d);
  END LOOP;
  -- imports cascade to lab_order_lines + lab_assignments
  DELETE FROM lab_imports      WHERE delivery_date < current_date - p_keep_days;
  DELETE FROM lab_manual_cakes WHERE delivery_date < current_date - p_keep_days;
  DELETE FROM lab_stock_transfers WHERE created_at < now() - make_interval(days => p_keep_days);
  DELETE FROM lab_odoo_changes WHERE detected_at < now() - make_interval(days => p_keep_days);
END $$;

-- ── 4. Backfill: aggregate every published day already in the base ──────────
DO $$
DECLARE d date;
BEGIN
  FOR d IN SELECT DISTINCT delivery_date FROM lab_imports WHERE status = 'published' LOOP
    PERFORM lab_aggregate_day(d);
  END LOOP;
END $$;

-- ── 5. Schedules (pg_cron already enabled by lab_v10) ───────────────────────
-- Nightly at 00:30 VN (17:30 UTC): aggregate yesterday + today (Asia/Ho_Chi_Minh)
SELECT cron.unschedule('lab-daily-stats')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'lab-daily-stats');
SELECT cron.schedule(
  'lab-daily-stats',
  '30 17 * * *',
  $$SELECT lab_aggregate_day(((now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date) - 1);
    SELECT lab_aggregate_day((now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date);$$
);

-- Weekly purge, Monday 01:00 VN (Sunday 18:00 UTC), 60-day retention
SELECT cron.unschedule('lab-purge')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'lab-purge');
SELECT cron.schedule('lab-purge', '0 18 * * 0', $$SELECT lab_purge_old(60)$$);
