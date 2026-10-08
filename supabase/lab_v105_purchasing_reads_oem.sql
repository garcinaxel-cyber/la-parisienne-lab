-- Purchasing role can SEE the OEM orders screen (Axel, 2026-10-08: "ce nouveau rôle achat doit pouvoir
-- voir commande OEM"). Read-only: extra SELECT policies only, existing policies untouched.
do $$
declare t text;
begin
  foreach t in array array['lab_mm_delivery_plan','lab_mm_fg_counts','lab_mm_ingredient_usage','lab_mm_ingredients',
    'lab_mm_initial_inventory','lab_mm_order_item_history','lab_mm_order_items','lab_mm_packaging_log',
    'lab_mm_production_audit','lab_mm_production_log','lab_mm_rm_inventory','lab_mm_settings']
  loop
    if not exists (select 1 from pg_policies where schemaname='public' and tablename=t and policyname=t||'_read_purchasing') then
      execute format('create policy %I on public.%I for select using (current_role_of() = %L::user_role)', t||'_read_purchasing', t, 'purchasing');
    end if;
  end loop;
end $$;
