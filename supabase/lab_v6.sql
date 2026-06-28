-- ============================================================
-- lab_v6.sql — Worker role: enum + RLS policies
-- Run in Supabase SQL Editor
-- ZERO impact on catalogue tables
-- ============================================================

-- 1. Add worker to role enum
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'worker';

-- 2. lab_imports: worker can read published imports (same as chef)
CREATE POLICY "lab_imports_worker_read" ON lab_imports FOR SELECT TO authenticated
  USING (current_role_of() = 'worker' AND status = 'published');

-- 3. lab_assignments: worker can read own team's assignments (no write = cannot advance status)
CREATE POLICY "lab_assignments_worker_read" ON lab_assignments FOR SELECT TO authenticated
  USING (current_role_of() = 'worker' AND team = current_lab_team());

-- 4. lab_fiche_steps (lab_v5 table): tighten auth_all → select-only for non-managers
DROP POLICY IF EXISTS "lab_fiche_steps_auth_all" ON lab_fiche_steps;
CREATE POLICY "lab_fiche_steps_select" ON lab_fiche_steps
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "lab_fiche_steps_write" ON lab_fiche_steps
  FOR ALL TO authenticated
  USING ((SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin', 'lab_manager'))
  WITH CHECK ((SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin', 'lab_manager'));

-- 5. lab_fiche_meta: tighten insert/update to admin/lab_manager only
DROP POLICY IF EXISTS "lab_fiche_meta_insert" ON lab_fiche_meta;
DROP POLICY IF EXISTS "lab_fiche_meta_update" ON lab_fiche_meta;
CREATE POLICY "lab_fiche_meta_insert" ON lab_fiche_meta
  FOR INSERT TO authenticated
  WITH CHECK ((SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin', 'lab_manager'));
CREATE POLICY "lab_fiche_meta_update" ON lab_fiche_meta
  FOR UPDATE TO authenticated
  USING ((SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin', 'lab_manager'));

-- 6. lab_fiche_variants + lab_fiche_ingredients: tighten auth_all similarly
DROP POLICY IF EXISTS "lab_fiche_variants_auth_all" ON lab_fiche_variants;
CREATE POLICY "lab_fiche_variants_select" ON lab_fiche_variants
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "lab_fiche_variants_write" ON lab_fiche_variants
  FOR ALL TO authenticated
  USING ((SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin', 'lab_manager'))
  WITH CHECK ((SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin', 'lab_manager'));

DROP POLICY IF EXISTS "lab_fiche_ingredients_auth_all" ON lab_fiche_ingredients;
CREATE POLICY "lab_fiche_ingredients_select" ON lab_fiche_ingredients
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "lab_fiche_ingredients_write" ON lab_fiche_ingredients
  FOR ALL TO authenticated
  USING ((SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin', 'lab_manager'))
  WITH CHECK ((SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin', 'lab_manager'));

-- 7. lab_profiles: worker reads own profile via id = auth.uid() (already covered)
DROP POLICY IF EXISTS "lab_profiles_read" ON lab_profiles;
CREATE POLICY "lab_profiles_read" ON lab_profiles FOR SELECT TO authenticated
  USING (id = auth.uid() OR current_role_of() IN ('admin','lab_manager','assistant'));
