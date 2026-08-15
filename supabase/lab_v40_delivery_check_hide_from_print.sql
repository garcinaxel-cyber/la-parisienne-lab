-- 2026-08-14 (applied live via Supabase MCP).
-- Assistants can hide a line from the printed delivery slip without deleting its check data —
-- e.g. a wrong item checked to 0 after an assistant's SKU mistake, where the correct item was
-- re-added on Odoo separately; the ×0 line shouldn't confuse the client on the printed document
-- even though it must stay tracked internally.
alter table lab_delivery_check_lines
  add column if not exists hidden_from_print boolean not null default false;
