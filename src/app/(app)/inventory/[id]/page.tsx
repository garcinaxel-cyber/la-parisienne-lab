import { notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase-server';
import InventorySessionView from './InventorySessionView';

export const dynamic = 'force-dynamic';

// The 3 long-storage categories, exact labels as used in lab_fiche_meta.category
// (confirmed live: 35 Macaron / 29 Biscuit Voyage / 11 Tiramisu fiches, 2026-08).
// Everything else stays out of the default view — accessible via the search-based
// "autre produit" add instead, since it's normally fresh/short-lived stock.
const DEFAULT_CATEGORIES = ['Macaron', 'Biscuit Voyage', 'Tiramisu'];

export default async function InventorySessionPage({ params }: { params: { id: string } }) {
  const supabase = createClient();

  const { data: session } = await supabase.from('lab_inventory_sessions')
    .select('id, inventory_date, status, odoo_push_status, odoo_push_error')
    .eq('id', params.id).maybeSingle();
  if (!session) notFound();

  const { data: fiches } = await supabase.from('lab_fiche_meta')
    .select('id, name_vi, name_en, category')
    .in('category', DEFAULT_CATEGORIES)
    .eq('is_active', true)
    .order('category').order('name_vi');

  const ficheIds = (fiches ?? []).map(f => f.id);
  const { data: variants } = ficheIds.length
    ? await supabase.from('lab_fiche_variants')
        .select('id, fiche_id, sku, label')
        .in('fiche_id', ficheIds)
        .order('is_default', { ascending: false }).order('sort_order')
    : { data: [] as any[] };

  const { data: lines } = await supabase.from('lab_inventory_lines')
    .select('id, sku, product_name_vi, product_name_en, category, qty_counted, qty_system, odoo_push_status, odoo_push_error')
    .eq('session_id', params.id);

  const products = (fiches ?? []).flatMap(f =>
    (variants ?? []).filter(v => v.fiche_id === f.id && v.sku).map(v => ({
      sku: v.sku as string,
      product_name_vi: f.name_vi as string,
      product_name_en: f.name_en as string | null,
      category: f.category as string,
      variant_label: v.label as string | null,
      fiche_id: f.id as string,
      variant_id: v.id as string,
    }))
  );

  return (
    <InventorySessionView
      session={session}
      products={products}
      initialLines={lines ?? []}
      categories={DEFAULT_CATEGORIES}
    />
  );
}
