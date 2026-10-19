import type { SupabaseClient } from '@supabase/supabase-js';

// Production vs delivery, per SKU, for one delivery date (Axel, 2026-10-19: "la nouvelle colonne
// dans la delivery check pour voir ce qui a été produit vs livré"). READ-ONLY, display only —
// never blocks a check or a validation. Figures are for the WHOLE delivery date (all orders of
// the day), because production cards are per product per day, not per order.
//
// - planned  = qty to produce on the day's cards (excluding cancelled / served-from-stock / blocked)
// - produced = qty marked produced on those cards
// - sent     = qty the chefs sent to stock ("chuyển kho") — this is what creates the Odoo MO
// - stock    = qty the chefs marked "Có sẵn" (served from stock, card status 'skip')
// - ordered / checked = sum over every production check line of that SKU on that date
export interface ProdStatus {
  cards: number;
  planned: number;
  produced: number;
  sent: number;
  stock: number;
  blocked: number;
  teams: string[];
  ordered: number;
  checked: number;
}

export async function fetchProductionStatusBySku(
  supabase: SupabaseClient, date: string, skus: string[],
): Promise<Record<string, ProdStatus>> {
  const out: Record<string, ProdStatus> = {};
  const uniq = Array.from(new Set(skus.filter(Boolean)));
  if (!date || !uniq.length) return out;
  try {
    const blank = (): ProdStatus => ({ cards: 0, planned: 0, produced: 0, sent: 0, stock: 0, blocked: 0, teams: [], ordered: 0, checked: 0 });
    for (const s of uniq) out[s] = blank();

    const [{ data: variants }, { data: imports }, { data: dayLines }] = await Promise.all([
      supabase.from('lab_fiche_variants').select('id, sku').in('sku', uniq),
      supabase.from('lab_imports').select('id').eq('delivery_date', date),
      supabase.from('lab_delivery_check_lines').select('sku, qty_expected, qty_checked')
        .eq('delivery_date', date).eq('category', 'production').in('sku', uniq),
    ]);

    for (const l of dayLines ?? []) {
      const s = out[l.sku as string]; if (!s) continue;
      s.ordered += Number(l.qty_expected) || 0;
      if (l.qty_checked != null) s.checked += Number(l.qty_checked) || 0;
    }

    const skuByVariant: Record<string, string> = {};
    for (const v of variants ?? []) if (v.sku) skuByVariant[v.id] = v.sku;
    const vids = Object.keys(skuByVariant);
    const importIds = (imports ?? []).map((i: any) => i.id);
    if (!vids.length || !importIds.length) return out;

    const { data: cards } = await supabase.from('lab_assignments')
      .select('variant_id, team, status, cancelled, total_qty, qty_to_produce, qty_produced, qty_sent_total')
      .in('import_id', importIds).in('variant_id', vids);
    for (const c of cards ?? []) {
      if (c.cancelled) continue;
      const s = out[skuByVariant[c.variant_id as string]]; if (!s) continue;
      const qty = Number(c.qty_to_produce ?? c.total_qty) || 0;
      s.cards += 1;
      if (c.team && !s.teams.includes(c.team)) s.teams.push(c.team);
      if (c.status === 'skip') { s.stock += qty; continue; }
      if (c.status === 'blocked') { s.blocked += qty; continue; }
      s.planned += qty;
      s.produced += Number(c.qty_produced) || 0;
      s.sent += Number(c.qty_sent_total) || 0;
    }
  } catch {
    return {}; // display-only: any failure just hides the column content, never the page
  }
  return out;
}
