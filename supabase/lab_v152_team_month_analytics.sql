-- v152 — Station Analytics "This month" (Axel, 2026-11-11).
-- Per team, per lab day (Asia/Ho_Chi_Minh), per SKU:
--   made = quantity SENT TO STOCK (lab_stock_transfer_lines of non-cancelled transfers, by the
--          transfer's lab day) — the exact figure the Odoo MOs "Lab YYYY-MM-DD" follow
--          (lib/odoo-mo-sync.ts sentToStockBySku), checked against Odoo on 11/11 (Nov = Odoo).
--   sent = quantity checked at delivery (lab_delivery_check_lines, category 'production', by
--          delivery_date) — the quantities the delivery check validates on the LAB/OUT pickings.
-- Kept current by triggers that recompute ONLY the touched (team, day, sku) cell from the source
-- rows: the Analytics tab reads a few hundred pre-summed rows, nothing is recalculated on open.
-- Triggers never block the chef: any error is swallowed (WARNING) — the nightly cron re-syncs.

create table if not exists public.lab_analytics_daily (
  team text not null,
  day date not null,
  sku text not null,
  made numeric not null default 0,
  sent numeric not null default 0,
  updated_at timestamptz not null default now(),
  primary key (team, day, sku)
);
alter table public.lab_analytics_daily enable row level security;
-- No policy: read through the service-role server action only (same as delivery-check lines).

-- OEM production (Team Hưng: MM-/OEM- products) is made outside the production cards, in Odoo
-- MOs, in kg. Copied nightly from Odoo by /api/lab/analytics-sync.
create table if not exists public.lab_analytics_oem_daily (
  day date not null,
  code text not null,
  name text,
  kg numeric not null default 0,
  updated_at timestamptz not null default now(),
  primary key (day, code)
);
alter table public.lab_analytics_oem_daily enable row level security;

create index if not exists lab_stock_transfer_lines_sku_idx on public.lab_stock_transfer_lines (sku);
create index if not exists lab_delivery_check_lines_team_day_sku_idx on public.lab_delivery_check_lines (team, delivery_date, sku);

-- Recompute one cell from the source tables.
create or replace function public.lab_analytics_refresh(p_team text, p_day date, p_sku text)
returns void language plpgsql security definer set search_path = public as $$
declare v_made numeric; v_sent numeric;
begin
  if p_team is null or p_day is null or p_sku is null or p_sku = '' then return; end if;
  select coalesce(sum(l.qty_sent), 0) into v_made
    from lab_stock_transfer_lines l join lab_stock_transfers t on t.id = l.transfer_id
   where l.sku = p_sku and t.team = p_team
     and t.status <> 'cancelled' and t.cancelled_at is null and l.qty_sent > 0
     and t.created_at >= (p_day::timestamp at time zone 'Asia/Ho_Chi_Minh')
     and t.created_at <  ((p_day + 1)::timestamp at time zone 'Asia/Ho_Chi_Minh');
  select coalesce(sum(c.qty_checked), 0) into v_sent
    from lab_delivery_check_lines c
   where c.team = p_team and c.delivery_date = p_day and c.sku = p_sku
     and c.category = 'production' and c.qty_checked > 0;
  if v_made = 0 and v_sent = 0 then
    delete from lab_analytics_daily where team = p_team and day = p_day and sku = p_sku;
  else
    insert into lab_analytics_daily (team, day, sku, made, sent, updated_at)
    values (p_team, p_day, p_sku, v_made, v_sent, now())
    on conflict (team, day, sku) do update set made = excluded.made, sent = excluded.sent, updated_at = now();
  end if;
end $$;

-- Transfer lines (sent to stock).
create or replace function public.lab_analytics_tg_transfer_line()
returns trigger language plpgsql security definer set search_path = public as $$
declare r record;
begin
  begin
    if tg_op in ('UPDATE', 'DELETE') then
      select team, (created_at at time zone 'Asia/Ho_Chi_Minh')::date as d into r from lab_stock_transfers where id = old.transfer_id;
      if found then perform lab_analytics_refresh(r.team, r.d, old.sku); end if;
    end if;
    if tg_op in ('INSERT', 'UPDATE') then
      select team, (created_at at time zone 'Asia/Ho_Chi_Minh')::date as d into r from lab_stock_transfers where id = new.transfer_id;
      if found then perform lab_analytics_refresh(r.team, r.d, new.sku); end if;
    end if;
  exception when others then raise warning 'lab_analytics transfer line: %', sqlerrm;
  end;
  return null;
end $$;
drop trigger if exists lab_analytics_transfer_line on public.lab_stock_transfer_lines;
create trigger lab_analytics_transfer_line after insert or update of qty_sent, sku, transfer_id or delete
  on public.lab_stock_transfer_lines for each row execute function public.lab_analytics_tg_transfer_line();

-- Transfer header (cancelled / moved / team changed): recompute all its SKUs.
create or replace function public.lab_analytics_tg_transfer()
returns trigger language plpgsql security definer set search_path = public as $$
declare s text;
begin
  begin
    for s in select distinct sku from lab_stock_transfer_lines where transfer_id = new.id and sku is not null loop
      perform lab_analytics_refresh(old.team, (old.created_at at time zone 'Asia/Ho_Chi_Minh')::date, s);
      perform lab_analytics_refresh(new.team, (new.created_at at time zone 'Asia/Ho_Chi_Minh')::date, s);
    end loop;
  exception when others then raise warning 'lab_analytics transfer: %', sqlerrm;
  end;
  return null;
end $$;
drop trigger if exists lab_analytics_transfer on public.lab_stock_transfers;
create trigger lab_analytics_transfer after update of status, cancelled_at, created_at, team
  on public.lab_stock_transfers for each row
  when (old.status is distinct from new.status or old.cancelled_at is distinct from new.cancelled_at
        or old.created_at is distinct from new.created_at or old.team is distinct from new.team)
  execute function public.lab_analytics_tg_transfer();

-- Delivery check lines (sent by the Lab).
create or replace function public.lab_analytics_tg_check_line()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  begin
    if tg_op in ('UPDATE', 'DELETE') and old.category = 'production' then
      perform lab_analytics_refresh(old.team, old.delivery_date, old.sku);
    end if;
    if tg_op in ('INSERT', 'UPDATE') and new.category = 'production' then
      perform lab_analytics_refresh(new.team, new.delivery_date, new.sku);
    end if;
  exception when others then raise warning 'lab_analytics check line: %', sqlerrm;
  end;
  return null;
end $$;
drop trigger if exists lab_analytics_check_line on public.lab_delivery_check_lines;
create trigger lab_analytics_check_line after insert or update of qty_checked, sku, team, delivery_date, category or delete
  on public.lab_delivery_check_lines for each row execute function public.lab_analytics_tg_check_line();

-- Full rebuild of a date range (backfill + nightly safety net).
create or replace function public.lab_analytics_rebuild(p_from date, p_to date)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  delete from lab_analytics_daily where day between p_from and p_to;
  insert into lab_analytics_daily (team, day, sku, made, sent)
  select team, day, sku, sum(made), sum(sent) from (
    select t.team, (t.created_at at time zone 'Asia/Ho_Chi_Minh')::date as day, l.sku, l.qty_sent::numeric as made, 0::numeric as sent
      from lab_stock_transfer_lines l join lab_stock_transfers t on t.id = l.transfer_id
     where t.status <> 'cancelled' and t.cancelled_at is null and l.qty_sent > 0
       and l.sku is not null and l.sku <> '' and t.team is not null
       and t.created_at >= (p_from::timestamp at time zone 'Asia/Ho_Chi_Minh')
       and t.created_at <  ((p_to + 1)::timestamp at time zone 'Asia/Ho_Chi_Minh')
    union all
    select c.team, c.delivery_date, c.sku, 0, c.qty_checked
      from lab_delivery_check_lines c
     where c.category = 'production' and c.qty_checked > 0 and c.team is not null
       and c.sku is not null and c.sku <> '' and c.delivery_date between p_from and p_to
  ) x group by team, day, sku;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.lab_analytics_rebuild(date, date) from public, anon, authenticated;
revoke all on function public.lab_analytics_refresh(text, date, text) from public, anon, authenticated;

select public.lab_analytics_rebuild('2026-10-01', (now() at time zone 'Asia/Ho_Chi_Minh')::date);
