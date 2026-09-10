-- v77 — Fix: delivery-check's order-detail screen (fetchOnlineOrderInfo, delivery-check.ts)
-- reads lab_online_orders through the normal session-scoped client (subject to RLS), not the
-- service-role client that online-orders/actions.ts uses for its own reads/writes. RLS was
-- enabled on lab_online_orders with ZERO policies, so every read from delivery-check was
-- silently blocked (no error thrown, just an empty result) -- the customer-details box shipped
-- 2026-09-09 has therefore never actually shown for anyone. Axel caught this 2026-09-10 by
-- testing a live online order (REP/2026/01399) and seeing no box on the detail screen.
-- Mirrors the existing lab_manual_cakes_manager policy: admin/lab_manager/assistant can read.
create policy lab_online_orders_delivery_check_read
  on public.lab_online_orders
  for select
  to authenticated
  using (current_role_of() = ANY (ARRAY['admin'::user_role, 'lab_manager'::user_role, 'assistant'::user_role]));
