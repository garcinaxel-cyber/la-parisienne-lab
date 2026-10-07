-- OEM tracker (Axel, 2026-10-07): the team lead (accounts listed in lab_mm_settings.prod_editors,
-- chosen by the admin: Hung only, never his staff) may change the kg of a baked batch or cancel it
-- before reception. Every correction (team lead or admin) leaves a line here. Chefs get no right on
-- this table and still have no UPDATE/DELETE right on lab_mm_production_log: the server action
-- (fixProductionAction) is the only way in. Applied.
create table if not exists lab_mm_production_audit (
  id uuid primary key default gen_random_uuid(),
  log_id uuid not null,
  action text not null check (action in ('edit','cancel')),
  group_key text not null,
  sku text,
  prod_date date,
  plan_seq smallint,
  entry_by_name text,
  old_kg numeric not null,
  new_kg numeric,
  reason text,
  done_by uuid,
  done_by_name text,
  done_at timestamptz not null default now()
);
create index if not exists lab_mm_production_audit_done_at on lab_mm_production_audit (done_at desc);
alter table lab_mm_production_audit enable row level security;
create policy lab_mm_production_audit_read on lab_mm_production_audit for select
  using (current_role_of() = any (array['admin'::user_role, 'lab_manager'::user_role, 'assistant'::user_role]));
create policy lab_mm_production_audit_insert on lab_mm_production_audit for insert
  with check (current_role_of() = any (array['admin'::user_role, 'lab_manager'::user_role]) and done_by = (select auth.uid()));
-- lab_mm_settings: key 'prod_editors' = comma-separated user ids (set to Hung's account on 2026-10-07).
