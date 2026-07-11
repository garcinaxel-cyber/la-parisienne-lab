-- lab_v16 — Stock transfer notes (bon de transfert) between production and stock.
-- Chef produces (done) → creates a transfer note listing finished products + qty sent.
-- Assistant confirms reception: qty received per line, discrepancy reason if received <> sent.
-- Reception feeds nothing yet (Odoo stock link comes later) — it is a traced hand-off.

CREATE TABLE IF NOT EXISTS lab_stock_transfers (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team             text NOT NULL,
  created_by       uuid,
  created_by_name  text,
  status           text NOT NULL DEFAULT 'pending',  -- pending | received
  note             text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  received_by      uuid,
  received_by_name text,
  received_at      timestamptz
);
CREATE INDEX IF NOT EXISTS lab_stock_transfers_status_idx ON lab_stock_transfers(status);
CREATE INDEX IF NOT EXISTS lab_stock_transfers_team_idx   ON lab_stock_transfers(team);

CREATE TABLE IF NOT EXISTS lab_stock_transfer_lines (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_id        uuid NOT NULL REFERENCES lab_stock_transfers(id) ON DELETE CASCADE,
  assignment_id      uuid,
  product_name_vi    text,
  product_name_en    text,
  sku                text,
  variant_label      text,
  image_url          text,
  delivery_date      date,
  qty_sent           integer NOT NULL DEFAULT 0,
  qty_received       integer,
  discrepancy_reason text,
  discrepancy_note   text
);
CREATE INDEX IF NOT EXISTS lab_stock_transfer_lines_transfer_idx ON lab_stock_transfer_lines(transfer_id);

-- Marks a produced card already handed off to stock (avoids double-sending; shows a chip)
ALTER TABLE lab_assignments ADD COLUMN IF NOT EXISTS transferred boolean NOT NULL DEFAULT false;

ALTER TABLE lab_stock_transfers      ENABLE ROW LEVEL SECURITY;
ALTER TABLE lab_stock_transfer_lines ENABLE ROW LEVEL SECURITY;

-- Managers (admin / lab_manager / assistant) — full access (they receive + review)
DROP POLICY IF EXISTS "lab_transfers_manager" ON lab_stock_transfers;
CREATE POLICY "lab_transfers_manager" ON lab_stock_transfers FOR ALL TO authenticated
  USING (current_role_of() IN ('admin','lab_manager','assistant'))
  WITH CHECK (current_role_of() IN ('admin','lab_manager','assistant'));

DROP POLICY IF EXISTS "lab_transfer_lines_manager" ON lab_stock_transfer_lines;
CREATE POLICY "lab_transfer_lines_manager" ON lab_stock_transfer_lines FOR ALL TO authenticated
  USING (current_role_of() IN ('admin','lab_manager','assistant'))
  WITH CHECK (current_role_of() IN ('admin','lab_manager','assistant'));

-- Chefs — create + read transfers for their own team only
DROP POLICY IF EXISTS "lab_transfers_chef_insert" ON lab_stock_transfers;
CREATE POLICY "lab_transfers_chef_insert" ON lab_stock_transfers FOR INSERT TO authenticated
  WITH CHECK (current_role_of() = 'chef' AND team = current_lab_team());

DROP POLICY IF EXISTS "lab_transfers_chef_select" ON lab_stock_transfers;
CREATE POLICY "lab_transfers_chef_select" ON lab_stock_transfers FOR SELECT TO authenticated
  USING (current_role_of() = 'chef' AND team = current_lab_team());

DROP POLICY IF EXISTS "lab_transfer_lines_chef_insert" ON lab_stock_transfer_lines;
CREATE POLICY "lab_transfer_lines_chef_insert" ON lab_stock_transfer_lines FOR INSERT TO authenticated
  WITH CHECK (current_role_of() = 'chef' AND EXISTS (
    SELECT 1 FROM lab_stock_transfers t WHERE t.id = transfer_id AND t.team = current_lab_team()));

DROP POLICY IF EXISTS "lab_transfer_lines_chef_select" ON lab_stock_transfer_lines;
CREATE POLICY "lab_transfer_lines_chef_select" ON lab_stock_transfer_lines FOR SELECT TO authenticated
  USING (current_role_of() = 'chef' AND EXISTS (
    SELECT 1 FROM lab_stock_transfers t WHERE t.id = transfer_id AND t.team = current_lab_team()));
