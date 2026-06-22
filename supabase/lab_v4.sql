-- lab_v4.sql
-- Add is_extra column to track chef-added production outside the original order

ALTER TABLE lab_assignments
  ADD COLUMN IF NOT EXISTS is_extra BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS lab_assignments_is_extra_idx
  ON lab_assignments (is_extra)
  WHERE is_extra = TRUE;
