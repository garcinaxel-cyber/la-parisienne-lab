-- v140 — PO receipt hand-over to the teams (Axel, 2026-10-29). Since the rooms are linked to Odoo,
-- goods a team ordered must reach its room through a slip: after validating a receipt, the receiver
-- sees what goes to which room and taps "Đã giao cho team" — the app then creates the team's slip
-- (already confirmed by storage) and the chef's "Đã nhận" moves LAB/Stock → Room in Odoo.
-- handover = { teams: [{ team, lines: [{ tmplId, productId, name, nameVi, uom, qty, recvUom }],
--                        slipId, slipNo, givenAt, givenBy }],
--              kho: [{ productId, name, nameVi, uom, qty }] }
alter table public.lab_po_receipts add column if not exists handover jsonb;
-- Compare-and-set counter: a double tap never creates two slips.
alter table public.lab_po_receipts add column if not exists handover_rev integer not null default 0;
