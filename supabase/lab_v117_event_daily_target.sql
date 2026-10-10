-- Event daily sales target (Axel, 2026-10-10): "un compte à rebours visuel pour la target des 50 M
-- du jour" — shown on the event's Sales screen only (ring + pace line in the "so far" card).
-- daily_target null = no target, nothing shown (every other event unchanged). Opening hours drive
-- the pace ("fermeture 22h de l'event") and the time left.
alter table public.lab_event_shops add column if not exists daily_target numeric;
alter table public.lab_event_shops add column if not exists open_time text not null default '10:00';
alter table public.lab_event_shops add column if not exists close_time text not null default '22:00';
update public.lab_event_shops set daily_target = 50000000 where name = 'HỘI CHỢ AEON HẢI PHÒNG' and active and daily_target is null;
