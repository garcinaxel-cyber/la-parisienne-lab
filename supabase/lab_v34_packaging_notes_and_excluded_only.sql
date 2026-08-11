-- 2026-08-11: packaging lines can carry an Odoo note too (e.g. "2 túi nguyên (100c)"),
-- same as production lines already do (lab_v33). Applied live via Supabase MCP.
alter table lab_order_packaging_lines add column if not exists note text;

-- Context (not a migration, just documentation of the bug this unblocks):
-- A replenishment/sales order whose lines are 100% excluded SKUs (lab_excluded_skus —
-- packaging/matières) was previously invisible EVERYWHERE: odoo-sync.ts's runOdooSync()
-- drops every line for such a ref (excludedSet.has(sku) => continue), so it never reaches
-- lines[] => never gets a lab_imports/lab_order_lines row => odoo-packaging-sync.ts never
-- discovers the ref either (it only looks at refs already present in lab_order_lines).
-- Confirmed 2026-08-11 on REP/2026/01005, REP/2026/01006, REP/2026/01007 (state=submitted,
-- delivery_date=2026-08-11, all lines are packaging codes like VTTH086/VTTH0140/BGMV200G —
-- all present in lab_excluded_skus). Fixed in odoo-sync.ts (new `packagingOnly` output) +
-- odoo-auto-sync.ts (upserts it straight into lab_order_packaging_lines).
