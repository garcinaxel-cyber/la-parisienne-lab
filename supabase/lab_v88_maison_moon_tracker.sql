-- Maison Moon (OEM Maison Mooncake) order tracker — step 1: tables + seed.
-- 100% additive: new lab_mm_* tables only, nothing existing is altered. Every product of the
-- order is identified by its SKU prefix "MM-" (Odoo default_code = lab_fiche_variants.sku).
-- Axel, 2026-09-26.

-- Order lines (editable quantities — the client keeps changing them).
create table if not exists lab_mm_order_items (
  sku text primary key,
  product_name text not null,
  group_key text not null,        -- biscuit/batch family: production is tracked in kg per group
  group_name text not null,       -- (both socola nho khô SKUs share one group, format chosen at packaging)
  unit text not null check (unit in ('bag','kg')),
  unit_weight_g numeric not null, -- 80 / 100 g per bag; 1000 for items sold by the kg
  qty_ordered numeric not null default 0, -- bags, or kg when unit = 'kg'
  sort_order int not null default 0,
  is_active boolean not null default true,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  updated_by_name text
);

-- Audit trail of quantity changes.
create table if not exists lab_mm_order_item_history (
  id uuid primary key default gen_random_uuid(),
  sku text not null references lab_mm_order_items(sku),
  qty_before numeric,
  qty_after numeric,
  changed_at timestamptz not null default now(),
  changed_by uuid,
  changed_by_name text
);

-- Global settings (client name for delivery orders, deadline, scenario label…).
create table if not exists lab_mm_settings (
  key text primary key,
  value text,
  updated_at timestamptz not null default now(),
  updated_by_name text
);

-- Hung's production in kg (one row per MM extra-production entry — written in step 2).
create table if not exists lab_mm_production_log (
  id uuid primary key default gen_random_uuid(),
  prod_date date not null,
  group_key text not null,
  sku text,                        -- SKU picked in the extra modal (informative, kg pooled by group)
  weight_kg numeric not null check (weight_kg > 0),
  assignment_id uuid,              -- the lab_assignments extra card, if any
  note text,
  created_at timestamptz not null default now(),
  created_by uuid,
  created_by_name text
);

-- Assistants' daily packaging + scraps. qty = bags (unit 'bag') or kg (unit 'kg').
create table if not exists lab_mm_packaging_log (
  id uuid primary key default gen_random_uuid(),
  pack_date date not null,
  kind text not null check (kind in ('packed','scrap_bulk','scrap_finished')),
  sku text references lab_mm_order_items(sku), -- null allowed for scrap_bulk (group level)
  group_key text not null,
  qty numeric not null default 0,     -- bags (or kg for kg items); for scrap_bulk: kg
  bags_count int,                     -- cashew only: number of 5-10 kg sacks filled
  note text,
  odoo_mo_id bigint,                  -- manufacturing order created at packaging (step 4)
  odoo_status text,                   -- pending | done | error
  odoo_error text,
  created_at timestamptz not null default now(),
  created_by uuid,
  created_by_name text,
  updated_at timestamptz,
  updated_by_name text
);
create index if not exists lab_mm_packaging_log_date_idx on lab_mm_packaging_log(pack_date);

-- One-time opening balance (what was already made before the tracker went live).
create table if not exists lab_mm_initial_inventory (
  sku text primary key references lab_mm_order_items(sku),
  bulk_kg numeric not null default 0,
  packed_qty numeric not null default 0,
  delivered_qty numeric not null default 0,
  set_at timestamptz not null default now(),
  set_by uuid,
  set_by_name text
);

-- Physical count of finished (packed, not delivered) stock.
create table if not exists lab_mm_fg_counts (
  id uuid primary key default gen_random_uuid(),
  count_date date not null,
  sku text not null references lab_mm_order_items(sku),
  qty_counted numeric not null,
  qty_theoretical numeric,
  created_at timestamptz not null default now(),
  created_by uuid,
  created_by_name text,
  unique (count_date, sku)
);

-- Raw materials used by the order + usage per kg of finished product (per group).
create table if not exists lab_mm_ingredients (
  code text primary key,            -- Odoo default_code (or ODOO-<id> when the product has none)
  name text not null,
  unit text not null,               -- kg | L
  sort_order int not null default 0
);
create table if not exists lab_mm_ingredient_usage (
  group_key text not null,
  ingredient_code text not null references lab_mm_ingredients(code),
  qty_per_kg numeric not null,      -- kg (or L) of ingredient per kg of finished product, bake loss incl.
  primary key (group_key, ingredient_code)
);

-- Weekly raw-material inventory (stock available for the order).
create table if not exists lab_mm_rm_inventory (
  id uuid primary key default gen_random_uuid(),
  week_start date not null,
  ingredient_code text not null references lab_mm_ingredients(code),
  qty numeric not null,
  created_at timestamptz not null default now(),
  created_by uuid,
  created_by_name text,
  unique (week_start, ingredient_code)
);

