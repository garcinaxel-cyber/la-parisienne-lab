-- Soft-cancel of an event sale (Axel, 2026-10-08 reconciliation): source 'event_void' keeps the row
-- (audit) but takes it out of every event screen, stock and sales sum (they all filter source='event_stock').
alter table lab_online_orders drop constraint if exists lab_online_orders_source_check;
alter table lab_online_orders add constraint lab_online_orders_source_check
  check (source = any (array['lab','shop_stock','excel_import','event_stock','event_void']));
