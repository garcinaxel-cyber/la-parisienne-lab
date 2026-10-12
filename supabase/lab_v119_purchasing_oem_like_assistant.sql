-- lab_v119 — the 'purchasing' role (Hiền) works on OEM like an assistant (Axel, 2026-10-12):
-- packaging entries, finished-goods and raw-material counts, logging a batch from /station/oem.
-- Purely additive: new policies next to the existing ones; nothing dropped, no data touched.
-- Corrections reserved to managers (production log UPDATE/DELETE, settings, plan) stay as they are.
create policy lab_mm_packaging_log_write_purchasing on public.lab_mm_packaging_log
  for all using (current_role_of() = 'purchasing'::user_role) with check (current_role_of() = 'purchasing'::user_role);
create policy lab_mm_fg_counts_write_purchasing on public.lab_mm_fg_counts
  for all using (current_role_of() = 'purchasing'::user_role) with check (current_role_of() = 'purchasing'::user_role);
create policy lab_mm_rm_inventory_write_purchasing on public.lab_mm_rm_inventory
  for all using (current_role_of() = 'purchasing'::user_role) with check (current_role_of() = 'purchasing'::user_role);
create policy lab_mm_production_log_insert_purchasing on public.lab_mm_production_log
  for insert with check (current_role_of() = 'purchasing'::user_role);
