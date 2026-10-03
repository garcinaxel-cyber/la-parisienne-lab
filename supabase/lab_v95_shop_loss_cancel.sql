-- lab_v95 — soft-cancel for shop loss reports (Axel, 2026-10-03).
-- A loss declared by mistake is never deleted: it is marked cancelled and every reader
-- of lab_shop_losses in the app skips rows where cancelled_at is set. Additive only.
-- Already applied on the Supabase project (migration lab_v95_shop_loss_cancel).
alter table public.lab_shop_losses
  add column if not exists cancelled_at timestamptz,
  add column if not exists cancelled_by_name text,
  add column if not exists cancel_reason text;

comment on column public.lab_shop_losses.cancelled_at is 'Set when the loss report was cancelled (declared by mistake). Cancelled rows are kept but hidden from every list, recap, report and check.';
