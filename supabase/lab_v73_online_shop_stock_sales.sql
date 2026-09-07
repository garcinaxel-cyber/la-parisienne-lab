-- v73 — Online sales from SHOP STOCK (Axel, 2026-09-07): the online seller can also record a
-- sale served directly from a shop's existing stock (already delivered by that morning's REP).
-- Hard rule: ZERO Odoo / production impact — these lines live in their own table and never go
-- through lab_manual_cakes (which drives chef cards, /exceptional-orders and the Odoo sync).
-- The shop still rings the sale in its POS; Odoo SO analysis stays the source of truth for
-- revenue — the online Analytic tab is an attribution view only.
ALTER TABLE public.lab_online_orders
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'lab' CHECK (source IN ('lab', 'shop_stock')),
  ADD COLUMN IF NOT EXISTS shop_name text,
  ADD COLUMN IF NOT EXISTS channel text,
  ADD COLUMN IF NOT EXISTS delivery_date date,
  ADD COLUMN IF NOT EXISTS customer_name text,
  ADD COLUMN IF NOT EXISTS customer_phone text,
  ADD COLUMN IF NOT EXISTS delivery_address text,
  ADD COLUMN IF NOT EXISTS notes text;

CREATE TABLE IF NOT EXISTS public.lab_online_sale_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_batch_id uuid NOT NULL REFERENCES public.lab_online_orders(order_batch_id) ON DELETE CASCADE,
  fiche_id uuid,
  variant_id uuid,
  sku text,
  product_name_vi text NOT NULL,
  category text,
  qty int NOT NULL CHECK (qty > 0),
  unit_price numeric NOT NULL DEFAULT 0,
  line_note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS lab_online_sale_lines_batch_idx ON public.lab_online_sale_lines(order_batch_id);
ALTER TABLE public.lab_online_sale_lines ENABLE ROW LEVEL SECURITY;
