-- OEM settings (Odoo switch) and order quantities: admin only (Axel, 2026-09-25). Applied.
drop policy if exists lab_mm_settings_manage on lab_mm_settings;
create policy lab_mm_settings_manage on lab_mm_settings for all
  using (current_role_of() = 'admin'::user_role) with check (current_role_of() = 'admin'::user_role);
drop policy if exists lab_mm_order_items_manage on lab_mm_order_items;
create policy lab_mm_order_items_manage on lab_mm_order_items for all
  using (current_role_of() = 'admin'::user_role) with check (current_role_of() = 'admin'::user_role);
drop policy if exists lab_mm_order_item_history_manage on lab_mm_order_item_history;
create policy lab_mm_order_item_history_manage on lab_mm_order_item_history for all
  using (current_role_of() = 'admin'::user_role) with check (current_role_of() = 'admin'::user_role);
