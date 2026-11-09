-- Lab inventory of raw materials and packaging (Axel, 2026-11-09): counted in the app by zone
-- (raw: dry / fresh / frozen; packaging: no zones, the whole packaging category), each line keeps
-- its own count time so a count spread over several days stays right; items the team cannot find
-- are sent as a photo "to identify"; Odoo is only called when the count is opened (scope) and sent
-- (one draft stock.inventory at LAB/Stock). Server-side only (service role), RLS on with no policy.

create table if not exists public.lab_stock_counts (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('raw', 'packaging')),
  count_date date not null,
  status text not null default 'draft' check (status in ('draft', 'submitted')),
  created_by uuid,
  created_by_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  submitted_at timestamptz,
  submitted_by_name text,
  odoo_inventory_id integer,
  push_status text,
  push_error text
);
-- one open count per kind at a time
create unique index if not exists lab_stock_counts_one_draft on public.lab_stock_counts (kind) where status = 'draft';

create table if not exists public.lab_stock_count_lines (
  id uuid primary key default gen_random_uuid(),
  count_id uuid not null references public.lab_stock_counts(id) on delete cascade,
  tmpl_id integer not null,
  product_id integer,
  in_scope boolean not null default true,       -- in the list to count (stock or movement at LAB)
  qty numeric,                                   -- in the product unit; null = not counted
  entry jsonb,                                   -- what was typed: {packs, pack, loose} or {brands:{...}}
  not_found boolean not null default false,      -- "Pas trouvé" (stays unchanged in Odoo)
  counted_at timestamptz,                        -- first count time: theoretical is taken at this time
  counted_by_name text,
  theoretical numeric,                           -- filled on preview / send
  odoo_line_id integer,
  updated_at timestamptz not null default now(),
  unique (count_id, tmpl_id)
);
create index if not exists lab_stock_count_lines_count on public.lab_stock_count_lines (count_id);

create table if not exists public.lab_stock_count_unknowns (
  id uuid primary key default gen_random_uuid(),
  count_id uuid not null references public.lab_stock_counts(id) on delete cascade,
  photo_path text,
  photo_url text,
  qty numeric,
  unit text,
  note text,
  zone text,
  created_by_name text,
  created_at timestamptz not null default now(),
  status text not null default 'open' check (status in ('open', 'matched', 'absent', 'ignored')),
  tmpl_id integer,
  resolved_qty numeric,
  resolved_by_name text,
  resolved_at timestamptz
);
create index if not exists lab_stock_count_unknowns_count on public.lab_stock_count_unknowns (count_id);

-- Names the team really uses ("miến khô", "bột mì số 13"), learnt when an unknown photo is matched.
create table if not exists public.lab_raw_aliases (
  id bigserial primary key,
  tmpl_id integer not null,
  alias text not null,
  created_by_name text,
  created_at timestamptz not null default now()
);
create unique index if not exists lab_raw_aliases_uniq on public.lab_raw_aliases (tmpl_id, lower(alias));

-- Photos asked to the storage before an inventory: done when the photo exists, or "not in stock".
create table if not exists public.lab_photo_requests (
  tmpl_id integer primary key,
  status text not null default 'open' check (status in ('open', 'not_in_stock')),
  requested_at timestamptz not null default now(),
  requested_by_name text,
  updated_at timestamptz not null default now(),
  updated_by_name text
);

alter table public.lab_stock_counts enable row level security;
alter table public.lab_stock_count_lines enable row level security;
alter table public.lab_stock_count_unknowns enable row level security;
alter table public.lab_raw_aliases enable row level security;
alter table public.lab_photo_requests enable row level security;
