-- v151 — HR pilot: half days (Axel, 2026-11-11).
-- S = works the morning only (sáng), C = works the afternoon only (chiều): fixed halves of the base shift
-- (shift 7: 07–11 / 12–16 · shift 8: 08–12 / 13–17). Used for a planned 4 h post (part-time, seasonal)
-- and for a half day off. A half day off counts 0.5 in the monthly days off, is always accepted and does
-- NOT count in the "people off per day" limit.
alter table public.hr_schedule_days drop constraint if exists hr_schedule_days_code_check;
alter table public.hr_schedule_days add constraint hr_schedule_days_code_check
  check (code in ('7', '8', 'S', 'C', 'O', 'AL', 'PH', 'SN', 'OM', 'KL', 'CD'));

-- A day-off request can be for half a day: part = the half the employee still WORKS (S or C).
alter table public.hr_off_wishes add column if not exists part text check (part in ('S', 'C'));
