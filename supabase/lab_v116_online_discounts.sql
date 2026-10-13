-- v116 — Remises sur l'interface Vente en ligne (Axel, 2026-10-09 : « tu peux lui permettre de
-- mettre une remise ? » → remise par produit (%) + remise sur la commande (% ou ₫), motif obligatoire).
--
-- Remise par produit : unit_price reste le prix NET (après remise) — tous les lecteurs de CA
-- (stats, base clients, export, alerte paiement, archive) restent justes sans changement.
-- list_unit_price / discount_pct gardent la trace du prix d'origine et du % appliqué.
ALTER TABLE public.lab_manual_cakes
  ADD COLUMN IF NOT EXISTS list_unit_price numeric,
  ADD COLUMN IF NOT EXISTS discount_pct numeric;
ALTER TABLE public.lab_online_sale_lines
  ADD COLUMN IF NOT EXISTS list_unit_price numeric,
  ADD COLUMN IF NOT EXISTS discount_pct numeric,
  -- Remise sur la commande : une ligne qty 1, unit_price NÉGATIF, is_fee=false (elle réduit donc
  -- le CA marchandise comme le CA total), category 'Giảm giá', sku NULL (aucun impact stock).
  ADD COLUMN IF NOT EXISTS is_discount boolean NOT NULL DEFAULT false;
ALTER TABLE public.lab_online_orders
  ADD COLUMN IF NOT EXISTS discount_reason text;
