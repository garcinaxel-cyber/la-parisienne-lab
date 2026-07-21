-- v22 — Exceptional orders (generalisation of manual birthday cakes).
-- lab_manual_cakes becomes the store for ALL manual/urgent orders (any product):
--   notes     : free-text note attached to the order (distinct from `message`,
--               which is specifically the text piped on a cake)
--   shop_name : which shop submitted the order via the public link (phase 2);
--               null = created in the app by an assistant
-- No behaviour change for existing rows.

ALTER TABLE lab_manual_cakes ADD COLUMN IF NOT EXISTS notes text;
ALTER TABLE lab_manual_cakes ADD COLUMN IF NOT EXISTS shop_name text;