-- RLS: everyone on the lab side can read (Hung's station sees the same screens);
-- writes are split by role.
do $$ declare t text; begin
  foreach t in array array['lab_mm_order_items','lab_mm_order_item_history','lab_mm_settings','lab_mm_production_log',
    'lab_mm_packaging_log','lab_mm_initial_inventory','lab_mm_fg_counts','lab_mm_ingredients','lab_mm_ingredient_usage','lab_mm_rm_inventory'] loop
    execute format('alter table %I enable row level security', t);
    execute format($p$create policy %I on %I for select using (current_role_of() = any (array['admin','lab_manager','assistant','chef','worker']::user_role[]))$p$, t||'_read', t);
  end loop;
end $$;

-- Order parameters, initial inventory, recipes: admin / lab_manager.
do $$ declare t text; begin
  foreach t in array array['lab_mm_order_items','lab_mm_order_item_history','lab_mm_settings','lab_mm_initial_inventory','lab_mm_ingredients','lab_mm_ingredient_usage'] loop
    execute format($p$create policy %I on %I for all using (current_role_of() = any (array['admin','lab_manager']::user_role[])) with check (current_role_of() = any (array['admin','lab_manager']::user_role[]))$p$, t||'_manage', t);
  end loop;
end $$;

-- Packaging, finished-goods counts, raw-material inventory: assistants too.
do $$ declare t text; begin
  foreach t in array array['lab_mm_packaging_log','lab_mm_fg_counts','lab_mm_rm_inventory'] loop
    execute format($p$create policy %I on %I for all using (current_role_of() = any (array['admin','lab_manager','assistant']::user_role[])) with check (current_role_of() = any (array['admin','lab_manager','assistant']::user_role[]))$p$, t||'_write', t);
  end loop;
end $$;

-- Production log: Hung's team (chef/worker) inserts; managers can fix.
create policy lab_mm_production_log_insert on lab_mm_production_log for insert
  with check (current_role_of() = any (array['admin','lab_manager','assistant','chef','worker']::user_role[]));
create policy lab_mm_production_log_manage on lab_mm_production_log for update
  using (current_role_of() = any (array['admin','lab_manager']::user_role[]));
create policy lab_mm_production_log_delete on lab_mm_production_log for delete
  using (current_role_of() = any (array['admin','lab_manager']::user_role[]));

-- Seed — scenario 100 % · 5.6 t + cashews (1,380 kg).
insert into lab_mm_order_items (sku,product_name,group_key,group_name,unit,unit_weight_g,qty_ordered,sort_order) values
('MM-BQV80','Bánh quy vani 80g','vanilla','Vani','bag',80,16000,1),
('MM-BQSNK80','Bánh quy socola nho khô 80g','grappe','Socola nho khô','bag',80,12000,2),
('MM-BQSNK100','Bánh quy socola nho khô 100g','grappe','Socola nho khô','bag',100,2000,3),
('MM-BQMDC100','Bánh quy matcha dẻ cười 100g','pist','Matcha dẻ cười','bag',100,2000,4),
('MM-BQLMBT80','Bánh quy lưỡi mèo bá tước 80g','tra','Lưỡi mèo bá tước','bag',80,11000,5),
('MM-BQLMM80','Bánh quy lưỡi mèo matcha 80g','lmm','Lưỡi mèo matcha','bag',80,8000,6),
('MM-BQMD80','Bánh quy vị mè đen An Giang 80g','tuile','Mè đen An Giang','bag',80,7000,7),
('MM-SC80','Snap cookie 80g','sable','Snap cookie','bag',80,6000,8),
('MM-SCBH100','Socola bạc hà 100g','choco','Socola bạc hà','bag',100,4000,9),
('MM-HDTY-KG','Hạt điều gia vị Tomyum (kg)','cashew_ty','Hạt điều Tomyum','kg',1000,560,10),
('MM-HDNVH-KG','Hạt điều Ngũ Vị Hương (kg)','cashew_nvh','Hạt điều Ngũ Vị Hương','kg',1000,460,11),
('MM-HDTEG-KG','Hạt điều gia vị Trà Earl Grey và vỏ cam vàng (kg)','cashew_teg','Hạt điều Earl Grey vỏ cam','kg',1000,360,12)
on conflict (sku) do nothing;

insert into lab_mm_settings (key,value) values
 ('scenario','100 % · 5,6 t'),('deadline','2027-01-15'),('client_name',null)
on conflict (key) do nothing;

insert into lab_mm_ingredients (code,name,unit,sort_order) values
('152-MH.206','Bơ Mộc Châu','kg',1),
('152-MH.056','Đường bột (đường xay)','kg',2),
('152-MH.143','Bột mì T45 (Việt Nam)','kg',3),
('152-MH.188','Trứng','kg',4),
('152-MH.101','Chiết xuất vani','L',5),
('152-MH.518','Hương vani (arôme)','L',6),
('152-MH.620','Natri benzoat (chất bảo quản)','kg',7),
('152-MH.621','Mixed Tocopherols (chống hôi dầu)','kg',8),
('152-MH.096','Đường tinh luyện Biên Hòa','kg',9),
('152-MH.043','Bột nở (baking powder)','kg',10),
('152-MH.085','Sô-cô-la compound đen','kg',11),
('152-MH.063','Nho khô','kg',12),
('152-MH.204','Bột matcha','kg',13),
('152-MH.086','Tinh bột bắp','kg',14),
('152-MH.103','Sữa tươi','L',15),
('152-MH.041','Mạch nha (malt syrup)','kg',16),
('152-MH.062','Hạt dẻ cười','kg',17),
('152-MH.352','Trà Earl Grey (trà bá tước)','kg',18),
('152-MH.142','Muối biển xanh','kg',19),
('NOCODE-sesame','Hạt mè đen','kg',20),
('152-MH.164','Dầu mè đen','L',21),
('152-MH.016','Sữa bột','kg',22),
('152-MH.300','Hạnh nhân','kg',23),
('152-MH.596','Chiết xuất bạc hà (peppermint)','L',24),
('152-MH.160','Hạt điều (cashew nut)','kg',25),
('152-MH.214','Cam vàng (yellow orange)','kg',26),
('ODOO-6563','Ngũ vị hương (five spice)','kg',27),
('152-MH.817','Sốt Tom Yum','kg',28),
('ODOO-6544','Ớt bột (chili powder)','kg',29)
on conflict (code) do nothing;

insert into lab_mm_ingredient_usage (group_key,ingredient_code,qty_per_kg) values
('vanilla','152-MH.206',0.359228),
('vanilla','152-MH.056',0.224517),
('vanilla','152-MH.143',0.493938),
('vanilla','152-MH.188',0.089807),
('vanilla','152-MH.101',0.00449),
('vanilla','152-MH.518',0.00449),
('vanilla','152-MH.620',0.001176),
('vanilla','152-MH.621',0.003529),
('grappe','152-MH.096',0.292291),
('grappe','152-MH.188',0.146145),
('grappe','152-MH.206',0.219218),
('grappe','152-MH.143',0.292291),
('grappe','152-MH.043',0.007307),
('grappe','152-MH.085',0.146145),
('grappe','152-MH.063',0.073073),
('grappe','152-MH.620',0.001176),
('grappe','152-MH.621',0.003529),
('pist','152-MH.056',0.129622),
('pist','152-MH.143',0.401829),
('pist','152-MH.204',0.012962),
('pist','152-MH.206',0.309422),
('pist','152-MH.086',0.012962),
('pist','152-MH.518',0.006481),
('pist','152-MH.103',0.064811),
('pist','152-MH.188',0.064811),
('pist','152-MH.620',0.001148),
('pist','152-MH.621',0.003445),
('pist','152-MH.041',0.050178),
('pist','152-MH.096',0.050178),
('pist','152-MH.062',0.04516),
('tra','152-MH.188',0.399361),
('tra','152-MH.096',0.399361),
('tra','152-MH.143',0.399361),
('tra','152-MH.043',0.007987),
('tra','152-MH.206',0.035942),
('tra','152-MH.352',0.007987),
('tra','152-MH.620',0.00125),
('tra','152-MH.621',0.00375),
('lmm','152-MH.188',0.399361),
('lmm','152-MH.096',0.399361),
('lmm','152-MH.143',0.399361),
('lmm','152-MH.043',0.007987),
('lmm','152-MH.206',0.035942),
('lmm','152-MH.204',0.011981),
('lmm','152-MH.620',0.001254),
('lmm','152-MH.621',0.003762),
('tuile','152-MH.188',0.357188),
('tuile','152-MH.056',0.306162),
('tuile','152-MH.206',0.306162),
('tuile','152-MH.143',0.255135),
('tuile','152-MH.142',0.005103),
('tuile','NOCODE-sesame',0.102054),
('tuile','152-MH.164',0.015308),
('tuile','152-MH.620',0.001347),
('tuile','152-MH.621',0.004041),
('sable','152-MH.096',0.306373),
('sable','152-MH.206',0.153186),
('sable','152-MH.188',0.204248),
('sable','152-MH.143',0.326797),
('sable','152-MH.016',0.081699),
('sable','152-MH.142',0.002042),
('sable','152-MH.101',0.002042),
('sable','152-MH.300',0.102124),
('sable','152-MH.518',0.002042),
('sable','152-MH.620',0.001181),
('sable','152-MH.621',0.003542),
('choco','152-MH.085',0.990099),
('choco','152-MH.596',0.009901),
('cashew_teg','152-MH.160',0.795229),
('cashew_teg','152-MH.096',0.119284),
('cashew_teg','152-MH.142',0.001988),
('cashew_teg','152-MH.352',0.003976),
('cashew_teg','152-MH.214',0.059642),
('cashew_nvh','152-MH.160',0.842105),
('cashew_nvh','152-MH.096',0.126316),
('cashew_nvh','152-MH.142',0.006316),
('cashew_nvh','ODOO-6563',0.008421),
('cashew_ty','152-MH.160',0.811359),
('cashew_ty','152-MH.096',0.121704),
('cashew_ty','152-MH.817',0.040568),
('cashew_ty','ODOO-6544',0.004057)
on conflict (group_key, ingredient_code) do nothing;
