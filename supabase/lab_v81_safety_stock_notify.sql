-- lab_v81: chef push notification when a Macaron/Biscuit Voyage/Tiramisu SKU drops below its
-- safety threshold (Axel, 2026-09-12: "je voudrais egalement que les chefs recoivent une
-- notification quand un produit en stock passe sous le seuil de securite (cela ne concerne que
-- les biscuits voyage, macaron et tiramisu)"). The check itself and its thresholds already
-- existed (lab_v47_stock_safety_threshold.sql + checks.ts's checkSafetyStock/STOCK_CATEGORIES),
-- run daily by the existing reconciliation-check cron at 6h VN (Axel confirmed reusing that run
-- rather than a new, more frequent cron) — this only adds the push + this transition-tracking
-- table so a SKU already known to be low is never re-notified on a later day it's still low
-- (Axel: "des que ca passe sous le seuil il y ait une notif, pas plus" — once per crossing, not
-- a repeat every run). A SKU is removed from this table the moment it's back at/above threshold,
-- so a later second dip notifies again.
--
-- Access: same posture as lab_stock_safety_thresholds (lab_v47) — RLS enabled with zero
-- policies, nobody via anon/authenticated bypasses it; only the reconciliation-check cron's
-- service-role client reads/writes it.
CREATE TABLE IF NOT EXISTS lab_safety_stock_alerts (
  sku          text PRIMARY KEY,
  category     text,
  qty          numeric,
  threshold    numeric,
  notified_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE lab_safety_stock_alerts ENABLE ROW LEVEL SECURITY;
