-- 2026-08-11: surface the Odoo product note (replenishment line note, or a sales-order
-- line_note row) on the delivery-check checklist, next to each product. Resolved once at
-- checklist creation, same pattern as product_category (see ensureDeliveryOrderChecklist).
-- Multiple distinct notes for the same SKU within one order (rare: same product split across
-- two lines, each with its own note) are kept stacked, newline-joined — never merged/lost.
alter table lab_delivery_check_lines add column if not exists note text;
