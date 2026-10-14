-- v124 — who prepared the cartons (typed full name; app names are nicknames), printed on labels + delivery note (Axel, 2026-10-14). Additive.
ALTER TABLE lab_mm_delivery_notes ADD COLUMN IF NOT EXISTS prepared_by text;
