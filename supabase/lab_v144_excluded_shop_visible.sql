-- v144 — Non-production items: hide from shops (Axel, 2026-10-31).
-- "pouvoir enlever des produits pour pas que les shops voient, ou en rajouter depuis Odoo".
-- shop_visible = false keeps the SKU non-production (never a production card) but removes it
-- from the shops' order catalogue and stock-count search. Additive only, default keeps today's
-- behaviour (everything visible).
alter table public.lab_excluded_skus
  add column if not exists shop_visible boolean not null default true;
