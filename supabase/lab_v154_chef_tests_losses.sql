-- v154 — Chef test recipes + chef losses (Axel, 2026-11-12). Pilot: Team Hung only (the app shows
-- the two tabs to CHEF_RD_TEAMS). Server actions use the service role; RLS on, no policy = no
-- direct client access.
--
-- Test recipes stay in the app (nothing in Odoo) until the office approves them (later phase).
-- A trial ("I made a trial") turns the raw materials / packaging of the version × pieces into chef
-- losses of kind 'test' (reason "làm hàng thử"). Intermediate recipes are not consumed yet ("coming
-- soon", Axel 12/11).
--
-- Chef losses: anyone in the team declares (status 'pending'); the team lead validates
-- ('validated') and the loss goes to Odoo; a loss still pending after its lab day is pushed anyway
-- ('auto', Axel 12/11). Odoo: scrap from the team's room (raw / packaging / test), from LAB/Stock
-- for a finished product already sent to stock; a finished product lost BEFORE it was sent to
-- stock first gets its own MO "Lab loss <day>" (room → LAB/Stock), then the scrap — so its raw
-- materials leave the room and the loss is valued at cost.

create table if not exists public.lab_tests (
  id uuid primary key default gen_random_uuid(),
  team text not null,
  name text not null,
  family text,
  collection text,
  tags text[] not null default '{}',
  stage text not null default 'idea' check (stage in ('idea','testing','sent','approved','odoo','archived')),
  start_kind text not null default 'new' check (start_kind in ('new','improve','copy')),
  improve_sku text,
  improve_name text,
  photo_url text,
  target_date date,
  pinned boolean not null default false,
  office_feedback text,
  office_feedback_by text,
  office_feedback_at timestamptz,
  created_by_id uuid,
  created_by_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_activity_at timestamptz not null default now()
);
create index if not exists lab_tests_team_idx on public.lab_tests(team, last_activity_at desc);

-- One row per version. recipe (jsonb) is written for ONE BATCH that makes yield_pcs pieces:
--   { subs:   [{ key, name, src:'odoo'|'new', productId?, sku?, uom, qty /*used per batch*/,
--                batchQty?, batchUom?, rows?:[{ tmplId, productId, sku, name, uom, qty }] }],
--     direct: [{ tmplId, productId, sku, name, uom, qty /*per batch*/, kind:'raw'|'packaging' }] }
-- steps (jsonb): [{ title, text, temp?, time? }]
create table if not exists public.lab_test_versions (
  id uuid primary key default gen_random_uuid(),
  test_id uuid not null references public.lab_tests(id) on delete cascade,
  n integer not null,
  note text,
  yield_pcs numeric not null default 1 check (yield_pcs > 0),
  piece_weight_g numeric,
  recipe jsonb not null default '{"subs":[],"direct":[]}'::jsonb,
  steps jsonb not null default '[]'::jsonb,
  is_final boolean not null default false,
  created_by_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (test_id, n)
);

create table if not exists public.lab_test_trials (
  id uuid primary key default gen_random_uuid(),
  test_id uuid not null references public.lab_tests(id) on delete cascade,
  version_id uuid references public.lab_test_versions(id) on delete set null,
  version_n integer not null,
  pcs numeric not null check (pcs > 0),
  stars integer check (stars between 1 and 5),
  verdict text check (verdict in ('ok','adjust','failed')),
  note text,
  photo_url text,
  lab_day date not null,
  made_by_id uuid,
  made_by_name text,
  made_at timestamptz not null default now()
);
create index if not exists lab_test_trials_test_idx on public.lab_test_trials(test_id, made_at desc);

create table if not exists public.lab_chef_losses (
  id uuid primary key default gen_random_uuid(),
  team text not null,
  kind text not null check (kind in ('fin','raw','pack','test')),
  sku text,
  tmpl_id integer,
  product_id integer,
  product_name text not null,
  uom text,
  qty numeric not null check (qty > 0),
  before_stock boolean not null default false,
  reason_tag_id integer,
  reason_tag_name text not null,
  note text,
  photo_url text,
  test_id uuid references public.lab_tests(id) on delete set null,
  trial_id uuid references public.lab_test_trials(id) on delete set null,
  lab_day date not null,
  declared_by_id uuid,
  declared_by_name text,
  declared_at timestamptz not null default now(),
  status text not null default 'pending' check (status in ('pending','validated','auto','deleted')),
  validated_by_id uuid,
  validated_by_name text,
  validated_at timestamptz,
  odoo_state text check (odoo_state in ('pending','done','error')),
  odoo_at timestamptz,
  odoo_tries integer not null default 0,
  odoo_scrap_id integer,
  odoo_mo_id integer,
  odoo_mo_name text,
  odoo_error text,
  updated_at timestamptz not null default now()
);
create index if not exists lab_chef_losses_team_day_idx on public.lab_chef_losses(team, lab_day desc);
create index if not exists lab_chef_losses_push_idx on public.lab_chef_losses(status, odoo_state) where status <> 'deleted';

alter table public.lab_tests enable row level security;
alter table public.lab_test_versions enable row level security;
alter table public.lab_test_trials enable row level security;
alter table public.lab_chef_losses enable row level security;
