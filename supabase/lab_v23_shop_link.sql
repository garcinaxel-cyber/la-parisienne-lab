-- v23 — Universal shop order link (phase 2 of exceptional orders).
-- ONE tokenised URL shared by all shops: /commande/<token>. The token is the access key;
-- the shop identifies itself with a selector in the form. Managers can regenerate the
-- token from the app (old link dies instantly). The public form NEVER touches these
-- tables directly: server actions use the service-role key, so no anon policies needed.

CREATE TABLE IF NOT EXISTS lab_shop_link (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token          text UNIQUE NOT NULL,
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  regenerated_at timestamptz
);

ALTER TABLE lab_shop_link ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "lab_shop_link_manager" ON lab_shop_link;
CREATE POLICY "lab_shop_link_manager" ON lab_shop_link FOR ALL TO authenticated
  USING (current_role_of() IN ('admin','lab_manager','assistant'))
  WITH CHECK (current_role_of() IN ('admin','lab_manager','assistant'));

-- Seed one link if none exists (32 hex chars, unguessable)
INSERT INTO lab_shop_link (token)
SELECT replace(gen_random_uuid()::text, '-', '')
WHERE NOT EXISTS (SELECT 1 FROM lab_shop_link);

-- Realtime for the exceptional-orders page: lab_manual_cakes was never added to the
-- publication, so the page's subscription silently received nothing. Shop submissions
-- must appear live on the assistants' screens.
ALTER PUBLICATION supabase_realtime ADD TABLE lab_manual_cakes;
