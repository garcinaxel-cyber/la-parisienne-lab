-- lab_v99: one-time import of the website's product photos into the lab app's own storage.
-- Axel, 2026-10-07: "je veux pas que ca puise en continue dans la website app. je veux juste
-- que tu les importes". The list is frozen at the moment he validated it; the admin page
-- /admin/photo-import copies each file from bucket product-images to bucket lab-images, and
-- lab_photo_import_apply() then switches the recipe card's photo to the copy. Variant photos
-- (lab_fiche_variants.image_url) are deliberately left alone.
--
-- Applied on 2026-10-07. The 305 rows of the list were inserted the same day by a one-off
-- statement (recipe card -> website product through b2c_product_id, else variant SKU, plus 13
-- matches by name Axel confirmed: Camillie, Rosalie, Set Fur Elise, Set Jardin de Baies, Set
-- Fatcaron). That statement is not replayed here: the list must stay what he validated.
create table if not exists public.lab_photo_import (
  id uuid primary key default gen_random_uuid(),
  fiche_id uuid not null unique references public.lab_fiche_meta(id),
  grp text not null,
  name_vi text,
  sku text,
  old_url text,
  src_path text not null,
  dest_path text not null unique,
  new_url text not null,
  status text not null default 'pending' check (status in ('pending','copied','applied','skipped','error')),
  error text,
  copied_at timestamptz,
  applied_at timestamptz,
  created_at timestamptz not null default now()
);
comment on table public.lab_photo_import is 'One-time import of website product photos into lab-images (2026-10). old_url = recipe card photo before the import, kept for rollback.';
alter table public.lab_photo_import enable row level security;

-- Switches the recipe card photo for every row whose copy really exists in storage, and only if
-- the card still shows the photo it had when the list was validated (a photo uploaded in the
-- meantime is never overwritten: the row is marked skipped).
create or replace function public.lab_photo_import_apply()
returns table (applied integer, skipped integer)
language plpgsql
set search_path = public
as $$
declare
  r record;
  n_applied integer := 0;
  n_skipped integer := 0;
  n_rows integer;
begin
  for r in
    select i.id, i.fiche_id, i.old_url, i.new_url
    from public.lab_photo_import i
    where i.status = 'copied'
      and exists (select 1 from storage.objects o where o.bucket_id = 'lab-images' and o.name = i.dest_path)
    order by i.created_at, i.id
    for update of i
  loop
    update public.lab_fiche_meta set image_url = r.new_url
      where id = r.fiche_id and image_url is not distinct from r.old_url;
    get diagnostics n_rows = row_count;
    if n_rows = 1 then
      update public.lab_photo_import set status = 'applied', applied_at = now(), error = null where id = r.id;
      n_applied := n_applied + 1;
    else
      update public.lab_photo_import set status = 'skipped', error = 'recipe card photo changed since the list was validated' where id = r.id;
      n_skipped := n_skipped + 1;
    end if;
  end loop;
  return query select n_applied, n_skipped;
end;
$$;
revoke all on function public.lab_photo_import_apply() from public, anon, authenticated;
grant execute on function public.lab_photo_import_apply() to service_role;
