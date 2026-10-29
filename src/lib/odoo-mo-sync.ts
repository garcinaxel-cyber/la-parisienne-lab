import type { SupabaseClient } from '@supabase/supabase-js';
import { odooExecute, odooExecuteWrite, odooConfigured, odooWriteConfigured, labDayUtcRange } from '@/lib/odoo';
import { roomsLinkedForDay, roomOf, ROOMS, LAB_MANUF_TYPE_ID, LAB_STOCK_ID } from '@/lib/rooms-odoo';

function tmo<T>(p: Promise<T>, ms: number, l: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, r) => setTimeout(() => r(new Error('timeout ' + l)), ms))]);
}

export interface SentToStock {
  bySku: Record<string, number>;
  /** Same, per team then SKU (rooms linked to Odoo, 2026-10-29: one MO per product AND team). */
  byTeamSku: Record<string, Record<string, number>>;
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
    .select('id, team').gte('created_at', start).lt('created_at', end).neq('status', 'cancelled');
  const tids = (transfers ?? []).map((t: any) => t.id);
  if (!tids.length) return { bySku: {}, byTeamSku: {}, missingSku: [] };
  const teamOfTransfer = new Map((transfers ?? []).map((t: any) => [t.id, t.team ?? '']));
  // Page by page: a short read here would LOWER the day's MOs (Supabase caps at 1000 rows).
  const lines: any[] = [];
  for (let i = 0; i < tids.length; i += 100) {
    for (let f = 0; ; f += 1000) {
      const { data } = await supabase.from('lab_stock_transfer_lines').select('id, transfer_id, sku, qty_sent, product_name_vi').in('transfer_id', tids.slice(i, i + 100)).order('id').range(f, f + 999);
      lines.push(...(data ?? []));
      if (!data || data.length < 1000) break;
    }
  }
  const bySku: Record<string, number> = {};
  const byTeamSku: Record<string, Record<string, number>> = {};
  const missingSku: { productName: string; qty: number }[] = [];
  for (const l of lines ?? []) {
    if (!l.qty_sent || l.qty_sent <= 0) continue;
    if (l.sku) {
      bySku[l.sku] = (bySku[l.sku] ?? 0) + l.qty_sent;
      const t = String(teamOfTransfer.get(l.transfer_id) ?? '');
      (byTeamSku[t] ??= {})[l.sku] = (byTeamSku[t][l.sku] ?? 0) + l.qty_sent;
    }
    else missingSku.push({ productName: l.product_name_vi ?? '(unknown product)', qty: l.qty_sent });
  }
  return { bySku, byTeamSku, missingSku };
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
// Writes run one at a time per day (named lock, v132): two syncs at the same moment used to be able
// to create two draft MOs for the same product (review 2026-10-24).
export async function syncStockToOdoo(
  supabase: SupabaseClient, date: string, opts: { commit: boolean; skus?: string[] },
): Promise<MoSyncResult> {
  if (!opts.commit) return syncStockToOdooInner(supabase, date, opts);
  const { withLock } = await import('@/lib/named-lock');
  return withLock(supabase, `mosync|${date}`, () => syncStockToOdooInner(supabase, date, opts), { seconds: 120, waitMs: 40000 });
}

async function syncStockToOdooInner(
  supabase: SupabaseClient, date: string, opts: { commit: boolean; skus?: string[] },
): Promise<MoSyncResult> {
  const origin = `Lab ${date}`;
  const res: MoSyncResult = { date, origin, committed: false, toCreate: [], toUpdate: [], unchanged: [], noProduct: [], missingSku: [] };
  if (!odooConfigured()) return res;

  const { bySku, byTeamSku, missingSku } = await sentToStockBySku(supabase, date);
  // Rooms linked (2026-10-29): one MO per product and team, on the team's manufacturing type
  // (components and semi-finished in the team's room, finished product into LAB/Stock). A team
  // without a room keeps the legacy Lab: Manufacturing type. Before the start day: one MO per product.
  const linked = roomsLinkedForDay(date);
  const typeOfTeam = (team: string) => (linked ? roomOf(team)?.manufType ?? LAB_MANUF_TYPE_ID : null);
  const roomLocOfType = (typeId: number | null) => Object.values(ROOMS).find(r => r.manufType === typeId)?.location ?? null;
  const targets: { sku: string; typeId: number | null; qty: number }[] = [];
  if (linked) {
    const acc: Record<string, { sku: string; typeId: number; qty: number }> = {};
    for (const [team, m] of Object.entries(byTeamSku)) for (const [sku, q] of Object.entries(m)) {
      const typeId = typeOfTeam(team)!; const k = `${typeId}|${sku}`;
      (acc[k] ??= { sku, typeId, qty: 0 }).qty += q;
    }
    targets.push(...Object.values(acc));
  } else for (const [sku, q] of Object.entries(bySku)) targets.push({ sku, typeId: null, qty: q });
  res.missingSku = missingSku;
  if (missingSku.length) {
    res.errors = (res.errors ?? []).concat(missingSku.map(m => ({
      sku: '(no SKU)',
      error: `"${m.productName}" ×${m.qty} sent to stock without a SKU — cannot sync to Odoo (see loadHistoryDetails/StationView)`,
    })));
  }
  let entries = targets.filter(t => t.qty > 0);
  if (opts.skus?.length) { const set = new Set(opts.skus); entries = entries.filter(t => set.has(t.sku)); }
  if (!entries.length) return res;

  const skus = Array.from(new Set(entries.map(t => t.sku)));
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
    [[['origin', '=', origin], ['state', '!=', 'cancel'], ['product_id', 'in', prodIds]]], { fields: ['id', 'product_id', 'product_qty', 'state', 'name', 'picking_type_id'], limit: 5000 }), 20000, 'existing') : [];
  // An mrp.unbuild does NOT lower the MO's quantity: subtract the done unbuilds, otherwise a day
  // that was corrected ("bếp chưa làm") looks still covered and later transfers never reach Odoo.
  // The read-only Odoo account has no right on mrp.unbuild (24/10 incident: reading unbuild_ids
  // broke every sync) — read them with the write account, and never let this block the sync.
  const unbuiltByMo: Record<number, number> = {};
  if (existing.length && odooWriteConfigured()) {
    try {
      const ubs = await tmo(odooExecuteWrite<any[]>('mrp.unbuild', 'search_read', [[['mo_id', 'in', existing.map((m: any) => m.id)], ['state', '=', 'done']]], { fields: ['mo_id', 'product_qty'] }), 20000, 'unbuilds');
      for (const u of ubs) if (u.mo_id) { const mid = Array.isArray(u.mo_id) ? u.mo_id[0] : u.mo_id; unbuiltByMo[mid] = (unbuiltByMo[mid] ?? 0) + Number(u.product_qty || 0); }
    } catch { /* unknown unbuilds: behave as before */ }
  }
  // Grouping key: product, plus the manufacturing type once rooms are linked (one MO per team).
  const keyOf = (pid: number, typeId: number | null) => (linked ? `${pid}|${typeId ?? LAB_MANUF_TYPE_ID}` : String(pid));
  const moByProd: Record<string, { confirmedSum: number; draft: { id: number; qty: number; name: string } | null }> = {};
  const legacyLeft: Record<number, number> = {};
  for (const m of existing.sort((a: any, z: any) => a.id - z.id)) {
    const pid = Array.isArray(m.product_id) ? m.product_id[0] : m.product_id;
    const tid = Array.isArray(m.picking_type_id) ? m.picking_type_id[0] : (m.picking_type_id || null);
    // Linked day with an MO on another type (legacy Lab: Manufacturing, made before the switch or by
    // hand): it already covers part of the day — counted against the teams' targets, never modified.
    if (linked && !Object.values(ROOMS).some(r => r.manufType === tid)) {
      legacyLeft[pid] = (legacyLeft[pid] ?? 0) + (m.product_qty ?? 0) - (m.state === 'draft' ? 0 : (unbuiltByMo[m.id] ?? 0));
      continue;
    }
    const e = moByProd[keyOf(pid, tid)] ??= { confirmedSum: 0, draft: null };
    // A second draft (left by an old race) counts like a confirmed one, so it is never forgotten.
    if (m.state === 'draft' && !e.draft) e.draft = { id: m.id, qty: m.product_qty, name: m.name };
    else if (m.state === 'draft') e.confirmedSum += (m.product_qty ?? 0);
    else e.confirmedSum += (m.product_qty ?? 0) - (unbuiltByMo[m.id] ?? 0);
  }

  for (const { sku, typeId, qty: target } of entries) {
    const p = prodBySku[sku];
    if (!p) { res.noProduct.push({ sku, qty: target }); continue; }
    const e = moByProd[keyOf(p.id, typeId)] ?? { confirmedSum: 0, draft: null };
    const room = roomLocOfType(typeId);
    const placement = linked && typeId
      ? { picking_type_id: typeId, ...(room ? { location_src_id: room } : {}), location_dest_id: LAB_STOCK_ID }
      : {};
    const cover = Math.max(0, Math.min(legacyLeft[p.id] ?? 0, target - e.confirmedSum));
    if (cover > 0) legacyLeft[p.id] -= cover;
    const desiredDraft = target - e.confirmedSum - cover;
    if (desiredDraft <= 0) { res.unchanged.push({ sku, product: p.name, target, reason: 'covered by validated MOs' }); continue; }
    if (e.draft) {
      if (e.draft.qty === desiredDraft) res.unchanged.push({ sku, product: p.name, target, reason: 'up to date' });
      else res.toUpdate.push({ id: e.draft.id, mo: e.draft.name, sku, product: p.name, from: e.draft.qty, to: desiredDraft });
    } else {
      res.toCreate.push({
        sku, product: p.name, qty: desiredDraft,
        values: { product_id: p.id, product_qty: desiredDraft, product_uom_id: Array.isArray(p.uom_id) ? p.uom_id[0] : p.uom_id, origin, ...(bomFor(p) ? { bom_id: bomFor(p) } : {}), ...(moDateField ? { [moDateField]: moDate } : {}), ...placement },
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
