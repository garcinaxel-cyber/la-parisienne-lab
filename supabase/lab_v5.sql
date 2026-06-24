-- ============================================================
-- lab_v5.sql -- Architecture refonte : lab_fiche_meta independant
-- ZERO modification des tables catalogue (products, categories...)
-- lab_fiche_meta et lab_fiche_steps avaient 0 lignes, drop+recreate safe
-- ============================================================

-- 1. Supprimer anciennes tables (0 rows, safe)
DROP TABLE IF EXISTS lab_fiche_steps;
DROP TABLE IF EXISTS lab_fiche_meta;

-- 2. Nouvelle lab_fiche_meta entite centrale produit+recette independante du catalogue B2C
CREATE TABLE lab_fiche_meta (
  id                uuid    DEFAULT gen_random_uuid() PRIMARY KEY,
  name_vi           text    NOT NULL,
  name_en           text,
  category          text,
  teams             text[]  NOT NULL DEFAULT '{}',
  image_url         text,
  b2c_product_id    uuid,
  b2c_sku_ref       text,
  doc_code          text,
  weight_grams      numeric,
  tolerance_pct     numeric DEFAULT 3,
  yield_description text,
  prep_time_min     integer,
  allergens         text[]  NOT NULL DEFAULT '{}',
  sensory_vi        text,
  sensory_en        text,
  warning_vi        text,
  warning_en        text,
  notes             text,
  is_active         boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

COMMENT ON COLUMN lab_fiche_meta.b2c_product_id IS 'Reference produit catalogue (products.id) - pas de FK, juste memo';
COMMENT ON COLUMN lab_fiche_meta.teams IS 'Equipes productrices: baby_mama | hung | entremet | baker';

-- 3. lab_fiche_variants formats/tailles avec SKU unique
CREATE TABLE lab_fiche_variants (
  id          uuid    DEFAULT gen_random_uuid() PRIMARY KEY,
  fiche_id    uuid    NOT NULL REFERENCES lab_fiche_meta(id) ON DELETE CASCADE,
  label       text    NOT NULL DEFAULT 'Standard',
  sku         text    UNIQUE,
  weight_g    numeric,
  is_default  boolean NOT NULL DEFAULT false,
  sort_order  integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_lab_fiche_variants_fiche_id ON lab_fiche_variants(fiche_id);
CREATE INDEX idx_lab_fiche_variants_sku ON lab_fiche_variants(sku) WHERE sku IS NOT NULL;

-- 4. Nouvelle lab_fiche_steps liee a la fiche, pas au catalogue
CREATE TABLE lab_fiche_steps (
  id                  uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  fiche_id            uuid NOT NULL REFERENCES lab_fiche_meta(id) ON DELETE CASCADE,
  step_type           text NOT NULL DEFAULT 'step',
  step_number         integer,
  description_vi      text,
  description_en      text,
  duration_minutes    integer,
  temperature_celsius integer,
  quantity_grams      numeric,
  percentage          numeric,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_lab_fiche_steps_fiche_id ON lab_fiche_steps(fiche_id);

-- 5. lab_fiche_ingredients grammages par variant (variant_id NULL = tous variants)
CREATE TABLE lab_fiche_ingredients (
  id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  fiche_id        uuid NOT NULL REFERENCES lab_fiche_meta(id) ON DELETE CASCADE,
  variant_id      uuid REFERENCES lab_fiche_variants(id) ON DELETE CASCADE,
  ingredient_name text NOT NULL,
  quantity        numeric,
  unit            text NOT NULL DEFAULT 'g',
  sort_order      integer NOT NULL DEFAULT 0
);

CREATE INDEX idx_lab_fiche_ingredients_fiche_id  ON lab_fiche_ingredients(fiche_id);
CREATE INDEX idx_lab_fiche_ingredients_variant_id ON lab_fiche_ingredients(variant_id);

-- 6. Etendre lab_assignments lier a fiche+variant
ALTER TABLE lab_assignments
  ADD COLUMN IF NOT EXISTS fiche_id   uuid REFERENCES lab_fiche_meta(id)     ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS variant_id uuid REFERENCES lab_fiche_variants(id)  ON DELETE SET NULL;

-- 7. Etendre lab_order_lines lier a fiche+variant
ALTER TABLE lab_order_lines
  ADD COLUMN IF NOT EXISTS fiche_id   uuid REFERENCES lab_fiche_meta(id)     ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS variant_id uuid REFERENCES lab_fiche_variants(id)  ON DELETE SET NULL;

-- 8a. Migration INSERT depuis products (lecture seule!)
INSERT INTO lab_fiche_meta (
  name_vi, name_en, category, image_url, b2c_product_id, b2c_sku_ref, is_active
)
SELECT
  p.name_vi, p.name_en, c.name_en, p.main_image_url, p.id, p.sku, true
FROM products p
LEFT JOIN categories c ON c.id = p.category_id
WHERE p.is_active = true;

-- 8b. Creer un variant Standard par defaut pour chaque fiche
INSERT INTO lab_fiche_variants (fiche_id, label, sku, is_default, sort_order)
SELECT m.id, 'Standard', m.b2c_sku_ref, true, 0
FROM lab_fiche_meta m;

-- 9. Backfill fiche_id sur lab_assignments via b2c_product_id
UPDATE lab_assignments la
SET fiche_id = m.id
FROM lab_fiche_meta m
WHERE la.product_id = m.b2c_product_id AND la.fiche_id IS NULL;

UPDATE lab_assignments la
SET variant_id = v.id
FROM lab_fiche_variants v
WHERE v.fiche_id = la.fiche_id AND v.is_default = true
  AND la.variant_id IS NULL AND la.fiche_id IS NOT NULL;

-- 10. Backfill fiche_id + variant_id sur lab_order_lines via SKU
UPDATE lab_order_lines lo
SET fiche_id = v.fiche_id, variant_id = v.id
FROM lab_fiche_variants v
WHERE lo.product_sku = v.sku AND lo.fiche_id IS NULL;

-- 11. RLS lab_fiche_meta
ALTER TABLE lab_fiche_meta ENABLE ROW LEVEL SECURITY;
CREATE POLICY "lab_fiche_meta_auth_select" ON lab_fiche_meta FOR SELECT TO authenticated USING (true);
CREATE POLICY "lab_fiche_meta_anon_select" ON lab_fiche_meta FOR SELECT TO anon USING (is_active = true);
CREATE POLICY "lab_fiche_meta_insert" ON lab_fiche_meta
  FOR INSERT TO authenticated WITH CHECK (
    (SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin', 'lab_manager')
    OR EXISTS (SELECT 1 FROM lab_profiles lp WHERE lp.user_id = auth.uid() AND lp.team = ANY(teams))
  );
CREATE POLICY "lab_fiche_meta_update" ON lab_fiche_meta
  FOR UPDATE TO authenticated USING (
    (SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin', 'lab_manager')
    OR EXISTS (SELECT 1 FROM lab_profiles lp WHERE lp.user_id = auth.uid() AND lp.team = ANY(teams))
  );

-- 12. RLS lab_fiche_variants, steps, ingredients
ALTER TABLE lab_fiche_variants ENABLE ROW LEVEL SECURITY;
CREATE POLICY "lab_fiche_variants_auth_all" ON lab_fiche_variants FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "lab_fiche_variants_anon_select" ON lab_fiche_variants FOR SELECT TO anon USING (true);

ALTER TABLE lab_fiche_steps ENABLE ROW LEVEL SECURITY;
CREATE POLICY "lab_fiche_steps_auth_all" ON lab_fiche_steps FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "lab_fiche_steps_anon_select" ON lab_fiche_steps FOR SELECT TO anon USING (true);

ALTER TABLE lab_fiche_ingredients ENABLE ROW LEVEL SECURITY;
CREATE POLICY "lab_fiche_ingredients_auth_all" ON lab_fiche_ingredients FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "lab_fiche_ingredients_anon_select" ON lab_fiche_ingredients FOR SELECT TO anon USING (true);

-- 13. Trigger updated_at
CREATE OR REPLACE FUNCTION update_lab_fiche_meta_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

CREATE TRIGGER trg_lab_fiche_meta_updated_at
  BEFORE UPDATE ON lab_fiche_meta
  FOR EACH ROW EXECUTE FUNCTION update_lab_fiche_meta_updated_at();
