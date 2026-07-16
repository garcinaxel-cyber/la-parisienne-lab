-- lab_v19 — Link each order line to the production card it belongs to, by ID.
-- Birthday-cake messages / ready-times were attached to a chef's card by matching the
-- PRODUCT NAME (fragile: empty team, near-duplicate names, slight text differences broke it).
-- Stamping lab_order_lines.assignment_id at import time gives an exact, unbreakable link:
--   lab_birthday_details (keyed by order_line_id) → order line → assignment_id → the card.

ALTER TABLE lab_order_lines
  ADD COLUMN IF NOT EXISTS assignment_id uuid REFERENCES lab_assignments(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS lab_order_lines_assignment_idx ON lab_order_lines(assignment_id);

-- Backfill existing rows using the same key the app has always used to group a card
-- (import + team + variant + product name). Best-effort: unmatched rows stay NULL and
-- the station falls back to name-matching for them.
UPDATE lab_order_lines ol
SET assignment_id = a.id
FROM lab_assignments a
WHERE a.import_id = ol.import_id
  AND a.team = ol.team
  AND a.variant_label = ol.variant_label
  AND a.product_name_vi = ol.product_name_vi
  AND ol.assignment_id IS NULL;
