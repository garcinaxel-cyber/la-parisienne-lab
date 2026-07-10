-- lab_v14 — allow chefs to add EXTRA production on their own team.
-- Root cause of "extra production doesn't show up when a chef saves it":
-- lab_assignments only had chef SELECT + UPDATE policies, no INSERT → the insert
-- was silently blocked by RLS (data = null), so nothing appeared.
-- Scope kept tight: chefs may insert ONLY is_extra rows for their OWN team.
-- They still cannot fabricate order cards (those come from imports, managers only).

DROP POLICY IF EXISTS "lab_assignments_chef_insert" ON lab_assignments;
CREATE POLICY "lab_assignments_chef_insert" ON lab_assignments FOR INSERT TO authenticated
  WITH CHECK (
    current_role_of() = 'chef'
    AND team = current_lab_team()
    AND is_extra = true
  );
