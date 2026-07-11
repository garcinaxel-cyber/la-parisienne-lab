-- lab_v17 — Complementary info for birthday cakes.
-- The birthday-cakes tab READS existing sales-order lines (already imported from Odoo),
-- isolates the "Birthday cake" category, and lets assistants add info Odoo can't hold.
-- This table NEVER duplicates an order — it only attaches extra fields to an order line.
--   message      : text piped on the cake (chữ trên bánh)
--   ready_time   : internal "ready by" time for the chefs (distinct from the delivery time)
--   delivered_by : which shop delivers — Lab | La Parisienne | Moon Flower | Paris

CREATE TABLE IF NOT EXISTS lab_birthday_details (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_line_id uuid NOT NULL UNIQUE REFERENCES lab_order_lines(id) ON DELETE CASCADE,
  message       text,
  ready_time    text,
  delivered_by  text,
  updated_by    uuid,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE lab_birthday_details ENABLE ROW LEVEL SECURITY;

-- Managers (admin / lab_manager / assistant) — fill and edit
DROP POLICY IF EXISTS "lab_birthday_manager" ON lab_birthday_details;
CREATE POLICY "lab_birthday_manager" ON lab_birthday_details FOR ALL TO authenticated
  USING (current_role_of() IN ('admin','lab_manager','assistant'))
  WITH CHECK (current_role_of() IN ('admin','lab_manager','assistant'));

-- Chefs — read only, and only for order lines of their own team (to show the message on their card)
DROP POLICY IF EXISTS "lab_birthday_chef_select" ON lab_birthday_details;
CREATE POLICY "lab_birthday_chef_select" ON lab_birthday_details FOR SELECT TO authenticated
  USING (current_role_of() = 'chef' AND EXISTS (
    SELECT 1 FROM lab_order_lines ol WHERE ol.id = order_line_id AND ol.team = current_lab_team()));
