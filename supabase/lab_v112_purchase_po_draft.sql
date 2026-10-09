-- Phase 2 (Axel, 2026-10-09): draft purchase orders created in Odoo from the app. A line stays
-- 'pending' while its PO is a draft; it becomes 'ordered' when the PO is confirmed in Odoo.
alter table lab_purchase_request_lines add column if not exists po_odoo_id integer;
alter table lab_purchase_request_lines add column if not exists po_created_at timestamptz;
alter table lab_purchase_request_lines add column if not exists po_created_by_name text;
create index if not exists lab_purchase_request_lines_po_odoo_id_idx on lab_purchase_request_lines (po_odoo_id) where po_odoo_id is not null;
