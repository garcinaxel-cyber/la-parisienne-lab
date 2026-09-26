-- OEM tracker v2 (Axel, 2026-09-26): reception of Hung's batches, inventory gaps, whole bags. Applied.
alter table lab_mm_production_log add column if not exists status text not null default 'pending';
alter table lab_mm_production_log add column if not exists received_kg numeric;
alter table lab_mm_production_log add column if not exists received_at timestamptz;
alter table lab_mm_production_log add column if not exists received_by uuid;
alter table lab_mm_production_log add column if not exists received_by_name text;
alter table lab_mm_production_log add column if not exists receive_note text;
do $$ begin
  alter table lab_mm_production_log add constraint lab_mm_production_log_status_check check (status in ('pending','received'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table lab_mm_production_log add constraint lab_mm_production_log_received_check check (received_kg is null or (received_kg >= 0 and received_kg <= weight_kg));
exception when duplicate_object then null; end $$;
alter table lab_mm_packaging_log drop constraint if exists lab_mm_packaging_log_kind_check;
alter table lab_mm_packaging_log add constraint lab_mm_packaging_log_kind_check
  check (kind in ('packed','scrap_bulk','scrap_finished','found'));
alter table lab_mm_packaging_log add column if not exists source text not null default 'entry';
alter table lab_mm_packaging_log add column if not exists fg_count_id uuid;
alter table lab_mm_fg_counts add column if not exists gap numeric;
alter table lab_mm_fg_counts add column if not exists status text not null default 'applied';
alter table lab_mm_fg_counts add column if not exists decided_at timestamptz;
alter table lab_mm_fg_counts add column if not exists decided_by_name text;
do $$ begin
  alter table lab_mm_fg_counts add constraint lab_mm_fg_counts_status_check check (status in ('applied','pending_admin','rejected'));
exception when duplicate_object then null; end $$;
alter table lab_mm_fg_counts drop constraint if exists lab_mm_fg_counts_count_date_sku_key;
create unique index if not exists lab_mm_fg_counts_one_live on lab_mm_fg_counts (count_date, sku) where status <> 'rejected';
-- test data wiped the same day at Axel's request (production/packaging/fg/rm logs).
