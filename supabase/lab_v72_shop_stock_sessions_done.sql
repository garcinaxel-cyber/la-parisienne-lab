-- v72 — Kiểm kho: explicit "Hoàn tất" (Axel, 2026-09-06). The algorithmic completion check
-- (every SKU ever counted by the shop) never fires in practice (Bà Triệu 75/113, Timecity 92/104
-- on 09-06 evening) — the shop staff now declares the end of a count themselves; that is what
-- triggers the shop + admin push and feeds the nightly admin recap.
CREATE TABLE IF NOT EXISTS public.lab_shop_stock_sessions_done (
  shop_name text NOT NULL,
  count_date date NOT NULL,
  session_seq int NOT NULL DEFAULT 1,
  finished_at timestamptz NOT NULL DEFAULT now(),
  finished_by_name text,
  sku_count int NOT NULL DEFAULT 0,
  valuation numeric NOT NULL DEFAULT 0,
  PRIMARY KEY (shop_name, count_date, session_seq)
);
ALTER TABLE public.lab_shop_stock_sessions_done ENABLE ROW LEVEL SECURITY;

-- Nightly admin recap, 22:45 VN (registered separately via cron.schedule, copying the command
-- of an existing job so the CRON_SECRET stays inside Postgres):
--   select cron.schedule('stock-count-recap-2245vn', '45 15 * * *',
--     replace((select command from cron.job where jobname='chef-stock-reminder'), 'chef-stock-reminder', 'stock-count-recap'));
