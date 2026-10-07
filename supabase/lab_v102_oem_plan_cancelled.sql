-- OEM tracker (Axel, 2026-10-07): a client can cancel one of its separate orders (Tianhe Food
-- cancelled the 710 kg order; only the 1 t order remains). The row is kept for the record and
-- flagged; the app ignores cancelled rows in every calculation and shows them as "cancelled". Applied.
alter table lab_mm_delivery_plan add column if not exists cancelled_at timestamptz;
alter table lab_mm_delivery_plan add column if not exists cancelled_note text;
-- Data, same day: Tianhe order 1 (340 / 160 / 210 kg) flagged cancelled; order 2 (1 t) = 100 % ;
-- lab_mm_order_items back to 333.33 / 333.33 / 333.34 kg; the Tomyum batches declared for order 1
-- (261.2 kg, 02/10 -> 07/10) now count for order 2.
