-- v123 — OEM carton labels + delivery notes (Axel, 2026-10-14). One row per printed delivery note
-- (phiếu giao hàng) and one row per carton (tem thùng) with an automatic serial. Rules: production
-- date = delivery − 2 days, packing date = delivery − 1 day, best-before = delivery + 120 days
-- (both clients). Additive only; written by server actions with the service key (no write policy).
CREATE TABLE IF NOT EXISTS lab_mm_delivery_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  note_no text NOT NULL UNIQUE,
  client_name text NOT NULL,
  order_ref text NOT NULL,
  delivery_date date NOT NULL,
  pack_date date NOT NULL,
  best_before date NOT NULL,
  status text NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'signed', 'void')),
  override_by_name text, override_note text,           -- manager OK when a production date is older than the rule
  signed_photo_url text, signed_at timestamptz, signed_by_name text,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid, created_by_name text
);
CREATE INDEX IF NOT EXISTS lab_mm_delivery_notes_order ON lab_mm_delivery_notes (order_ref, delivery_date);
CREATE TABLE IF NOT EXISTS lab_mm_cartons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  note_id uuid NOT NULL REFERENCES lab_mm_delivery_notes(id) ON DELETE CASCADE,
  serial text NOT NULL UNIQUE,
  line_no int NOT NULL,
  sku text NOT NULL, group_key text NOT NULL,
  lot_no text NOT NULL, prod_date date NOT NULL,
  bags int NOT NULL, bag_kg numeric NOT NULL, net_kg numeric NOT NULL
);
CREATE INDEX IF NOT EXISTS lab_mm_cartons_note ON lab_mm_cartons (note_id);
-- last carton format used per client + product (bags per carton × kg per bag)
CREATE TABLE IF NOT EXISTS lab_mm_carton_formats (
  client_name text NOT NULL, sku text NOT NULL, bags_per_carton int NOT NULL, bag_kg numeric NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (client_name, sku)
);
-- gap-free counters for serials / note numbers (one row per prefix)
CREATE TABLE IF NOT EXISTS lab_mm_counters (prefix text PRIMARY KEY, last int NOT NULL);
CREATE OR REPLACE FUNCTION lab_mm_take_numbers(p_prefix text, p_n int) RETURNS int
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO lab_mm_counters (prefix, last) VALUES (p_prefix, p_n)
  ON CONFLICT (prefix) DO UPDATE SET last = lab_mm_counters.last + p_n
  RETURNING last - p_n + 1;
$$;
REVOKE ALL ON FUNCTION lab_mm_take_numbers(text, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION lab_mm_take_numbers(text, int) TO service_role;

ALTER TABLE lab_mm_delivery_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE lab_mm_cartons ENABLE ROW LEVEL SECURITY;
ALTER TABLE lab_mm_carton_formats ENABLE ROW LEVEL SECURITY;
ALTER TABLE lab_mm_counters ENABLE ROW LEVEL SECURITY;
CREATE POLICY lab_mm_delivery_notes_read ON lab_mm_delivery_notes FOR SELECT USING (current_role_of() = ANY (ARRAY['admin','lab_manager','assistant','purchasing']::user_role[]));
CREATE POLICY lab_mm_cartons_read ON lab_mm_cartons FOR SELECT USING (current_role_of() = ANY (ARRAY['admin','lab_manager','assistant','purchasing']::user_role[]));
CREATE POLICY lab_mm_carton_formats_read ON lab_mm_carton_formats FOR SELECT USING (current_role_of() = ANY (ARRAY['admin','lab_manager','assistant','purchasing']::user_role[]));

-- client details printed on the delivery note (lab_mm_settings, JSON)
INSERT INTO lab_mm_settings (key, value) VALUES
 ('client_info:CÔNG TY CỔ PHẦN TIANHE FOOD', '{"code":"TH","legal":"CÔNG TY CỔ PHẦN TIANHE FOOD","addr":"Số 215 đường Hồ Tùng Mậu, phường Từ Liêm, thành phố Hà Nội, Việt Nam","tax":"0111033120","phone":"091 246 95 68","ship":"Số 258 đường Nghi Tàm, phường Hồng Hà, Hà Nội","contact":"Ms Hằng · 0968 372 885","shelf_days":120}'),
 ('client_info:Maison Mooncake', '{"code":"MM","legal":"CÔNG TY CỔ PHẦN THỰC PHẨM W&E (Maison Mooncake)","addr":"Tầng 9, tòa nhà Toyota Thanh Xuân, số 315 đường Trường Chinh, Phường Phương Liệt, Thành phố Hà Nội, Việt Nam","tax":"","phone":"","ship":"","contact":"","shelf_days":120}')
ON CONFLICT (key) DO NOTHING;
