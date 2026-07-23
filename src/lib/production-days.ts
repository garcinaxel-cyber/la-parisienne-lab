import type { SupabaseClient } from '@supabase/supabase-js';
import { labDayUtcRange } from '@/lib/odoo';

// Production is grouped by the day it was PHYSICALLY made (produced_at), not the delivery day.
// So an item produced ahead today (for a later delivery) still counts on today's export/MO —
// "un produit produit aujourd'hui est sur l'export d'aujourd'hui".

const COLS =
  'id, variant_id, product_name_vi, product_name_en, variant_label, team, total_qty, qty_produced, ' +
  'cancelled, is_extra, produced_ahead, produced_by_name, produced_at, image_url, import_id, ' +
  'lab_imports!inner(delivery_date, status, order_number, type)';

export type DoneCard = {
  id: string; variant_id: string | null; product_name_vi: string; product_name_en: string | null;
  variant_label: string | null; team: string | null; total_qty: number; qty_produced: number;
  cancelled: boolean; is_extra: boolean; produced_ahead: boolean; produced_by_name: string | null;
  produced_at: string | null; image_url: string | null; import_id: string; lab_imports: any;
};

/** All "done" cards physically produced on the given lab-day (published imports, all teams,
 *  incl. extra). Matches by produced_at window; legacy cards with no produced_at fall back to
 *  their delivery date so nothing is lost. */
export async function fetchDoneForProdDate(supabase: SupabaseClient, date: string): Promise<DoneCard[]> {
  const { start, end } = labDayUtcRange(date);
  const [byProd, byNull] = await Promise.all([
    supabase.from('lab_assignments').select(COLS)
      .eq('lab_imports.status', 'published').eq('status', 'done')
      .gte('produced_at', start).lt('produced_at', end).limit(5000),
    supabase.from('lab_assignments').select(COLS)
      .eq('lab_imports.status', 'published').eq('status', 'done')
      .is('produced_at', null).eq('lab_imports.delivery_date', date).limit(5000),
  ]);
  const seen = new Set<string>();
  const out: DoneCard[] = [];
  for (const a of [...(byProd.data ?? []), ...(byNull.data ?? [])] as any[]) {
    if (a.cancelled || seen.has(a.id)) continue;
    seen.add(a.id);
    out.push(a);
  }
  return out;
}

/** Aggregate done cards to one row per SKU with the produced quantity (fallback name for
 *  cards without a SKU). skuByVariant maps variant_id → SKU. */
export function aggregateBySku(cards: DoneCard[], skuByVariant: Record<string, string>) {
  const agg = new Map<string, { sku: string | null; appName: string; qty: number }>();
  for (const a of cards) {
    const sku = a.variant_id ? skuByVariant[a.variant_id] ?? null : null;
    const key = sku ?? `__noSku__${a.product_name_vi}`;
    const qty = (a.qty_produced && a.qty_produced > 0) ? a.qty_produced : (a.total_qty ?? 0);
    const cur = agg.get(key);
    if (cur) cur.qty += qty;
    else agg.set(key, { sku, appName: a.product_name_vi ?? '', qty });
  }
  return agg;
}
