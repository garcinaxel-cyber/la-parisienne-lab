-- v69 — Online-sales interface (Axel, 2026-09-06): a dedicated role/interface for the newly
-- hired online-sales person, replacing her personal Google Sheet. She keeps ordering through
-- the existing manual/exceptional-order mechanism (lab_manual_cakes + createOdooOrderForSelection)
-- but gets her own "Commande / Suivi / Analytic" screens, scoped to what SHE created.
--
-- Design recap (locked with Axel across several rounds):
--  - New role `online_sales`, own login, own space (/online-orders), never sees the admin app.
--  - Admin keeps full access to the same interface (sees everyone's orders, not just hers).
--  - "Canal" (Facebook page / traffic source: Hoàn Kiếm, Moon Flower, Website, Page Merci, ...)
--    is DISTINCT from "shop" (who actually fulfills/delivers — drives the Odoo document via the
--    existing SHOP_CONFIG). A canal is free text (not every source maps to a real shop).
--  - Money (unit price, delivery fee, payment status) does not exist anywhere in Odoo for these
--    documents (sale.order.line/replenishment lines carry no price here) — captured by hand.
--  - Two independent delivery signals: "livré par le lab" is derived from the existing
--    lab_delivery_orders.status='validated' data (no new column needed); "livré par le shop" is
--    her own manual toggle, stored below.
--  - Her historical Excel (73 rows) is NOT imported (Axel, 2026-09-06: "on importe pas son fichier").

ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'online_sales';

-- Per-line fields lab_manual_cakes didn't need before: sale price (VND) and the marketing
-- channel. Both nullable — every OTHER creation path (birthday-cakes, exceptional-orders,
-- shop token flow) leaves them null and is completely unaffected.
ALTER TABLE lab_manual_cakes ADD COLUMN IF NOT EXISTS unit_price numeric;
ALTER TABLE lab_manual_cakes ADD COLUMN IF NOT EXISTS channel text;

-- One row per order (= one order_batch_id, the id already shared by every line of one
-- checkout — see order/[token]/actions.ts). Holds exactly what doesn't belong on a
-- per-product line: delivery fee, payment status, the shop-delivered manual toggle, and who
-- created it (for her own "only my orders" scoping).
CREATE TABLE IF NOT EXISTS public.lab_online_orders (
  order_batch_id uuid PRIMARY KEY,
  delivery_fee numeric NOT NULL DEFAULT 0,
  payment_status text NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('paid', 'unpaid', 'partial')),
  amount_paid numeric NOT NULL DEFAULT 0,
  shop_delivered boolean NOT NULL DEFAULT false,
  shop_delivered_at timestamptz,
  shop_delivered_by uuid REFERENCES profiles(id),
  created_by uuid REFERENCES profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Set once the 24h-late-payment push has fired for this order, so the cron never re-alerts
  -- on the same order every run.
  payment_alert_sent_at timestamptz
);
CREATE INDEX IF NOT EXISTS lab_online_orders_created_by_idx ON public.lab_online_orders(created_by);
CREATE INDEX IF NOT EXISTS lab_online_orders_payment_idx ON public.lab_online_orders(payment_status) WHERE payment_status <> 'paid';

-- Service-role only (same posture as lab_manual_cakes and every other table this app's server
-- actions touch via the service-role key after their own session/role check) — RLS enabled,
-- zero policies, so anon/authenticated are fully locked out and only the server actions below
-- can read/write it.
ALTER TABLE public.lab_online_orders ENABLE ROW LEVEL SECURITY;

-- Push notifications for her account reuse the existing shop-push mechanism (sendShopPush)
-- keyed by a pseudo shop_name, same trick already used for admin (ADMIN_RELAY_PSEUDO_TEAM in
-- push-notify.ts) — no new subscription table needed.

-- The late-payment alert cron (src/app/api/odoo/online-order-payment-alert/route.ts) is
-- DELIBERATELY NOT registered here — this feature is being built on a preview deployment
-- first (Axel, 2026-09-06: "tu lances une preview sur vercel, tu mets pas en prod"), and
-- lab_v49's own cron entries show every pg_cron job points at the PRODUCTION domain
-- (la-parisienne-lab.vercel.app), which doesn't have this route yet. Once this branch is
-- reviewed and merged to main, register it the same way as the others, e.g.:
--   select cron.schedule(
--     'online-order-payment-alert',
--     '*/30 * * * *',
--     $$ select net.http_get(
--       url := 'https://la-parisienne-lab.vercel.app/api/odoo/online-order-payment-alert?secret=<CRON_SECRET>',
--       timeout_milliseconds := 55000
--     ); $$
--   );
