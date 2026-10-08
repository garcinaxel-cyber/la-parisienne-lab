-- Raw materials, phase 1 (Axel, 2026-10-08): chefs' purchase requests and storage withdrawals live
-- in the app only — nothing is written to Odoo. Odoo is only READ (product list, vendors, recipes).
-- All access goes through server actions with the service role (role checked in code), so RLS is
-- on with no policy: browsers cannot read or write these tables directly.
-- Never purged (Axel: purchase history is kept for vendor and lead-time comparisons).

create table if not exists public.lab_raw_materials (
  tmpl_id integer primary key,               -- Odoo product.template id
  product_id integer,                        -- Odoo product.product id (first variant)
  sku text,
  name text not null,
  uom text not null default 'kg',
  type text not null default 'dry' check (type in ('dry','fresh','frozen')),
  sub text not null default 'other',
  packs jsonb not null default '[]'::jsonb,  -- [{label, factor}] factor = base units (kg/L) per pack
  visible boolean not null default true,     -- shown to chefs
  checked boolean not null default false,    -- classification confirmed by purchasing
  purchased boolean not null default false,  -- already bought at least once in Odoo
  vendor_id integer,                         -- first vendor declared in Odoo
  vendor_name text,
  vendors jsonb not null default '[]'::jsonb,-- [{id, name}] every vendor declared in Odoo
  active boolean not null default true,
  synced_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by_name text
);

create table if not exists public.lab_raw_withdrawals (
  id uuid primary key default gen_random_uuid(),
  no bigint generated always as identity,
  team text not null,
  taken_by text,
  created_by uuid,
  created_at timestamptz not null default now()
);
create index if not exists lab_raw_withdrawals_created_idx on public.lab_raw_withdrawals (created_at desc);
create index if not exists lab_raw_withdrawals_team_idx on public.lab_raw_withdrawals (team, created_at desc);

create table if not exists public.lab_raw_withdrawal_lines (
  id uuid primary key default gen_random_uuid(),
  withdrawal_id uuid not null references public.lab_raw_withdrawals(id) on delete cascade,
  tmpl_id integer,
  sku text,
  name text not null,
  uom text not null,
  qty numeric not null check (qty > 0),      -- in base unit (kg / L / unit)
  pack_label text,                           -- when the chef counted in packs
  pack_count numeric,
  corrected_qty numeric,                     -- storage manager's correction (base unit)
  corrected_by_name text,
  corrected_at timestamptz
);
create index if not exists lab_raw_withdrawal_lines_w_idx on public.lab_raw_withdrawal_lines (withdrawal_id);
create index if not exists lab_raw_withdrawal_lines_sku_idx on public.lab_raw_withdrawal_lines (sku);

create table if not exists public.lab_purchase_requests (
  id uuid primary key default gen_random_uuid(),
  no bigint generated always as identity,
  team text not null,
  requested_by text,
  created_by uuid,
  created_at timestamptz not null default now()
);
create index if not exists lab_purchase_requests_created_idx on public.lab_purchase_requests (created_at desc);

create table if not exists public.lab_purchase_request_lines (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.lab_purchase_requests(id) on delete cascade,
  tmpl_id integer,                           -- null for a new product suggested by a chef
  sku text,
  name text not null,
  uom text not null default 'kg',
  qty numeric not null check (qty > 0),
  brand text,
  brand_strict boolean not null default false,
  note text,
  is_new boolean not null default false,
  photo_url text,
  new_state text check (new_state in ('open','linked','to_create')),
  vendor_id integer,
  vendor_name text,
  status text not null default 'pending' check (status in ('pending','ordered','received','cancelled')),
  po_ref text,
  ordered_at timestamptz,
  ordered_by_name text,
  received_at timestamptz,
  received_by_name text,
  cancelled_at timestamptz,
  cancelled_by_name text,
  created_at timestamptz not null default now()
);
create index if not exists lab_purchase_request_lines_req_idx on public.lab_purchase_request_lines (request_id);
create index if not exists lab_purchase_request_lines_status_idx on public.lab_purchase_request_lines (status, created_at desc);

alter table public.lab_raw_materials enable row level security;
alter table public.lab_raw_withdrawals enable row level security;
alter table public.lab_raw_withdrawal_lines enable row level security;
alter table public.lab_purchase_requests enable row level security;
alter table public.lab_purchase_request_lines enable row level security;
