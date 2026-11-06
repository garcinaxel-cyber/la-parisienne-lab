-- v148 — HR pilot, round 2 after Hưng's review (Axel, 2026-11-06).
-- Weekly publication, team rules per team, automatic day-off acceptance, proof papers, leave codes.
-- Additive: new tables/columns, wider code check. hr_schedule_months stays (no longer used).

-- Leave codes written into the schedule when a request is approved:
-- OM = ốm (sick / child sick), KL = không lương (unpaid), CD = chế độ (wedding, bereavement, prenatal, maternity).
alter table public.hr_schedule_days drop constraint if exists hr_schedule_days_code_check;
alter table public.hr_schedule_days add constraint hr_schedule_days_code_check
  check (code in ('7', '8', 'O', 'AL', 'PH', 'SN', 'OM', 'KL', 'CD'));

-- Rules differ per team (headcount). Macaron: 2 off on a weekday, 3 on Saturday/Sunday,
-- max 2 Saturdays and 2 Sundays off a month. Days off allowed a month = number of Sundays (computed).
create table if not exists public.hr_team_rules (
  team text primary key,
  max_off_weekday int not null default 2,
  max_off_weekend int not null default 3,
  max_sat_month int,
  max_sun_month int,
  updated_at timestamptz not null default now()
);
insert into public.hr_team_rules (team, max_off_weekday, max_off_weekend, max_sat_month, max_sun_month)
values ('hung', 2, 3, 2, 2) on conflict (team) do nothing;

-- The leader publishes the schedule week by week (Monday = week_start).
create table if not exists public.hr_schedule_weeks (
  team text not null,
  week_start date not null,
  status text not null default 'draft' check (status in ('draft', 'published')),
  published_at timestamptz,
  published_by text,
  primary key (team, week_start)
);

-- Proof papers (sick note…) added after the request; no proof → the leader turns the day into a day off.
alter table public.hr_requests add column if not exists proof_path text;
alter table public.hr_requests add column if not exists proof_at timestamptz;
alter table public.hr_requests add column if not exists no_proof boolean not null default false;

alter table public.hr_team_rules enable row level security;
alter table public.hr_schedule_weeks enable row level security;

-- Private bucket for the proof photos (read through signed URLs by the leader only).
insert into storage.buckets (id, name, public) values ('hr-proofs', 'hr-proofs', false) on conflict (id) do nothing;
