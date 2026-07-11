-- lab_v15 — Odoo line notes + cancelled flag
-- note: per-order-line note authored in Odoo (design instructions etc.), stored on the
--       order line and mirrored into the assignment breakdown entries for the chef card.
-- cancelled: an already-imported product whose Odoo qty dropped to 0. Kept visible but
--            struck through with an "Annulé" badge, and excluded from progress.

ALTER TABLE lab_order_lines ADD COLUMN IF NOT EXISTS note text;
ALTER TABLE lab_assignments ADD COLUMN IF NOT EXISTS cancelled boolean NOT NULL DEFAULT false;
