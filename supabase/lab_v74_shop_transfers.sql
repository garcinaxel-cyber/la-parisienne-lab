-- v74 — Inter-shop stock transfers (Axel, 2026-09-07: "transferts de stock entre shops … et que
-- ça se fasse sur Odoo aussi"). A La Paris shop sends products to another La Paris shop from its
-- portal; Odoo records it as ONE internal transfer (stock.picking, A/Stock -> B/Stock) created at
-- send time and validated at reception time — that validation is the only moment stock moves in
-- Odoo. No sale.order, no invoice, no replenishment request: never enters the lab's production
-- flow (odoo-sync.ts reads SO/REP only). These tables are the portal's view + history; the Odoo
-- picking stays the stock truth.
CREATE TABLE IF NOT EXISTS public.lab_shop_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ref text NOT NULL UNIQUE,                     -- TRF-<from code>-<to code>-<n>, shown to the shops
  from_shop text NOT NULL,
  to_shop text NOT NULL,
  status text NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'received', 'cancelled')),
  odoo_picking_id bigint,
  odoo_picking_name text,
  sent_by_name text,
  sent_by_manager_id uuid,
  sent_at timestamptz NOT NULL DEFAULT now(),
  received_by_name text,
  received_at timestamptz,
  cancelled_by_name text,
  cancelled_at timestamptz,
  note text,
  line_count int NOT NULL DEFAULT 0,
  unit_count numeric NOT NULL DEFAULT 0,
  reminder_sent_on date,                        -- last VN date a "not yet received" reminder went out
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (from_shop <> to_shop)
);
CREATE INDEX IF NOT EXISTS lab_shop_transfers_from_idx ON public.lab_shop_transfers (from_shop, sent_at DESC);
CREATE INDEX IF NOT EXISTS lab_shop_transfers_to_idx ON public.lab_shop_transfers (to_shop, sent_at DESC);
CREATE INDEX IF NOT EXISTS lab_shop_transfers_status_idx ON public.lab_shop_transfers (status, sent_at);
ALTER TABLE public.lab_shop_transfers ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.lab_shop_transfer_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_id uuid NOT NULL REFERENCES public.lab_shop_transfers(id) ON DELETE CASCADE,
  sku text NOT NULL,
  product_name_vi text NOT NULL,
  category text,
  image_url text,
  qty_sent numeric NOT NULL CHECK (qty_sent > 0),
  qty_received numeric,                         -- null until the receiving shop confirms
  line_note text,
  odoo_move_id bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (transfer_id, sku)
);
CREATE INDEX IF NOT EXISTS lab_shop_transfer_lines_transfer_idx ON public.lab_shop_transfer_lines (transfer_id);
ALTER TABLE public.lab_shop_transfer_lines ENABLE ROW LEVEL SECURITY;

-- Per-pair sequence for the human ref (TRF-LPBT-LPTC-0007).
CREATE SEQUENCE IF NOT EXISTS public.lab_shop_transfer_ref_seq;

-- 24h "not yet received" reminder, hourly 08:00-21:00 VN (= 01-14 UTC), registered separately by
-- copying an existing job's command so CRON_SECRET stays inside Postgres:
--   select cron.schedule('shop-transfer-reminder', '5 1-14 * * *',
--     replace((select command from cron.job where jobname='chef-stock-reminder'), 'chef-stock-reminder', 'shop-transfer-reminder'));

-- Human ref counter, callable by the service role only (PostgREST has no bare nextval()).
CREATE OR REPLACE FUNCTION public.lab_shop_transfer_next_seq() RETURNS bigint
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$ SELECT nextval('public.lab_shop_transfer_ref_seq') $$;
REVOKE ALL ON FUNCTION public.lab_shop_transfer_next_seq() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lab_shop_transfer_next_seq() TO service_role;
