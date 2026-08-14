-- 2026-08-14 (applied live via Supabase MCP).
-- Assistants can re-open a validated delivery check to fix a line and re-validate — previously
-- "Valider" was a one-way lock with no way back short of a DB edit. Tracked the same way
-- validated_by/printed_by already are on this table, for traceability.
alter table lab_delivery_orders
  add column if not exists unlocked_by uuid references profiles(id),
  add column if not exists unlocked_by_name text,
  add column if not exists unlocked_at timestamptz;
