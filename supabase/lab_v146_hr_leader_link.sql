-- v146 — HR pilot: only the team leader manages the team (Axel, 2026-11-06).
-- Most Team Hưng members have a station account with role 'chef' on team 'hung', so "chef of the team"
-- is not enough to approve requests or edit the schedule: the Team tab is limited to admins / lab
-- managers and to the hr_employees row flagged is_leader whose profile_id is the signed-in user.
alter table public.hr_employees add column if not exists profile_id uuid;
create index if not exists hr_employees_profile_idx on public.hr_employees(profile_id);

-- Tạ Duy Hưng (leader, Macaron) = station account "Hung" (taduyhung21051997@…).
update public.hr_employees set profile_id = '49e26148-071d-4cd2-9aaa-4141a0c3d0b8'
where team = 'hung' and is_leader and full_name = 'Tạ Duy Hưng' and profile_id is null;
