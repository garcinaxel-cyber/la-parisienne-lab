-- v145 — HR pilot (Axel, 2026-11-06): schedules, requests and overtime in the app, Team Hưng first.
-- "coder en main la partie de team hung ... comme ça je peux tester avec lui".
-- Additive only: new hr_* tables, no change to existing tables. RLS on, no policies — every read and
-- write goes through server actions with the service-role client (same posture as lab_push_subscriptions).
-- Pay rules (Trang, 2026-11-04): 9 h on site = 1 day (8 h + 1 h break), pro rata; overtime = beyond 9 h,
-- paid only with an approved request. Team rules (paper schedule): 5 days off / month, max 2 Saturdays
-- and 2 Sundays off, max 2 people off on a weekday and 3 on a weekend day, wishes before the 25th.

create table if not exists public.hr_employees (
  id uuid primary key default gen_random_uuid(),
  team text not null,
  full_name text not null,
  position text,                                   -- Leader / Thợ chính / Thợ phụ / Thời vụ
  base_shift text not null default '7',            -- '7' = 07:00–16:00, '8' = 08:00–17:00
  clock_id text,                                   -- employee ID on the Hikvision time clock (iVMS)
  is_leader boolean not null default false,
  is_casual boolean not null default false,        -- seasonal, paid by the hour, outside the off-day rules
  access_token text not null unique default replace(gen_random_uuid()::text, '-', ''),
  active boolean not null default true,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists hr_employees_team_idx on public.hr_employees(team) where active;

-- Schedule: only the days that differ from the default (base shift, or 'O' on a wish) are stored.
create table if not exists public.hr_schedule_days (
  employee_id uuid not null references public.hr_employees(id) on delete cascade,
  day date not null,
  code text not null check (code in ('7', '8', 'O', 'AL', 'PH', 'SN')),
  updated_by text,
  updated_at timestamptz not null default now(),
  primary key (employee_id, day)
);

create table if not exists public.hr_schedule_months (
  team text not null,
  month date not null,                             -- first day of the month
  status text not null default 'draft' check (status in ('draft', 'published')),
  published_at timestamptz,
  published_by text,
  primary key (team, month)
);

create table if not exists public.hr_off_wishes (
  employee_id uuid not null references public.hr_employees(id) on delete cascade,
  day date not null,
  created_at timestamptz not null default now(),
  primary key (employee_id, day)
);

create table if not exists public.hr_off_wish_submits (
  employee_id uuid not null references public.hr_employees(id) on delete cascade,
  month date not null,
  submitted_at timestamptz not null default now(),
  primary key (employee_id, month)
);

create table if not exists public.hr_requests (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.hr_employees(id) on delete cascade,
  team text not null,
  type text not null,                              -- late, early, annual, unpaid, sick, child_sick, wedding,
                                                   -- bereavement, prenatal, maternity, business_trip, missed_punch, swap, other
  day_from date not null,
  day_to date,
  time_from text,
  time_to text,
  swap_with uuid references public.hr_employees(id),
  reason text,
  status text not null default 'pending_leader'
    check (status in ('pending_leader', 'pending_giang', 'approved', 'rejected', 'cancelled')),
  leader_name text,
  leader_at timestamptz,
  giang_name text,
  giang_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists hr_requests_team_idx on public.hr_requests(team, status);
create index if not exists hr_requests_emp_idx on public.hr_requests(employee_id);

create table if not exists public.hr_ot_requests (
  id uuid primary key default gen_random_uuid(),
  team text not null,
  day date not null,
  time_from text not null,
  time_to text not null,
  hours numeric not null,
  reason text,
  status text not null default 'pending_giang' check (status in ('pending_giang', 'approved', 'rejected', 'cancelled')),
  created_by_name text,
  created_at timestamptz not null default now(),
  giang_name text,
  giang_at timestamptz
);
create index if not exists hr_ot_requests_team_idx on public.hr_ot_requests(team, day);

create table if not exists public.hr_ot_lines (
  ot_id uuid not null references public.hr_ot_requests(id) on delete cascade,
  employee_id uuid not null references public.hr_employees(id) on delete cascade,
  confirm text check (confirm in ('yes', 'no')),
  confirmed_at timestamptz,
  primary key (ot_id, employee_id)
);

alter table public.hr_employees enable row level security;
alter table public.hr_schedule_days enable row level security;
alter table public.hr_schedule_months enable row level security;
alter table public.hr_off_wishes enable row level security;
alter table public.hr_off_wish_submits enable row level security;
alter table public.hr_requests enable row level security;
alter table public.hr_ot_requests enable row level security;
alter table public.hr_ot_lines enable row level security;

-- Pilot team: Macaron (Team Hưng). Clock IDs read from the iVMS export of October 2026.
insert into public.hr_employees (team, full_name, position, base_shift, clock_id, is_leader, is_casual, sort_order)
select * from (values
  ('hung', 'Tạ Duy Hưng',            'Leader',    '7', '17', true,  false, 1),
  ('hung', 'Lê Công Trung',          'Thợ chính', '8', '7',  false, false, 2),
  ('hung', 'Lê Thị Ngọc',            'Thợ chính', '7', '32', false, false, 3),
  ('hung', 'Năng Thanh Huyền',       'Thợ phụ',   '7', '9',  false, false, 4),
  ('hung', 'Nguyễn Thảo Nguyên',     'Thợ phụ',   '7', '45', false, false, 5),
  ('hung', 'Chu Thanh Vũ Minh',      'Thợ phụ',   '8', '49', false, false, 6),
  ('hung', 'Công Phương Thanh',      'Thợ phụ',   '8', '56', false, false, 7),
  ('hung', 'Nguyễn Hoàng Việt Anh',  'Thời vụ',   '8', '52', false, true,  8)
) as v(team, full_name, position, base_shift, clock_id, is_leader, is_casual, sort_order)
where not exists (select 1 from public.hr_employees e where e.team = 'hung');
