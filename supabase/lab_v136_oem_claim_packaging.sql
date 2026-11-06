-- OEM push queue (2026-11-06): claim the oldest queued 'packed' entry atomically (one row, locked,
-- set to 'running' in the same statement). Used by /api/oem/push-queue instead of select-then-update.
create or replace function public.lab_mm_claim_packaging()
returns table(id uuid, sku text, qty numeric, pack_date date, odoo_mo_id bigint)
language sql security definer set search_path = public as $$
  update lab_mm_packaging_log p set odoo_status = 'running'
   where p.id = (select q.id from lab_mm_packaging_log q
                  where q.kind = 'packed' and q.odoo_status = 'queued'
                  order by q.pack_date, q.created_at limit 1 for update skip locked)
     and p.odoo_status = 'queued'
  returning p.id, p.sku, p.qty, p.pack_date, p.odoo_mo_id;
$$;
revoke all on function public.lab_mm_claim_packaging() from public, anon, authenticated;
grant execute on function public.lab_mm_claim_packaging() to service_role;
