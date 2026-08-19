-- v44 — Shop-facing portal: one token per shop (no login — each shop has 5-6 staff, an
-- individual account per person would be unmanageable). Confirmation of what a shop
-- received is stored SEPARATELY from the assistants' own qty_checked (lab_delivery_check_lines)
-- so neither workflow can clobber the other — per Axel's explicit choice, 2026-08-19.
--
-- Applied live via Supabase MCP on 2026-08-19; this file mirrors that migration for repo history.

CREATE TABLE IF NOT EXISTS lab_shop_portal_links (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_name       text NOT NULL UNIQUE,
  token           text NOT NULL UNIQUE,
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid,
  created_by_name text,
  regenerated_at  timestamptz
);

ALTER TABLE lab_shop_portal_links ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "lab_shop_portal_links_manager" ON lab_shop_portal_links;
CREATE POLICY "lab_shop_portal_links_manager" ON lab_shop_portal_links FOR ALL TO authenticated
  USING (current_role_of() IN ('admin','lab_manager','assistant'))
  WITH CHECK (current_role_of() IN ('admin','lab_manager','assistant'));
-- No anon policy: the public portal (/boutique/[token]) reads/writes via the service-role
-- key server-side, same pattern as lab_shop_link / /order/[token] (lab_v23).

CREATE TABLE IF NOT EXISTS lab_shop_receipt_lines (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  check_line_id      uuid NOT NULL REFERENCES lab_delivery_check_lines(id) ON DELETE CASCADE,
  delivery_order_id  uuid NOT NULL REFERENCES lab_delivery_orders(id) ON DELETE CASCADE,
  shop_name          text NOT NULL,
  qty_received       numeric,
  status             text NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','issue')),
  note               text,
  confirmed_by_name  text NOT NULL,
  confirmed_at       timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE(check_line_id)
);

CREATE INDEX IF NOT EXISTS idx_lab_shop_receipt_lines_order ON lab_shop_receipt_lines(delivery_order_id);

ALTER TABLE lab_shop_receipt_lines ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "lab_shop_receipt_lines_manager" ON lab_shop_receipt_lines;
CREATE POLICY "lab_shop_receipt_lines_manager" ON lab_shop_receipt_lines FOR ALL TO authenticated
  USING (current_role_of() IN ('admin','lab_manager','assistant'))
  WITH CHECK (current_role_of() IN ('admin','lab_manager','assistant'));
-- No anon policy here either — the public portal writes confirmations via the service-role key.
