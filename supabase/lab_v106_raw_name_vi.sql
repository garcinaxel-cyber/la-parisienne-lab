-- Raw materials (Axel, 2026-10-08): Vietnamese name from Odoo's vi_VN translation, shown on the chefs' screen.
alter table public.lab_raw_materials add column if not exists name_vi text;
