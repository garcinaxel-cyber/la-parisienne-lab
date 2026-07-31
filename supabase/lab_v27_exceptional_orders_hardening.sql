-- v27 — Exceptional-order process hardening (audit 2026-07-31): required fields per
-- delivery mode, design reference (notes + photo), cancel-after-Odoo, submission dedupe.
-- No behaviour change for existing rows — every column is additive/nullable.

-- ── Design reference (scenario 3: custom design request) ──
-- Distinct from `message` (text piped ON the cake) — this is instructions/photo for how
-- the cake should LOOK, shown to the chef alongside the order.
ALTER TABLE lab_manual_cakes ADD COLUMN IF NOT EXISTS design_notes text;
ALTER TABLE lab_manual_cakes ADD COLUMN IF NOT EXISTS design_photo_url text;
ALTER TABLE lab_birthday_details ADD COLUMN IF NOT EXISTS design_notes text;
ALTER TABLE lab_birthday_details ADD COLUMN IF NOT EXISTS design_photo_url text;

-- ── Cancel-after-Odoo audit trail (scenario 5/6) ──
-- cancelled_at set = the manual cake (and its Odoo line) is cancelled. The row and its
-- production card are KEPT (struck through), never deleted, so history/audit survives.
ALTER TABLE lab_manual_cakes ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;
ALTER TABLE lab_manual_cakes ADD COLUMN IF NOT EXISTS cancelled_by uuid;
ALTER TABLE lab_manual_cakes ADD COLUMN IF NOT EXISTS cancelled_by_name text;
ALTER TABLE lab_manual_cakes ADD COLUMN IF NOT EXISTS cancel_reason text;

-- ── Submission dedupe (double-tap protection on the public shop form) ──
-- One row per client-generated key (created once per "compose" session in the browser).
-- submitShopOrderAction inserts here FIRST; a conflict means this exact submission was
-- already processed, so the action returns success without creating duplicate rows.
CREATE TABLE IF NOT EXISTS lab_shop_submission_dedupe (
  client_submission_key uuid PRIMARY KEY,
  created_at             timestamptz NOT NULL DEFAULT now()
);
-- No RLS: only ever touched by server actions using the service-role key.

-- ── Storage bucket for cake design reference photos ──
-- Public read (URLs are stored/rendered directly, same trust level as product images);
-- writes only ever happen server-side via the service-role key (upload action validates
-- the shop token + file type/size before writing), so no public insert policy is needed.
INSERT INTO storage.buckets (id, name, public)
VALUES ('lab-design-photos', 'lab-design-photos', true)
ON CONFLICT (id) DO NOTHING;

-- Housekeeping: drop dedupe rows older than 24h so the table doesn't grow forever
-- (run manually or wire into the existing hourly cron later; not urgent at this volume).
