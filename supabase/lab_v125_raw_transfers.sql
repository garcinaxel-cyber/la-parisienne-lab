-- Raw-material transfers between teams (Axel, 2026-10-16: "transférer des matières prises dans une
-- autre team", both directions, storage (Hiền) confirms). A transfer is a slip in lab_raw_withdrawals
-- with kind = 'transfer': team = the team that recorded it, from_team -> to_team = the direction.
-- Nothing goes to Odoo: it only moves the quantity between the two teams in the app.
-- Refused by storage: refused_at set, status 'confirmed' and every line corrected to 0, so any total
-- that reads corrected_qty ?? qty counts nothing for it.
alter table lab_raw_withdrawals
  add column if not exists kind text not null default 'take',
  add column if not exists from_team text,
  add column if not exists to_team text,
  add column if not exists note text,
  add column if not exists refused_at timestamptz,
  add column if not exists refused_by_name text;
do $$ begin
  alter table lab_raw_withdrawals add constraint lab_raw_withdrawals_kind_chk check (kind in ('take', 'transfer'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table lab_raw_withdrawals add constraint lab_raw_withdrawals_transfer_chk
    check (kind <> 'transfer' or (from_team is not null and to_team is not null and from_team <> to_team));
exception when duplicate_object then null; end $$;
create index if not exists lab_raw_withdrawals_from_team_idx on lab_raw_withdrawals (from_team, created_at) where kind = 'transfer';
create index if not exists lab_raw_withdrawals_to_team_idx on lab_raw_withdrawals (to_team, created_at) where kind = 'transfer';
