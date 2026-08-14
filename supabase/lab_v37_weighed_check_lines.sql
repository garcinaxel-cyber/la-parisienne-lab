-- 2026-08-14 (applied live via Supabase MCP).
-- qty_checked on lab_delivery_check_lines was `integer`, so entering a real decimal weight
-- (e.g. 0.896kg for a nominal 1kg raw-material line like "Mango" 152-MH.210, S03219) silently
-- failed at the DB layer — Postgres rejects a non-integer value into an integer column, so the
-- assistant's OK click did nothing (no client-visible error either). Widen to numeric(10,3) so
-- a weighed entry actually saves. Companion fix: src/app/(app)/delivery-check/actions.ts's
-- checkLineAction had its OWN server-side "reason required on any diff" gate, independent of
-- the client-side one in DeliveryCheckOrderView.tsx — only fixing the client wasn't enough,
-- the server still rejected the save with "Reason required". Both now use the same
-- isWeighedEntry() signal (a non-integer qty means a measured weight, never mistyped as a
-- count, so no reason is required).
alter table lab_delivery_check_lines
  alter column qty_checked type numeric(10,3);
