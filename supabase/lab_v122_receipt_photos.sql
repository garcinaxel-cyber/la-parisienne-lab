-- v122 — Photo proof on shop receptions with a gap (Axel, 2026-10-14: "faudrait que l'assistante
-- voie la photo en preuve"). Additive, nullable; public URLs in the lab-design-photos bucket
-- under receipt-gaps/<date>/. Applied live 2026-10-14.
ALTER TABLE lab_shop_receipt_lines ADD COLUMN IF NOT EXISTS photo_urls text[];
