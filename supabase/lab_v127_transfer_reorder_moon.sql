-- v127 — Transfers: re-order suggestion + Hoàn Kiếm (Moon Flower) transfers (Axel, 2026-10-16).
-- Additive only.
--  1. The SENDING shop's next order suggests re-ordering what it transferred out (same block as
--     the delivery short/damaged suggestions, lab_v123). Status per transfer line.
--  2. Transfers to / from Moon Flower (a customer in Odoo, no warehouse): shop → Moon is a Moon
--     sale.order delivered from the sender's warehouse; Moon → shop is a return on Moon's latest
--     unpaid Lab deliveries into the receiving shop's stock. The Odoo refs are kept here.
ALTER TABLE public.lab_shop_transfer_lines
  ADD COLUMN IF NOT EXISTS reorder_status text CHECK (reorder_status IN ('added', 'dismissed')),
  ADD COLUMN IF NOT EXISTS reorder_at timestamptz,
  ADD COLUMN IF NOT EXISTS reorder_by_name text;

ALTER TABLE public.lab_shop_transfers
  ADD COLUMN IF NOT EXISTS odoo_so_id bigint,
  ADD COLUMN IF NOT EXISTS odoo_so_name text,
  ADD COLUMN IF NOT EXISTS odoo_docs text;   -- human summary of the Odoo pieces (returns, invoices)
