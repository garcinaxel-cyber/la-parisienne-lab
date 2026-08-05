import type { SupabaseClient } from '@supabase/supabase-js';
import { odooExecute, odooExecuteWrite, odooConfigured, odooWriteConfigured, labDayUtcRange } from '@/lib/odoo';

function tmo<T>(p: Promise<T>, ms: number, l: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, r) => setTimeout(() => r(new Error('timeout ' + l)), ms))]);
}

export interface SentToStock {
  bySku: Record<string, number>;
  // Lines sent to stock with NO sku at all — these can never be matched to an Odoo product,
  // so they'd otherwise vanish from the sync with no trace (see 2026-08-05 Charlotte Watermint
  // D14 gap: 446 in Odoo vs 447 actually sent, caused by a history-tab send with sku=null).
  missingSku: { productName: string; qty: number }[];
}

// Cumulative quantity SENT TO STOCK per SKU for one lab-day (from transfer notes created that day).
// This is what the Odoo Manufacturing Orders must total for the day.
export async function sentToStockBySku(supabase: SupabaseClient, date: string): Promise<SentToStock> {
  const { start, end } = labDayUtcRange(date);
  const { data: transfers } = await supabase.from('lab_stock_transfers')
    .select('id').gte('created_at', start).lt('created_at', end);
  const tids = (transfers ?? []).map((t: any) => t.id);
  if (!tids.length) return { bySku: {}, missingSku: [] };
  const { data: lines } = await supabase.from('lab_stock_transfer_lines')
    .select('sku, qty_sent, product_name_vi').in('transfer_id', tids);
  const bySku: Record<string, number> = {};
  const missingSku: { productName: string; qty: number }[] = [];
  for (const l of lines ?? []) {
    if (!l.qty_sent || l.qty_sent <= 0) continue;
    if (l.sku) bySku[l.sku] = (bySku[l.sku] ?? 0) + l.qty_sent;
    else missingSku.push({ productName: l.product_name_vi ?? '(unknown product)', qty: l.qty_sent });
  }
  return { bySku, missingSku };
}

export interface MoSyncResult {
  date: string; origin: string; committed: boolean;
  toCreate: { sku: string; product: string; qty: number; values?: any }[];
  toUpdate: { id: number; mo: string; sku: string; product: string; from: number; to: number }[];
  unchanged: { sku: string; product: string; target: number; reason: string }[];
  noProduct: { sku: string; qty: number }[];
  // Sent to stock with no SKU at all — never even attempted (can't look up an Odoo product
  // without one). Always populated, dry-run or not, so the manual resync route sees it too.
  missingSku: { productName: string; qty: number }[];
  created?: any[]; updated?: any[]; errors?: { sku: string; error: string }[];
}

