-- Self-healing expiry for the '__pending_create__' claim on lab_manual_cakes.
-- Mirrors lab_sync_lock's 2-minute auto-expiry (lab_v28_sync_lock.sql), but for the
-- per-row claim used when an admin creates/attaches an Odoo document from /exceptional-orders.
-- Without this, a row stuck at '__pending_create__' by a crashed/killed request (not a normal
-- JS exception — those are already caught and released) stays stuck forever with no self-heal.
alter table public.lab_manual_cakes
  add column if not exists claimed_at timestamptz;

comment on column public.lab_manual_cakes.claimed_at is
  'Set when matched_order_ref is set to the ''__pending_create__'' sentinel. A pending claim older than 5 minutes is considered stale and may be re-claimed (see claimLines() in odoo-shop-order-sync.ts).';
