-- v76 — Online-sales interface (Axel, 2026-09-09): explicit note of WHO delivers an online
-- "lab"-source order to the end customer, replacing the earlier plan of inferring it from
-- whether delivery_address is filled. Two values:
--   'shop'   — normal flow: the lab delivers to the shop (existing REP/SO), and the shop hands
--              the item to / delivers it to the customer. Default — every existing row and
--              every shop_stock row (irrelevant there, sold instantly at the counter) is 'shop'.
--   'direct' — the lab delivers straight to the customer's own address, bypassing the shop.
-- Surfaced on delivery-check (src/lib/delivery-check.ts) so lab/delivery staff know at a glance
-- whether an online order is meant to stop at the shop or go straight to the customer.
ALTER TABLE public.lab_online_orders
  ADD COLUMN IF NOT EXISTS delivery_mode text NOT NULL DEFAULT 'shop'
  CHECK (delivery_mode IN ('shop', 'direct'));
