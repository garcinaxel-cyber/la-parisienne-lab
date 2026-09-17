'use server';
// Consommation matières premières (2026-09-17, Axel) — par SKU de MP sur une période, groupé par
// équipe si besoin, avec la répartition par produit fini derrière chaque matière première.
// Mode "théorique" (nomenclature Odoo x quantité produite côté lab-app), voir la discussion
// menée avec Axel avant ce chantier :
//   - Ne dépend PAS de l'historique de fiabilité du "done" auto des MO (pas de lecture de
//     mrp.production ici) — juste la nomenclature actuelle + lab_daily_stats, table légère déjà
//     utilisée par /analytics.
//   - Calcul déclenché uniquement à la demande (bouton "Calculer" côté vue, pas au chargement de
//     la page) — même posture que refreshStockLiveAction dans analytics/actions.ts.
//   - Admin uniquement (pas lab_manager), sur demande explicite d'Axel.
import { createClient, getSafeSession } from '@/lib/supabase-server';
import { resolveRawMaterialsBatch } from '@/lib/mp-consumption';

export type MPBreakdownRow = { sku: string; name: string; team: string; qtyProduced: number; contributed: number };
export type MPRow = { code: string; name: string; uom: string; total: number; breakdown: MPBreakdownRow[] };
export type MPUnresolved = { sku: string; name: string; qtyProduced: number };
export type MPReport = { rows: MPRow[]; unresolved: MPUnresolved[] };

async function guard() {
  const supabase = createClient();
  const { data: { session } } = await getSafeSession(supabase);
  if (!session) return { ok: false as const };
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
  if (profile?.role !== 'admin') return { ok: false as const };
  return { ok: true as const, supabase };
}

export async function getMpConsumptionReportAction(
  from: string, to: string, team: string,
): Promise<{ data?: MPReport; error?: string }> {
  const g = await guard();
  if (!g.ok) return { error: 'Admin only' };
  const { supabase } = g;

  let query = supabase.from('lab_daily_stats').select('sku, product_name, team, qty_produced')
    .gte('day', from).lte('day', to).gt('qty_produced', 0);
  if (team && team !== 'all') query = query.eq('team', team);
  const { data: stats, error } = await query;
  if (error) return { error: error.message };

  // Agrégat par (sku, team) — nécessaire pour pouvoir montrer la répartition par équipe dans le
  // détail de chaque matière première quand "toutes équipes" est sélectionné.
  type ProdAgg = { sku: string; team: string; name: string; qty: number };
  const bySkuTeam = new Map<string, ProdAgg>();
  for (const r of stats ?? []) {
    if (!r.sku || !r.team) continue;
    const key = `${r.sku}::${r.team}`;
    const a = bySkuTeam.get(key) ?? { sku: r.sku, team: r.team, name: r.product_name || r.sku, qty: 0 };
    a.qty += r.qty_produced ?? 0;
    if (r.product_name) a.name = r.product_name;
    bySkuTeam.set(key, a);
  }
  const prodAggs = Array.from(bySkuTeam.values()).filter(a => a.qty > 0);
  if (prodAggs.length === 0) return { data: { rows: [], unresolved: [] } };

  const distinctSkus = Array.from(new Set(prodAggs.map(a => a.sku)));
  const { bySku: bomBySku } = await resolveRawMaterialsBatch(distinctSkus);

  const rawAcc = new Map<string, { name: string; uom: string; total: number; breakdown: MPBreakdownRow[] }>();
  const unresolvedBySku = new Map<string, MPUnresolved>();

  for (const agg of prodAggs) {
    const lines = bomBySku.get(agg.sku);
    if (!lines || lines.length === 0) {
      const u = unresolvedBySku.get(agg.sku) ?? { sku: agg.sku, name: agg.name, qtyProduced: 0 };
      u.qtyProduced += agg.qty;
      unresolvedBySku.set(agg.sku, u);
      continue;
    }
    for (const line of lines) {
      const acc = rawAcc.get(line.code) ?? { name: line.name, uom: line.uom, total: 0, breakdown: [] };
      const contributed = line.qtyPerUnit * agg.qty;
      acc.total += contributed;
      acc.breakdown.push({ sku: agg.sku, name: agg.name, team: agg.team, qtyProduced: agg.qty, contributed });
      rawAcc.set(line.code, acc);
    }
  }

  const rows: MPRow[] = Array.from(rawAcc.entries())
    .map(([code, v]) => ({
      code, name: v.name, uom: v.uom, total: v.total,
      breakdown: v.breakdown.sort((a, b) => b.contributed - a.contributed),
    }))
    .sort((a, b) => a.code.localeCompare(b.code)); // ordre croissant par SKU de MP (demande Axel)

  const unresolved = Array.from(unresolvedBySku.values()).sort((a, b) => b.qtyProduced - a.qtyProduced);

  return { data: { rows, unresolved } };
}
