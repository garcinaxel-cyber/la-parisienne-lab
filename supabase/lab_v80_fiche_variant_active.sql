-- Per-SKU active/inactive (Axel, 2026-09-11): lab_fiche_meta.is_active is fiche-wide (all
-- sizes/SKUs at once); this lets one variant be archived (e.g. discontinued/archived on Odoo)
-- while sibling variants on the same recipe card stay orderable. Manual toggle only — Odoo
-- access here is read-only, so nothing auto-syncs this from Odoo's own archived state.
alter table public.lab_fiche_variants add column if not exists is_active boolean not null default true;
