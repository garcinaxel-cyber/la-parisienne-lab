-- v149 — HR pilot: auto-publish next week's schedule after the Saturday deadline (Hưng via Axel,
-- 2026-11-06: "If I forget, I need it automatically published after Saturday").
-- Runs Sunday 00:05 Hanoi (Saturday 17:05 UTC). Publishes the week starting the next day (Monday)
-- for every team that has HR rules, unless it is already published. The leader can still put it
-- back to draft afterwards (the job runs once a week, it does not re-publish).
create or replace function public.hr_auto_publish_next_week() returns void
language sql security definer set search_path = public as $$
  insert into public.hr_schedule_weeks (team, week_start, status, published_at, published_by)
  select r.team, ((now() at time zone 'Asia/Ho_Chi_Minh')::date + 1), 'published', now(), 'Tự động (auto)'
  from public.hr_team_rules r
  on conflict (team, week_start) do update
    set status = 'published', published_at = excluded.published_at, published_by = excluded.published_by
    where public.hr_schedule_weeks.status <> 'published';
$$;
revoke execute on function public.hr_auto_publish_next_week() from public, anon, authenticated;

select cron.schedule('hr-auto-publish-week', '5 17 * * 6', $$select public.hr_auto_publish_next_week()$$);
