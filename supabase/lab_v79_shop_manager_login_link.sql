-- Links an existing lab_shop_managers row (name/PIN/shops, used for the shared-shop-login PIN
-- unlock) to a real, individual Supabase Auth account (role='shop_manager') so that same
-- manager can also log in on their own instead of sharing a shop's password. Nullable — a
-- manager can keep existing as PIN-only (shared login unlock) without ever getting their own
-- account. One login maps to at most one manager row (partial unique index, NULLs excluded).
alter table public.lab_shop_managers add column if not exists user_id uuid references auth.users(id);

create unique index if not exists lab_shop_managers_user_id_key
  on public.lab_shop_managers (user_id)
  where user_id is not null;
