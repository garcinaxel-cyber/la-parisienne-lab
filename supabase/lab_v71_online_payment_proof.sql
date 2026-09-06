-- v71 — Online-sales (Axel review 2026-09-06): optional payment screenshot per order.
-- Image is compressed client-side (~1200px JPEG) before upload, stored in the existing
-- lab-design-photos bucket under payments/, shown only as an on-demand thumbnail.
ALTER TABLE public.lab_online_orders ADD COLUMN IF NOT EXISTS payment_proof_url text;
