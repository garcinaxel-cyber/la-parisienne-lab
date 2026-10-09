-- Off-recipe withdrawals (Axel, 2026-10-09): flag a raw material taken from storage that no Odoo
-- recipe uses, and let the chef say what it was for. Additive only.
alter table lab_raw_materials add column if not exists bom_count integer;            -- active Odoo BOM lines using it; null = unknown
alter table lab_raw_materials add column if not exists no_recipe_needed boolean not null default false; -- ice, spray… never alert
alter table lab_raw_withdrawal_lines add column if not exists off_recipe boolean not null default false;
alter table lab_raw_withdrawal_lines add column if not exists used_for text;
