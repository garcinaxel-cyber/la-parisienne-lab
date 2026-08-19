-- v45 — Shop access rework (Axel, 2026-08-19): drop the per-shop token-link idea in favor of
-- a real shared login (email+password) per shop, same auth as the rest of the app — one
-- account per shop, credentials shared among that shop's 5-6 staff. Scoped to exactly 5 shops:
-- Moon Flower, La Paris Bà Triệu, La Paris Long Biên, La Paris Tây Hồ, La Paris Timecity
-- (matching SHOP_ODOO_MAP's keys in odoo-shop-order-sync.ts, minus "Lab" itself).
--
-- Applied live via Supabase MCP on 2026-08-19; this file mirrors that migration for repo history.

ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'shop';

-- shop_name mirrors lab_profiles.team's existing role — one extra column on the same
-- "lab app extension of profiles" table, not a new table.
ALTER TABLE lab_profiles ADD COLUMN IF NOT EXISTS shop_name text;

-- The token-link table from the earlier iteration is no longer used — never reached
-- production, safe to drop outright rather than leave a dead table around.
DROP TABLE IF EXISTS lab_shop_portal_links;
