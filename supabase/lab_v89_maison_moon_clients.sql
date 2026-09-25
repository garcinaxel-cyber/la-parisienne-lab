-- Maison Moon tracker — the cashews belong to a different client than the biscuits.
-- Each order line now carries its own Odoo customer (used to recognise the delivery orders
-- imported through the normal delivery-check flow). Additive, lab_mm_* tables only.
-- Axel, 2026-09-26: cashews → CÔNG TY CỔ PHẦN TIANHE FOOD (Odoo res.partner 631).
-- Biscuits/chocolate → Maison Mooncake customer, name still to be confirmed.

alter table lab_mm_order_items add column if not exists client_name text;
alter table lab_mm_order_items add column if not exists odoo_partner_id bigint;

update lab_mm_order_items
   set client_name = 'CÔNG TY CỔ PHẦN TIANHE FOOD', odoo_partner_id = 631
 where unit = 'kg' and group_key like 'cashew_%';

delete from lab_mm_settings where key = 'client_name';
