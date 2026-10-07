-- Event shops: payment QR shown at the mini-caisse for a bank-transfer sale (Axel, 2026-09-14).
-- The column has existed in production since that day (added straight on the database when the
-- feature shipped) but no migration file ever recorded it — this file closes that gap so a fresh
-- environment built from supabase/*.sql gets the same schema. Safe to re-run.
alter table public.lab_event_shops add column if not exists qr_code_url text;