// Sync Odoo MOs so that, per product for the day, SUM(non-cancelled MOs) == qty sent to stock.
// Keeps ONE adjustable DRAFT MO; NEVER modifies validated (non-draft) MOs — creates a new draft
// for the remaining delta instead. `skus` limits the sync to those products (real-time trigger).
export async function syncStockToOdoo(
  supabase: SupabaseClient, date: string, opts: { commit: boolean; skus?: string[] },
): Promise<MoSyncResult> {
  const origin = `Lab ${date}`;
  const res: MoSyncResult = { date, origin, committed: false, toCreate: [], toUpdate: [], unchanged: [], noProduct: [], missingSku: [] };
  if (!odooConfigured()) return res;

  const { bySku, missingSku } = await sentToStockBySku(supabase, date);
  res.missingSku = missingSku;
  if (missingSku.length) {
    res.errors = (res.errors ?? []).concat(missingSku.map(m => ({
      sku: '(no SKU)',
      error: `"${m.productName}" ×${m.qty} sent to stock without a SKU — cannot sync to Odoo (see loadHistoryDetails/StationView)`,
    })));
  }
  let entries = Object.entries(bySku).filter(([, q]) => q > 0);
  if (opts.skus?.length) { const set = new Set(opts.skus); entries = entries.filter(([sku]) => set.has(sku)); }
  if (!entries.length) return res;

  const skus = entries.map(([sku]) => sku);
  const prods = await tmo(odooExecute<any[]>('product.product', 'search_read',
    [[['default_code', 'in', skus]]], { fields: ['id', 'name', 'default_code', 'uom_id', 'product_tmpl_id'], limit: 2000 }), 30000, 'prods');
  const prodBySku: Record<string, any> = {}; const tmplByProd: Record<number, number> = {};
  for (const p of prods) if (p.default_code) { prodBySku[p.default_code] = p; tmplByProd[p.id] = Array.isArray(p.product_tmpl_id) ? p.product_tmpl_id[0] : p.product_tmpl_id; }
  const prodIds = Object.values(prodBySku).map((p: any) => p.id);
  const tmplIds = Array.from(new Set(Object.values(tmplByProd)));
  const boms = (prodIds.length || tmplIds.length) ? await tmo(odooExecute<any[]>('mrp.bom', 'search_read',
    [['|', ['product_id', 'in', prodIds], ['product_tmpl_id', 'in', tmplIds]]], { fields: ['id', 'product_id', 'product_tmpl_id'], limit: 5000 }), 30000, 'boms') : [];
  const bomByProd: Record<number, number> = {}; const bomByTmpl: Record<number, number> = {};
  for (const b of boms) { const pid = Array.isArray(b.product_id) ? b.product_id[0] : (b.product_id || null); const tid = Array.isArray(b.product_tmpl_id) ? b.product_tmpl_id[0] : (b.product_tmpl_id || null); if (pid) bomByProd[pid] = b.id; else if (tid) bomByTmpl[tid] = b.id; }
  const bomFor = (p: any) => bomByProd[p.id] ?? bomByTmpl[tmplByProd[p.id]] ?? null;

  let moDateField: string | null = null;
  try { const fg = await tmo(odooExecute<any>('mrp.production', 'fields_get', [['date_start', 'date_planned_start']], { attributes: ['type'] }), 15000, 'fg'); moDateField = fg?.date_start ? 'date_start' : (fg?.date_planned_start ? 'date_planned_start' : null); } catch { moDateField = null; }
  const moDate = `${date} 02:00:00`;

  const existing = prodIds.length ? await tmo(odooExecute<any[]>('mrp.production', 'search_read',
    [[['origin', '=', origin], ['state', '!=', 'cancel'], ['product_id', 'in', prodIds]]], { fields: ['id', 'product_id', 'product_qty', 'state', 'name'], limit: 5000 }), 20000, 'existing') : [];
  const moByProd: Record<number, { confirmedSum: number; draft: { id: number; qty: number; name: string } | null }> = {};
  for (const m of existing.sort((a: any, z: any) => a.id - z.id)) {
    const pid = Array.isArray(m.product_id) ? m.product_id[0] : m.product_id;
    const e = moByProd[pid] ??= { confirmedSum: 0, draft: null };
    if (m.state === 'draft') { if (!e.draft) e.draft = { id: m.id, qty: m.product_qty, name: m.name }; }
    else e.confirmedSum += (m.product_qty ?? 0);
  }

  for (const [sku, target] of entries) {
    const p = prodBySku[sku];
    if (!p) { res.noProduct.push({ sku, qty: target }); continue; }
    const e = moByProd[p.id] ?? { confirmedSum: 0, draft: null };
    const desiredDraft = target - e.confirmedSum;
    if (desiredDraft <= 0) { res.unchanged.push({ sku, product: p.name, target, reason: 'covered by validated MOs' }); continue; }
    if (e.draft) {
      if (e.draft.qty === desiredDraft) res.unchanged.push({ sku, product: p.name, target, reason: 'up to date' });
      else res.toUpdate.push({ id: e.draft.id, mo: e.draft.name, sku, product: p.name, from: e.draft.qty, to: desiredDraft });
    } else {
      res.toCreate.push({
        sku, product: p.name, qty: desiredDraft,
        values: { product_id: p.id, product_qty: desiredDraft, product_uom_id: Array.isArray(p.uom_id) ? p.uom_id[0] : p.uom_id, origin, ...(bomFor(p) ? { bom_id: bomFor(p) } : {}), ...(moDateField ? { [moDateField]: moDate } : {}) },
      });
    }
  }

  if (!opts.commit || !odooWriteConfigured()) return res;

  res.created = []; res.updated = []; res.errors = res.errors ?? [];
  for (const item of res.toCreate) {
    try {
      const id = await tmo(odooExecuteWrite<number>('mrp.production', 'create', [item.values]), 25000, 'create');
      const [mo] = await tmo(odooExecuteWrite<any[]>('mrp.production', 'read', [[id]], { fields: ['name'] }), 15000, 'read');
      res.created.push({ sku: item.sku, product: item.product, qty: item.qty, mo: mo?.name });
    } catch (e: any) { res.errors.push({ sku: item.sku, error: String(e?.message ?? e) }); }
  }
  for (const item of res.toUpdate) {
    try {
      await tmo(odooExecuteWrite<boolean>('mrp.production', 'write', [[item.id], { product_qty: item.to }]), 25000, 'update');
      res.updated.push({ sku: item.sku, product: item.product, mo: item.mo, from: item.from, to: item.to });
    } catch (e: any) { res.errors.push({ sku: item.sku, error: `update ${item.mo}: ${String(e?.message ?? e)}` }); }
  }
  res.committed = true;
  return res;
}
