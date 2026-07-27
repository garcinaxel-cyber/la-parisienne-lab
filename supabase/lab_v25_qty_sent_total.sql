-- ================================================================
-- lab_v25_qty_sent_total.sql — 2026-07-27
-- Fix: a PARTIAL "send to stock" (chef sends less than what a card produced) marked the
-- whole card transferred=true, permanently stranding the un-sent remainder (it could never
-- be sent again — invisible in the "Send to stock" screen forever). Confirmed via a live
-- data audit that this specific stranding had NOT actually happened yet (0 cards affected
-- as of 2026-07-27), but the code allowed it, so this closes the gap pre-emptively.
--
-- qty_sent_total tracks CUMULATIVE qty actually sent to stock for a card (across possibly
-- several partial transfers). A card is only "transferred" once qty_sent_total >= qty_produced.
-- Backfilled from the real historical sums in lab_stock_transfer_lines — no card that was
-- already fully sent flips back to sendable.
-- ================================================================

ALTER TABLE lab_assignments
  ADD COLUMN IF NOT EXISTS qty_sent_total integer NOT NULL DEFAULT 0;

UPDATE lab_assignments a
SET qty_sent_total = coalesce((
  SELECT sum(l.qty_sent) FROM lab_stock_transfer_lines l WHERE l.assignment_id = a.id
), 0)
WHERE qty_sent_total = 0
  AND EXISTS (SELECT 1 FROM lab_stock_transfer_lines l WHERE l.assignment_id = a.id);

-- Done. Nullable-safe default 0, backfilled from existing transfer lines, no app code
-- depended on this column before this migration (new field, additive only).
