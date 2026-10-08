-- Event till promos on/off (Axel, 2026-10-08: "toute l'équipe peut mettre on ou off"). The promo
-- rules stay in the code (PROMO_GROUPS in EventCaisseTab); this only stores which ones are switched
-- off for an event. No row = on, so nothing changes until someone switches one. Every switch is logged.
create table if not exists lab_event_promo_state (
  event_name text not null,
  promo_id text not null,
  active boolean not null default true,
  updated_by_name text,
  updated_at timestamptz not null default now(),
  primary key (event_name, promo_id)
);
create table if not exists lab_event_promo_log (
  id uuid primary key default gen_random_uuid(),
  event_name text not null,
  promo_id text not null,
  active boolean not null,
  by_name text,
  at timestamptz not null default now()
);
alter table lab_event_promo_state enable row level security;
alter table lab_event_promo_log enable row level security;
