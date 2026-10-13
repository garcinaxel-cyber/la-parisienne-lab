-- Storage confirms the chefs' withdrawal slips (Axel, 2026-10-09: "hien doit confirmer les demandes de
-- picking des chefs", "hien confirm d'abord"). A new slip waits as 'to_confirm' until the purchasing
-- role (Hien) confirms it, with corrected quantities if needed. Existing slips stay 'confirmed'.
alter table lab_raw_withdrawals
  add column if not exists status text not null default 'confirmed',
  add column if not exists confirmed_at timestamptz,
  add column if not exists confirmed_by_name text,
  add column if not exists reminded_at timestamptz,
  add column if not exists escalated_at timestamptz;
do $$ begin
  alter table lab_raw_withdrawals add constraint lab_raw_withdrawals_status_chk check (status in ('to_confirm', 'confirmed'));
exception when duplicate_object then null; end $$;
update lab_raw_withdrawals set confirmed_at = created_at where confirmed_at is null and status = 'confirmed';
create index if not exists lab_raw_withdrawals_to_confirm_idx on lab_raw_withdrawals (created_at) where status = 'to_confirm';
