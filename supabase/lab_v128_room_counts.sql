-- v128 — Room count: inventory of each team's room (Axel, 2026-10-20). Phase 1: app only, nothing is
-- sent to Odoo until the rooms are linked (the Odoo locations exist: LAB/Room Hung 219, Baby Mama 220,
-- Entremet 221, Baker 222). Same principle as the Lab count: ONE session = ONE cut-off for the whole room
-- (phase 2: one grouped Odoo adjustment), never one count per product.
--   * several people count at the same time: every entry is its own row (id created on the phone, so a
--     double tap or a resend never creates a second row); total of a product = sum of its live entries.
--   * "= 0" is an explicit entry (is_zero). A listed product nobody counted is LEFT OUT of the count and
--     needs a reason before the team lead can confirm (admin check list in the Inventory tab).
--   * quantities in the catalogue base unit (lab_raw_materials.uom, like the withdrawal slips).
-- Additive only. Service-role access through server actions (RLS on, no policy), like the other raw tables.

create table if not exists public.lab_room_count_sessions (
  id uuid primary key default gen_random_uuid(),
  team text not null,
  room_location_id integer,                 -- Odoo stock.location of the room (phase 2)
  count_date date not null,
  cutoff_at timestamptz not null default now(),
  status text not null default 'open' check (status in ('open', 'confirmed', 'cancelled')),
  opened_by uuid, opened_by_name text,
  confirmed_by uuid, confirmed_by_name text, confirmed_at timestamptz,
  cancelled_by_name text, cancelled_at timestamptz,
  odoo_inventory_id integer,                -- phase 2: the grouped Odoo adjustment
  odoo_push_status text, odoo_push_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- one open count per room at a time
create unique index if not exists lab_room_count_sessions_one_open on public.lab_room_count_sessions (team) where status = 'open';
create index if not exists lab_room_count_sessions_date_idx on public.lab_room_count_sessions (count_date desc);

-- The list to count: built when the session opens (raw materials the team took + those in its recipes),
-- plus anything added with "other product". left_out_reason is set by the team lead for uncounted lines.
create table if not exists public.lab_room_count_lines (
  session_id uuid not null references public.lab_room_count_sessions(id) on delete cascade,
  tmpl_id integer not null,
  sku text, name text not null, name_vi text, uom text not null,
  type text, sub text,
  source text not null default 'taken' check (source in ('taken', 'recipe', 'added')),
  taken_recent numeric,                     -- what the team took in the 14 days before the cut-off (unit check)
  left_out_reason text check (left_out_reason is null or left_out_reason in ('not_used', 'other_room', 'no_time', 'other')),
  left_out_note text, left_out_by_name text,
  primary key (session_id, tmpl_id)
);

create table if not exists public.lab_room_count_entries (
  id uuid primary key,                      -- generated on the phone: idempotent save
  session_id uuid not null references public.lab_room_count_sessions(id) on delete cascade,
  tmpl_id integer not null,
  qty numeric not null default 0 check (qty >= 0),   -- base unit
  is_zero boolean not null default false,
  pack_label text, pack_count numeric,      -- how it was typed (25 kg bag × 2, eggs in pieces…)
  counted_by uuid, counted_by_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz, deleted_by_name text
);
create index if not exists lab_room_count_entries_session_idx on public.lab_room_count_entries (session_id, tmpl_id) where deleted_at is null;

alter table public.lab_room_count_sessions enable row level security;
alter table public.lab_room_count_lines enable row level security;
alter table public.lab_room_count_entries enable row level security;
