-- Team lead approval of purchase requests (Axel, 2026-10-08): a member's request waits for the
-- team lead (status 'to_approve') before purchasing sees it. Additive only. Applied 2026-10-08.
alter table lab_profiles add column if not exists is_team_lead boolean not null default false;
alter table lab_purchase_request_lines drop constraint if exists lab_purchase_request_lines_status_check;
alter table lab_purchase_request_lines add constraint lab_purchase_request_lines_status_check
  check (status = any (array['to_approve','pending','ordered','received','cancelled']));
alter table lab_purchase_request_lines
  add column if not exists approved_at timestamptz,
  add column if not exists approved_by_name text,
  add column if not exists requested_qty numeric,
  add column if not exists rejected_by_lead boolean not null default false,
  add column if not exists reject_reason text;
-- Data step (applied once, not repeated here): is_team_lead = true on Hưng's own account (team hung).
