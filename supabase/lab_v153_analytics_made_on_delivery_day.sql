-- v153 — Station Analytics: "made" dated on the DELIVERY day it was made for (Axel, 2026-11-11).
-- The quantity is still ONLY what was sent to stock (lab_stock_transfer_lines.qty_sent — the one
-- thing that makes the Odoo MOs). Only the DAY changes:
--   • made-to-order card (lab_assignments.is_extra = false) → the line's delivery_date
--     (a cake sent to stock on the 31st for the 1st counts on the 1st, like its delivery);
--   • extra / stock production (is_extra = true, or no card) → the day it was sent to stock.
-- Month totals can therefore differ from the Odoo MOs (dated on the send day) by about one day of
-- made-to-order production at each month boundary; Odoo stays the reference for finance reports.

create or replace function public.lab_analytics_made_day(p_line_delivery date, p_transfer_created timestamptz, p_is_extra boolean)
returns date language sql immutable as $$
  select case when coalesce(p_is_extra, false) = false and p_line_delivery is not null
              then p_line_delivery
              else (p_transfer_created at time zone 'Asia/Ho_Chi_Minh')::date end
$$;

create or replace function public.lab_analytics_refresh(p_team text, p_day date, p_sku text)
returns void language plpgsql security definer set search_path = public as $$
declare v_made numeric; v_sent numeric;
begin
  if p_team is null or p_day is null or p_sku is null or p_sku = '' then return; end if;
  select coalesce(sum(l.qty_sent), 0) into v_made
    from lab_stock_transfer_lines l
    join lab_stock_transfers t on t.id = l.transfer_id
    left join lab_assignments a on a.id = l.assignment_id
   where l.sku = p_sku and t.team = p_team
     and t.status <> 'cancelled' and t.cancelled_at is null and l.qty_sent > 0
     and lab_analytics_made_day(l.delivery_date, t.created_at, a.is_extra) = p_day;
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

-- A line can count on its delivery day or its send day: refresh both, old and new.
create or replace function public.lab_analytics_tg_transfer_line()
returns trigger language plpgsql security definer set search_path = public as $$
declare r record;
begin
  begin
    if tg_op in ('UPDATE', 'DELETE') then
      select team, (created_at at time zone 'Asia/Ho_Chi_Minh')::date as d into r from lab_stock_transfers where id = old.transfer_id;
      if found then
        perform lab_analytics_refresh(r.team, r.d, old.sku);
        if old.delivery_date is not null and old.delivery_date <> r.d then perform lab_analytics_refresh(r.team, old.delivery_date, old.sku); end if;
      end if;
    end if;
    if tg_op in ('INSERT', 'UPDATE') then
      select team, (created_at at time zone 'Asia/Ho_Chi_Minh')::date as d into r from lab_stock_transfers where id = new.transfer_id;
      if found then
        perform lab_analytics_refresh(r.team, r.d, new.sku);
        if new.delivery_date is not null and new.delivery_date <> r.d then perform lab_analytics_refresh(r.team, new.delivery_date, new.sku); end if;
      end if;
    end if;
  exception when others then raise warning 'lab_analytics transfer line: %', sqlerrm;
  end;
  return null;
end $$;
drop trigger if exists lab_analytics_transfer_line on public.lab_stock_transfer_lines;
create trigger lab_analytics_transfer_line after insert or update of qty_sent, sku, transfer_id, delivery_date, assignment_id or delete
  on public.lab_stock_transfer_lines for each row execute function public.lab_analytics_tg_transfer_line();

create or replace function public.lab_analytics_tg_transfer()
returns trigger language plpgsql security definer set search_path = public as $$
declare l record;
begin
  begin
    for l in select distinct sku, delivery_date from lab_stock_transfer_lines where transfer_id = new.id and sku is not null loop
      perform lab_analytics_refresh(old.team, (old.created_at at time zone 'Asia/Ho_Chi_Minh')::date, l.sku);
      perform lab_analytics_refresh(new.team, (new.created_at at time zone 'Asia/Ho_Chi_Minh')::date, l.sku);
      if l.delivery_date is not null then
        perform lab_analytics_refresh(old.team, l.delivery_date, l.sku);
        perform lab_analytics_refresh(new.team, l.delivery_date, l.sku);
      end if;
    end loop;
  exception when others then raise warning 'lab_analytics transfer: %', sqlerrm;
  end;
  return null;
end $$;

create or replace function public.lab_analytics_rebuild(p_from date, p_to date)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  delete from lab_analytics_daily where day between p_from and p_to;
  insert into lab_analytics_daily (team, day, sku, made, sent)
  select team, day, sku, sum(made), sum(sent) from (
    select t.team, lab_analytics_made_day(l.delivery_date, t.created_at, a.is_extra) as day, l.sku,
           l.qty_sent::numeric as made, 0::numeric as sent
      from lab_stock_transfer_lines l
      join lab_stock_transfers t on t.id = l.transfer_id
      left join lab_assignments a on a.id = l.assignment_id
     where t.status <> 'cancelled' and t.cancelled_at is null and l.qty_sent > 0
       and l.sku is not null and l.sku <> '' and t.team is not null
       and t.created_at >= ((p_from - 7)::timestamp at time zone 'Asia/Ho_Chi_Minh')
       and t.created_at <  ((p_to + 8)::timestamp at time zone 'Asia/Ho_Chi_Minh')
    union all
    select c.team, c.delivery_date, c.sku, 0, c.qty_checked
      from lab_delivery_check_lines c
     where c.category = 'production' and c.qty_checked > 0 and c.team is not null
       and c.sku is not null and c.sku <> '' and c.delivery_date between p_from and p_to
  ) x where day between p_from and p_to
  group by team, day, sku;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.lab_analytics_rebuild(date, date) from public, anon, authenticated;
revoke all on function public.lab_analytics_refresh(text, date, text) from public, anon, authenticated;

select public.lab_analytics_rebuild('2026-10-01', (now() at time zone 'Asia/Ho_Chi_Minh')::date);
