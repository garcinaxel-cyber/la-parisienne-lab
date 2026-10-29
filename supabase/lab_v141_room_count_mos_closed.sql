-- v141 — Room count and late sends to stock (Axel, 2026-10-29). When a count starts, the team's MOs
-- for everything sent to stock so far are produced and the moment is kept here. Sends after it
-- (urgent birthday cakes) go to new MOs whose room consumption is put back when the count is applied.
alter table public.lab_room_count_sessions add column if not exists mos_closed_at timestamptz;
