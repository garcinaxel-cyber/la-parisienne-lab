// Traçabilité de la section Stock d'/analytics (Axel, 2026-09-02 : "avec la traçabilité
// importante : envoi de stock non fait QUI est responsable, ou bien non livraison AVEC la
// commande, ou bien si non expliqué"). Pour chaque SKU à stock ≠ 0 : l'équipe du produit
// (lab_fiche_meta.teams), le DERNIER envoi en stock (fenêtre 14 j — équipe + personne + date ;
// l'ENVOI est l'événement qui crée la MO Odoo, la réception est interne à l'app), et les
// livraisons poussées sur Odoo des 7 derniers jours (total + dernière commande + qui l'a
// validée). Uniquement de petites requêtes Supabase indexées — jamais d'appel Odoo ici.
import type { SupabaseClient } from '@supabase/supabase-js';

export interface StockTraceEntry {
  team: string | null;
  lastSend: { date: string; team: string | null; by: string | null; qty: number } | null;
  sent7: { qty: number; count: number } | null; // total envoyé en stock sur 7 j (bilan entrées)
  deliv7: { qty: number; count: number; lastRef: string | null; lastDate: string | null; lastBy: string | null } | null;
}
export type StockTrace = Record<string, StockTraceEntry>;

export async function collectStockTrace(supabase: SupabaseClient, skus: string[]): Promise<StockTrace> {
  const trace: StockTrace = {};
  if (!skus.length) return trace;
  for (const s of skus) trace[s] = { team: null, lastSend: null, sent7: null, deliv7: null };

  const since14 = new Date(Date.now() - 14 * 86400000).toISOString();
  const since7 = new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0];

  const [{ data: variants }, { data: transfers }, { data: dlines }, { data: orders }] = await Promise.all([
    supabase.from('lab_fiche_variants').select('sku, fiche_id').in('sku', skus),
    supabase.from('lab_stock_transfers').select('id, team, created_by_name, created_at').gte('created_at', since14),
    supabase.from('lab_delivery_check_lines')
      .select('sku, qty_checked, delivery_date, delivery_order_id')
      .in('sku', skus).gte('delivery_date', since7).limit(8000),
    // Petite table (~centaines de lignes) — filtrée par date plutôt que par liste d'ids pour
    // éviter une URL PostgREST géante.
    supabase.from('lab_delivery_orders')
      .select('id, order_ref, odoo_push_status, odoo_validated_by_name, delivery_date')
      .gte('delivery_date', since7).in('odoo_push_status', ['validated', 'already_done']),
  ]);

  // Équipe du produit (première équipe de la fiche)
  const ficheIds = Array.from(new Set((variants ?? []).map((v: any) => v.fiche_id).filter(Boolean))) as string[];
  const { data: fiches } = ficheIds.length
    ? await supabase.from('lab_fiche_meta').select('id, teams').in('id', ficheIds)
    : { data: [] as any[] };
  const teamByFiche: Record<string, string | null> = {};
  for (const f of fiches ?? []) teamByFiche[f.id] = Array.isArray(f.teams) && f.teams.length ? f.teams[0] : null;
  for (const v of variants ?? []) if (v.sku && trace[v.sku] && !trace[v.sku].team) trace[v.sku].team = teamByFiche[v.fiche_id] ?? null;

  // Dernier envoi en stock par SKU
  const tById: Record<string, any> = {};
  for (const t of transfers ?? []) tById[t.id] = t;
  const tids = Object.keys(tById);
  if (tids.length) {
    const { data: tlines } = await supabase.from('lab_stock_transfer_lines')
      .select('sku, qty_sent, transfer_id').in('transfer_id', tids).in('sku', skus).limit(5000);
    const since7iso = new Date(Date.now() - 7 * 86400000).toISOString();
    for (const l of tlines ?? []) {
      const t = tById[l.transfer_id];
      if (!l.sku || !t || !trace[l.sku]) continue;
      if (t.created_at >= since7iso) {
        let s7 = trace[l.sku].sent7;
        if (!s7) { s7 = { qty: 0, count: 0 }; trace[l.sku].sent7 = s7; }
        s7.qty += Number(l.qty_sent ?? 0); s7.count += 1;
      }
      const cur = trace[l.sku].lastSend;
      if (!cur || t.created_at > cur.date) {
        trace[l.sku].lastSend = { date: t.created_at, team: t.team ?? null, by: t.created_by_name ?? null, qty: Number(l.qty_sent ?? 0) };
      } else if (t.created_at === cur.date) {
        cur.qty += Number(l.qty_sent ?? 0);
      }
    }
  }

  // Livraisons poussées sur Odoo (7 j) par SKU
  const oById: Record<string, any> = {};
  for (const o of orders ?? []) oById[o.id] = o;
  for (const l of dlines ?? []) {
    const o = oById[l.delivery_order_id];
    if (!o || !l.sku || !trace[l.sku]) continue;
    const qty = Number(l.qty_checked ?? 0);
    if (qty <= 0) continue;
    let d = trace[l.sku].deliv7;
    if (!d) { d = { qty: 0, count: 0, lastRef: null, lastDate: null, lastBy: null }; trace[l.sku].deliv7 = d; }
    d.qty += qty; d.count += 1;
    if (!d.lastDate || l.delivery_date >= d.lastDate) {
      d.lastDate = l.delivery_date; d.lastRef = o.order_ref; d.lastBy = o.odoo_validated_by_name ?? null;
    }
  }

  return trace;
}
