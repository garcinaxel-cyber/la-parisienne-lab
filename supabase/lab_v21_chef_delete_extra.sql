-- v21 — Chefs may DELETE an EXTRA production card of their OWN team,
-- as long as it has NOT been sent to stock (transferred = false).
-- Fixes: a wrong product picked in "extra production" was frozen forever.
-- Order cards (is_extra = false) stay undeletable by chefs — they come from imports.

DROP POLICY IF EXISTS "lab_assignments_chef_delete_extra" ON lab_assignments;
CREATE POLICY "lab_assignments_chef_delete_extra" ON lab_assignments FOR DELETE TO authenticated
  USING (
    current_role_of() = 'chef'
    AND team = current_lab_team()
    AND is_extra = true
    AND transferred = false
  );
