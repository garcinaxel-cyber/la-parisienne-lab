-- Event targets per day (Axel, 2026-10-10: "l'objectif de 50 M est pour aujourd'hui pas les autres
-- jours, je te donnerai peut-être un objectif pour demain mais les jours d'avant mets rien").
-- daily_targets: { "YYYY-MM-DD": amount } — a day without a key shows no target. daily_target
-- (lab_v117, one amount for every day) is no longer read and is cleared.
alter table public.lab_event_shops add column if not exists daily_targets jsonb not null default '{}'::jsonb;
update public.lab_event_shops set daily_targets = jsonb_build_object('2026-10-10', 50000000), daily_target = null
 where name = 'HỘI CHỢ AEON HẢI PHÒNG' and active;
