-- v75 — Online-sales interface: configurable extra fees (nến sinh nhật, nón sinh nhật, nơ trang
-- trí...) the online-sales person can add to a cart, next to the shared "Kênh bán hàng" list.
-- Axel, 2026-09-07: shared by anyone with online-orders access (same posture as
-- lab_online_channels), no Odoo/production impact at all — the resulting line is a plain
-- lab_online_sale_lines row (fiche_id null, is_fee true), counted in revenue, category "Khác".
-- Service-role only (RLS on, no policies), same posture as lab_online_channels/lab_online_orders.
CREATE TABLE IF NOT EXISTS public.lab_online_extra_fees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  emoji text,
  label text NOT NULL,
  default_price numeric NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES profiles(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.lab_online_extra_fees ENABLE ROW LEVEL SECURITY;
INSERT INTO public.lab_online_extra_fees (emoji, label, default_price) VALUES
  ('🕯️', 'Nến sinh nhật', 10000),
  ('🎉', 'Nón sinh nhật', 15000),
  ('🎀', 'Nơ trang trí', 5000)
ON CONFLICT DO NOTHING;

-- lab_online_sale_lines already has no Odoo/production coupling (used for shop-stock sales) —
-- reused here as the generic home for any non-catalogue revenue line, on EITHER order source
-- ('lab' or 'shop_stock'). is_fee=true + fiche_id null marks a fee line explicitly.
ALTER TABLE public.lab_online_sale_lines ADD COLUMN IF NOT EXISTS is_fee boolean NOT NULL DEFAULT false;
