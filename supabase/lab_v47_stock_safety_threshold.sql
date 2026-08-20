-- lab_v47: per-SKU safety stock threshold, station Analytics "Lab stock" card (Axel, 2026-08-21)
-- "je veux que tu puisse mettre la possibilite de mettre un stock de securite par ligne de
-- produit, si ca passe sous ce seuil la ligne se met en rouge et dit : faut produire."
--
-- One threshold per SKU (not per team) — a SKU only ever belongs to one team's stock card
-- (Tiramisu -> baby_mama, Macaron/Biscuit Voyage -> hung, see TEAM_STOCK_CATEGORIES in
-- src/app/station/[team]/actions.ts), so there's no ambiguity to resolve there.
--
-- Access: same pattern as lab_daily_stats/lab_delivery_check_lines for the station analytics
-- tab — RLS enabled with zero policies (nobody via anon/authenticated bypasses it), reads and
-- writes only go through the service-role client in station/[team]/actions.ts server actions,
-- after checking the caller has a logged-in station session. No direct client RLS access needed.

CREATE TABLE IF NOT EXISTS lab_stock_safety_thresholds (
  sku             text PRIMARY KEY,
  threshold       numeric NOT NULL DEFAULT 0,
  updated_by      uuid REFERENCES auth.users(id),
  updated_by_name text,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE lab_stock_safety_thresholds ENABLE ROW LEVEL SECURITY;
