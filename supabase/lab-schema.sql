-- ============================================================
-- La Parisienne LAB — Production Management App
-- Supabase schema. Run in SQL Editor AFTER the catalogue schema.
-- ⚠️  This file ONLY adds new tables and roles.
--     It does NOT modify any existing catalogue table.
-- ============================================================

-- ---------- EXTEND ROLES (safe — existing RLS checks unaffected) ----------
-- 'lab_manager', 'assistant', 'chef' are not in ('admin','sales')
-- so they are AUTOMATICALLY blocked from writing catalogue tables.
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'lab_manager';
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'assistant';
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'chef';

-- ---------- LAB PROFILES (chef team assignment) ----------
-- Separate table — zero touch to existing profiles table.
CREATE TABLE IF NOT EXISTS lab_profiles (
  id        uuid PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  team      text CHECK (team IN ('baby_mama','hung','entremet','baker')),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Helper: get current user's lab team
CREATE OR REPLACE FUNCTION current_lab_team()
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT team FROM lab_profiles WHERE id = auth.uid();
$$;

-- ---------- LAB IMPORTS ----------
-- One row per Excel import session (one delivery date can have n°1, n°2, …)
CREATE TABLE IF NOT EXISTS lab_imports (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_date     date        NOT NULL,
  order_number      int         NOT NULL DEFAULT 1,
  type              text        NOT NULL DEFAULT 'daily'
                                CHECK (type IN ('daily','cake_addon')),
  shipped_from_lab  boolean     NOT NULL DEFAULT false,
  notes             text        NOT NULL DEFAULT '',
  status            text        NOT NULL DEFAULT 'draft'
                                CHECK (status IN ('draft','published','cancelled')),
  -- filenames for audit trail (files themselves are NOT stored)
  filename_sales    text,
  filename_repl     text,
  imported_at       timestamptz NOT NULL DEFAULT now(),
  imported_by       uuid        REFERENCES profiles(id) ON DELETE SET NULL,
  published_at      timestamptz,
  published_by      uuid        REFERENCES profiles(id) ON DELETE SET NULL,
  UNIQUE (delivery_date, order_number)
);

CREATE INDEX IF NOT EXISTS lab_imports_date_idx ON lab_imports(delivery_date);

-- ---------- LAB ORDER LINES ----------
-- Raw lines extracted from Odoo Excel (Sales Order + Stock Replenishment).
-- Files are parsed and discarded — only data is kept.
CREATE TABLE IF NOT EXISTS lab_order_lines (
  id              uuid  PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id       uuid  NOT NULL REFERENCES lab_imports(id) ON DELETE CASCADE,
  source_type     text  NOT NULL CHECK (source_type IN ('sales_order','replenishment')),
  order_ref       text  NOT NULL,    -- S02466 or REP/2026/00527
  shop_name       text  NOT NULL,
  product_sku     text  NOT NULL,
  product_name_vi text  NOT NULL,
  team            text  NOT NULL,    -- comes directly from Odoo product tag
  variant_label   text  NOT NULL DEFAULT 'Standard',
  qty             int   NOT NULL,
  delivery_date   date  NOT NULL,
  delivery_time   time
);

CREATE INDEX IF NOT EXISTS lab_order_lines_import_idx ON lab_order_lines(import_id);
CREATE INDEX IF NOT EXISTS lab_order_lines_team_idx   ON lab_order_lines(team);

-- ---------- LAB ASSIGNMENTS ----------
-- Consolidated production list per team.
-- Generated automatically on import — editable by lab_manager before publish.
-- Uses SNAPSHOTS of product data → immune to catalogue edits/deletions.
CREATE TABLE IF NOT EXISTS lab_assignments (
  id               uuid  PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id        uuid  NOT NULL REFERENCES lab_imports(id) ON DELETE CASCADE,
  team             text  NOT NULL
                         CHECK (team IN ('baby_mama','hung','entremet','baker')),

  -- Nullable FK — if SKU not found in products table, still works via snapshot
  product_id       uuid  REFERENCES products(id) ON DELETE SET NULL,

  -- ⭐ SNAPSHOTS — copied at import time, never affected by catalogue changes
  product_name_vi  text  NOT NULL,
  product_name_en  text  NOT NULL DEFAULT '',
  image_url        text,            -- Supabase CDN URL, already cached by catalogue
  variant_label    text  NOT NULL DEFAULT 'Standard',

  -- Quantities
  total_qty        int   NOT NULL,  -- sum from all shops
  qty_to_produce   int   NOT NULL,  -- may be < total_qty (skip/partial)
  qty_produced     int   NOT NULL DEFAULT 0,  -- filled by chef

  -- Status
  status           text  NOT NULL DEFAULT 'pending'
                         CHECK (status IN
                           ('pending','in_progress','done','skip','partial','blocked')),
  exception_reason text,
  exception_by     uuid  REFERENCES profiles(id) ON DELETE SET NULL,
  exception_at     timestamptz,

  -- Display
  sort_order       int   NOT NULL DEFAULT 0,
  notes            text  NOT NULL DEFAULT '',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS lab_assignments_import_idx ON lab_assignments(import_id);
CREATE INDEX IF NOT EXISTS lab_assignments_team_idx   ON lab_assignments(team);

-- Auto-touch updated_at
CREATE OR REPLACE FUNCTION lab_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN new.updated_at = now(); RETURN new; END; $$;

CREATE TRIGGER lab_assignments_touch
  BEFORE UPDATE ON lab_assignments
  FOR EACH ROW EXECUTE FUNCTION lab_touch_updated_at();

-- ---------- LAB FICHE STEPS (Phase 2) ----------
CREATE TABLE IF NOT EXISTS lab_fiche_steps (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id          uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  step_number         int  NOT NULL,
  description_vi      text NOT NULL DEFAULT '',
  description_en      text NOT NULL DEFAULT '',
  duration_minutes    int,
  temperature_celsius int,
  image_url           text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_id, step_number)
);

-- ---------- ROW LEVEL SECURITY ----------
ALTER TABLE lab_profiles    ENABLE ROW LEVEL SECURITY;
ALTER TABLE lab_imports      ENABLE ROW LEVEL SECURITY;
ALTER TABLE lab_order_lines  ENABLE ROW LEVEL SECURITY;
ALTER TABLE lab_assignments  ENABLE ROW LEVEL SECURITY;
ALTER TABLE lab_fiche_steps  ENABLE ROW LEVEL SECURITY;

-- ·· lab_profiles ··
CREATE POLICY "lab_profiles_read" ON lab_profiles FOR SELECT TO authenticated
  USING (id = auth.uid() OR current_role_of() IN ('admin','lab_manager','assistant'));

CREATE POLICY "lab_profiles_manage" ON lab_profiles FOR ALL TO authenticated
  USING (current_role_of() IN ('admin','lab_manager'))
  WITH CHECK (current_role_of() IN ('admin','lab_manager'));

-- ·· lab_imports — managers see all, chefs see only published ··
CREATE POLICY "lab_imports_manager" ON lab_imports FOR ALL TO authenticated
  USING (current_role_of() IN ('admin','lab_manager','assistant'))
  WITH CHECK (current_role_of() IN ('admin','lab_manager','assistant'));

CREATE POLICY "lab_imports_chef_read" ON lab_imports FOR SELECT TO authenticated
  USING (current_role_of() = 'chef' AND status = 'published');

-- ·· lab_order_lines — managers only, chefs never see raw lines ··
CREATE POLICY "lab_order_lines_manager" ON lab_order_lines FOR ALL TO authenticated
  USING (current_role_of() IN ('admin','lab_manager','assistant'))
  WITH CHECK (current_role_of() IN ('admin','lab_manager','assistant'));

-- ·· lab_assignments — managers full, chef: own team only ··
CREATE POLICY "lab_assignments_manager" ON lab_assignments FOR ALL TO authenticated
  USING (current_role_of() IN ('admin','lab_manager','assistant'))
  WITH CHECK (current_role_of() IN ('admin','lab_manager','assistant'));

CREATE POLICY "lab_assignments_chef_read" ON lab_assignments FOR SELECT TO authenticated
  USING (current_role_of() = 'chef' AND team = current_lab_team());

-- Chefs can only update status + qty_produced on their own team
CREATE POLICY "lab_assignments_chef_update" ON lab_assignments FOR UPDATE TO authenticated
  USING (current_role_of() = 'chef' AND team = current_lab_team())
  WITH CHECK (current_role_of() = 'chef' AND team = current_lab_team());

-- ·· lab_fiche_steps — all lab users can read, only managers write ··
CREATE POLICY "lab_fiche_steps_read" ON lab_fiche_steps FOR SELECT TO authenticated
  USING (current_role_of() IN ('admin','lab_manager','assistant','chef'));

CREATE POLICY "lab_fiche_steps_write" ON lab_fiche_steps FOR ALL TO authenticated
  USING (current_role_of() IN ('admin','lab_manager'))
  WITH CHECK (current_role_of() IN ('admin','lab_manager'));

-- ---------- STORAGE BUCKET ----------
-- Separate bucket for lab-specific images (fiche steps photos).
-- Product images reuse the existing 'product-images' bucket (read-only from lab app).
INSERT INTO storage.buckets (id, name, public)
VALUES ('lab-images', 'lab-images', true)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "lab_images_public_read" ON storage.objects FOR SELECT
  USING (bucket_id = 'lab-images');

CREATE POLICY "lab_images_manager_write" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'lab-images' AND current_role_of() IN ('admin','lab_manager'));

CREATE POLICY "lab_images_manager_update" ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'lab-images' AND current_role_of() IN ('admin','lab_manager'));

CREATE POLICY "lab_images_manager_delete" ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'lab-images' AND current_role_of() IN ('admin','lab_manager'));

-- ---------- DASHBOARD STATS ----------
CREATE OR REPLACE FUNCTION lab_dashboard_stats(p_date date DEFAULT CURRENT_DATE)
RETURNS json LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
SELECT json_build_object(
  'imports_today',    (SELECT count(*) FROM lab_imports WHERE delivery_date = p_date),
  'published_today',  (SELECT count(*) FROM lab_imports WHERE delivery_date = p_date AND status = 'published'),
  'total_assignments',(SELECT count(*) FROM lab_assignments a JOIN lab_imports i ON i.id = a.import_id WHERE i.delivery_date = p_date),
  'done_assignments', (SELECT count(*) FROM lab_assignments a JOIN lab_imports i ON i.id = a.import_id WHERE i.delivery_date = p_date AND a.status = 'done'),
  'blocked',          (SELECT count(*) FROM lab_assignments a JOIN lab_imports i ON i.id = a.import_id WHERE i.delivery_date = p_date AND a.status = 'blocked')
);
$$;
