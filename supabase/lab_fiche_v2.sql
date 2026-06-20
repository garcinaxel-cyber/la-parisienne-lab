-- ============================================================
-- La Parisienne LAB — Fiche Technique V2
-- Run in Supabase SQL Editor AFTER lab-schema.sql
-- Adds: ingredient rows, fiche metadata (weight, doc code, sensory...)
-- ============================================================

-- 1. Extend lab_fiche_steps with step type + ingredient fields
ALTER TABLE lab_fiche_steps
  ADD COLUMN IF NOT EXISTS step_type        text    NOT NULL DEFAULT 'step',
  ADD COLUMN IF NOT EXISTS quantity_grams   numeric(8,1),
  ADD COLUMN IF NOT EXISTS percentage       numeric(5,2);

-- Replace unique constraint: was (product_id, step_number), now per type
ALTER TABLE lab_fiche_steps
  DROP CONSTRAINT IF EXISTS lab_fiche_steps_product_id_step_number_key;

DO $$ BEGIN
  ALTER TABLE lab_fiche_steps
    ADD CONSTRAINT lab_fiche_steps_unique_per_type
    UNIQUE (product_id, step_type, step_number);
EXCEPTION WHEN duplicate_table THEN NULL;
END $$;

-- 2. Fiche metadata per product
CREATE TABLE IF NOT EXISTS lab_fiche_meta (
  product_id      uuid        PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
  doc_code        text,
  weight_grams    numeric(8,1),
  tolerance_pct   numeric(4,1)  DEFAULT 3,
  sensory_vi      text          DEFAULT '',
  sensory_en      text          DEFAULT '',
  warning_vi      text          DEFAULT '',
  warning_en      text          DEFAULT '',
  created_at      timestamptz   NOT NULL DEFAULT now(),
  updated_at      timestamptz   NOT NULL DEFAULT now()
);

ALTER TABLE lab_fiche_meta ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "lab_fiche_meta_read"  ON lab_fiche_meta;
DROP POLICY IF EXISTS "lab_fiche_meta_write" ON lab_fiche_meta;

CREATE POLICY "lab_fiche_meta_read" ON lab_fiche_meta
  FOR SELECT TO authenticated
  USING (current_role_of() IN ('admin','lab_manager','assistant','chef'));

CREATE POLICY "lab_fiche_meta_write" ON lab_fiche_meta
  FOR ALL TO authenticated
  USING   (current_role_of() IN ('admin','lab_manager'))
  WITH CHECK (current_role_of() IN ('admin','lab_manager'));
