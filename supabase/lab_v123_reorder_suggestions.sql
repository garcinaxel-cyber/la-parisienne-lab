-- v123 — "re-order what was missing / damaged" suggestion on the shop order screen (Axel, 2026-10-15:
-- suggestion to validate, last delivery only). Additive: 3 nullable columns on the receipt line —
-- once the shop added the suggestion to its cart or dismissed it, it never comes back.
ALTER TABLE lab_shop_receipt_lines ADD COLUMN IF NOT EXISTS reorder_status text
  CHECK (reorder_status IS NULL OR reorder_status IN ('added','dismissed'));
ALTER TABLE lab_shop_receipt_lines ADD COLUMN IF NOT EXISTS reorder_at timestamptz;
ALTER TABLE lab_shop_receipt_lines ADD COLUMN IF NOT EXISTS reorder_by_name text;
