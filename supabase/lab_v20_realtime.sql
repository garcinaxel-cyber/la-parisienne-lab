-- lab_v20 — Enable Supabase Realtime for the production tables so the chef Station and the
-- assistant Orders views refresh the instant data changes (no manual reload, no polling).
-- These tables were NOT in the supabase_realtime publication, so the pre-existing station
-- channel never actually fired. Adding them makes postgres_changes deliver (RLS still applies:
-- a client only receives changes to rows it is allowed to SELECT).

ALTER PUBLICATION supabase_realtime ADD TABLE
  lab_assignments,
  lab_order_lines,
  lab_imports,
  lab_birthday_details;
