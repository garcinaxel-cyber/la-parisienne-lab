-- ================================================================
-- lab_v9.sql — 2026-07-04
-- 1) Backfill fiche_id/variant_id on existing rows (SKU matching)
-- 2) Lock anonymous reads on fiche tables (stations now require login)
-- 3) Chef edit rights: steps + variant quantities, own teams only
-- Catalogue tables: products is READ ONLY in the backfill join,
-- nothing in the B2C catalogue is modified.
-- ================================================================

-- ── 1a) Backfill lab_order_lines via product_sku ──
UPDATE lab_order_lines ol
SET fiche_id = v.fiche_id, variant_id = v.id
FROM lab_fiche_variants v
WHERE ol.fiche_id IS NULL
  AND ol.product_sku IS NOT NULL
  AND ol.product_sku = v.sku;

-- ── 1b) Backfill lab_assignments via products.sku (read-only join) ──
UPDATE lab_assignments a
SET fiche_id = v.fiche_id, variant_id = v.id
FROM products p
JOIN lab_fiche_variants v ON v.sku = p.sku
WHERE a.fiche_id IS NULL
  AND a.product_id = p.id;

-- ── 2) Remove anonymous read access to recipes ──
DROP POLICY IF EXISTS "lab_fiche_meta_anon_select"  ON lab_fiche_meta;
DROP POLICY IF EXISTS "lab_fiche_variants_anon_select" ON lab_fiche_variants;
DROP POLICY IF EXISTS "lab_fiche_steps_anon_select" ON lab_fiche_steps;

-- ── 3) Chef edit rights — assembly steps + per-variant quantities,
--       only for fiches whose teams[] contains the chef's team ──
DROP POLICY IF EXISTS "lab_fiche_steps_chef_write" ON lab_fiche_steps;
CREATE POLICY "lab_fiche_steps_chef_write" ON lab_fiche_steps
  FOR ALL TO authenticated
  USING (
    current_role_of() = 'chef'
    AND EXISTS (
      SELECT 1 FROM lab_fiche_meta m
      WHERE m.id = lab_fiche_steps.fiche_id
        AND m.teams @> ARRAY[current_lab_team()::text]
    )
  )
  WITH CHECK (
    current_role_of() = 'chef'
    AND EXISTS (
      SELECT 1 FROM lab_fiche_meta m
      WHERE m.id = lab_fiche_steps.fiche_id
        AND m.teams @> ARRAY[current_lab_team()::text]
    )
  );

DROP POLICY IF EXISTS "lab_vq_chef_write" ON lab_fiche_variant_quantities;
CREATE POLICY "lab_vq_chef_write" ON lab_fiche_variant_quantities
  FOR ALL TO authenticated
  USING (
    current_role_of() = 'chef'
    AND EXISTS (
      SELECT 1 FROM lab_fiche_steps s
      JOIN lab_fiche_meta m ON m.id = s.fiche_id
      WHERE s.id = lab_fiche_variant_quantities.step_id
        AND m.teams @> ARRAY[current_lab_team()::text]
    )
  )
  WITH CHECK (
    current_role_of() = 'chef'
    AND EXISTS (
      SELECT 1 FROM lab_fiche_steps s
      JOIN lab_fiche_meta m ON m.id = s.fiche_id
      WHERE s.id = lab_fiche_variant_quantities.step_id
        AND m.teams @> ARRAY[current_lab_team()::text]
    )
  );

-- Done.
