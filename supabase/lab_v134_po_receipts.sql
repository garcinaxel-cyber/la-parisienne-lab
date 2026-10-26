-- v134 — Purchase-order receiving in the app (Axel, 2026-10-26). Hiền and Miss Flavor (purchasing
-- access) count what arrived; validating does, in Odoo: receipt validated (backorder for what is still
-- expected), PO quantity lowered when the supplier has no more, the PO's single draft bill created or
-- aligned to the received quantities, notes on the receipt and the PO; in the app: the chefs' request
-- lines move to received / partly received and the requester gets a push.
-- Additive only. Service-role access through server actions (RLS on, no policy).

-- One row per validation (audit + idempotency: the id is created on the phone, a resend never
-- validates twice).
create table if not exists public.lab_po_receipts (
  id uuid primary key,
  po_odoo_id integer not null,
  po_name text,
  picking_odoo_id integer not null,
  picking_name text,
  backorder_name text,
  vendor_name text,
  lines jsonb not null default '[]'::jsonb,   -- [{moveId, productId, name, uom, expected, received, reason, note}]
  bill_odoo_id integer,
  bill_action text,                           -- created | aligned | posted_untouched | none
  status text not null default 'done' check (status in ('done', 'error')),
  error text,
  odoo_log jsonb,
  received_by uuid, received_by_name text,
  created_at timestamptz not null default now()
);
create index if not exists lab_po_receipts_po_idx on public.lab_po_receipts (po_odoo_id, created_at desc);
alter table public.lab_po_receipts enable row level security;

-- What arrived per chef request line (base unit of the line), and why it is short.
alter table public.lab_purchase_request_lines
  add column if not exists received_qty numeric,
  add column if not exists shortfall_reason text,
  add column if not exists shortfall_note text;
do $$ begin
  alter table public.lab_purchase_request_lines add constraint lab_prl_shortfall_reason_chk
    check (shortfall_reason is null or shortfall_reason in ('later', 'supplier_error', 'no_more', 'wrong_product'));
exception when duplicate_object then null; end $$;
