-- v142 — Room count: products missing from the catalogue (Axel, 2026-10-30, team Hung counting).
-- A counter types a free name, quantity, unit and photo; Axel links it to a real Odoo product later.
-- Never sent to Odoo until linked. Service role only (RLS on, no policy), like the other count tables.
create table if not exists public.lab_room_count_free_items (
  id uuid primary key,
  session_id uuid not null references public.lab_room_count_sessions(id) on delete cascade,
  team text not null,
  name text not null,
  qty numeric not null default 0,
  uom text not null,
  photo_url text,
  note text,
  counted_by uuid,
  counted_by_name text,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by_name text,
  linked_tmpl_id integer,
  linked_at timestamptz,
  linked_by_name text
);
create index if not exists lab_room_count_free_items_session_idx on public.lab_room_count_free_items (session_id) where deleted_at is null;
alter table public.lab_room_count_free_items enable row level security;
