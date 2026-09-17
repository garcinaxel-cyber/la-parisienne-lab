-- Adds an optional, shop-editable follow-up note to shop loss declarations.
-- Purely additive, app-only field: no impact on Odoo sync or existing logic.
-- The shop can add/edit this note at any time after the loss has been
-- reported/confirmed. Visible to assistants in the lab reception view.

alter table lab_shop_losses
  add column if not exists follow_up_note text,
  add column if not exists follow_up_note_by_name text,
  add column if not exists follow_up_note_at timestamptz;
