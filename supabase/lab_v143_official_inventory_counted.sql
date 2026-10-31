-- v143 — Shops' official inventory (Axel, 2026-10-31): tell "counted 0" from "never counted". Every
-- line still starts at 0; counted = true once a person saved it (or confirmed "the rest = 0").
-- Before sending, the app lists the lines nobody counted and asks to confirm them at 0.
alter table public.lab_shop_official_inventory_lines add column if not exists counted boolean not null default false;
