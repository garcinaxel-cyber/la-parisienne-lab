-- Card corrected at the delivery check: who / why / from → to, and the kitchen cannot change its quantity any more.
alter table lab_assignments
  add column if not exists corrected_at timestamptz,
  add column if not exists corrected_by_name text,
  add column if not exists corrected_reason text,
  add column if not exists corrected_from int,
  add column if not exists corrected_qty int,
  add column if not exists corrected_ref text;

create or replace function lab_keep_corrected_qty() returns trigger
language plpgsql set search_path = public as $$
begin
  if old.corrected_at is not null
     and new.qty_produced is distinct from old.qty_produced
     and coalesce(current_role_of()::text, '') in ('chef', 'worker') then
    new.qty_produced := old.qty_produced;
    new.transferred := coalesce(new.qty_sent_total, 0) >= coalesce(nullif(old.qty_produced, 0), new.total_qty, 0);
  end if;
  return new;
end $$;

drop trigger if exists lab_keep_corrected_qty on lab_assignments;
create trigger lab_keep_corrected_qty before update on lab_assignments
  for each row execute function lab_keep_corrected_qty();
