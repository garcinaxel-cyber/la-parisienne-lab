-- Event till (Axel, 2026-10-08): starting cash of the event, shown in Sales as cash in the drawer.
alter table public.lab_event_shops add column if not exists cash_float numeric;
update public.lab_event_shops set cash_float = 1000000 where name = 'HỘI CHỢ AEON HẢI PHÒNG' and active;
