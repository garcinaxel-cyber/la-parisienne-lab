import type { SupabaseClient } from '@supabase/supabase-js';
import { odooExecute, odooDateTimeToLocal, labTodayUtcThreshold } from '@/lib/odoo';

export interface OdooSyncResult {
  lines: any[];
  changes: { order_ref: string; cancelled: boolean; items: { sku: string; name: string; old_qty: number; new_qty: number }[] }[];
  deletedRefs: string[]; // refs that no longer exist in Odoo at all (hard-deleted, not just cancelled)
  // Replenishment requests whose lines are 100% excluded SKUs (lab_excluded_skus — packaging/
  // matières) never produce a single entry in `lines`, so they'd otherwise be invisible
  // EVERYWHERE: no lab_imports row, no lab_order_lines row, and odoo-packaging-sync.ts never
  // discovers them either (it only looks for refs already present in lab_order_lines). Confirmed
  // 2026-08-11 on REP/2026/01005-01007 (pure packaging restocks, e.g. "Kraft paper takeaway cake
  // bag"). The caller upserts these straight into lab_order_packaging_lines so they still show
  // up in delivery-check (which already unions that table independently of lab_imports status).
  packagingOnly: { order_ref: string; delivery_date: string; source_type: string; shop_name: string | null; sku: string; product_name_vi: string; qty: number; note: string | null }[];
  // Coverage check (Axel, 2026-08-11, after REP/2026/01006 turned out invisible): every Odoo
  // order currently open (same state+date window as this whole sync) that ends up with ZERO
  // representation anywhere in the app by the end of this function — not already imported, not
  // in `lines`, not in `packagingOnly`. Persisted by the caller to lab_sync_gaps so delivery-
  // check's index page can show a banner without the app ever calling Odoo on a page view.
  syncGaps: { order_ref: string; source_type: string; delivery_date: string | null; state: string; reason: string }[];
  stats: {
    sales_orders: number;
    replenishments: number;
    already_imported: string[];
    multi_team_skus: string[];
    order_states: Record<string, string>;
  };
}

// Shared Odoo sync core — used by the manual "Sync from Odoo" button (user session client)
// and by the hourly cron (service-role client). Read-only towards Odoo.
export async function runOdooSync(supabase: SupabaseClient): Promise<OdooSyncResult> {
  const threshold = labTodayUtcThreshold();

// ── 1. Sales orders — everything entered except cancelled (draft quotations included:
//     the lab produces from what is ENTERED, confirmation in Odoo comes later) ──
const orders: any[] = await odooExecute('sale.order', 'search_read',
  [[['state', 'in', ['draft', 'sent', 'sale']], ['commitment_date', '>=', threshold]]],
  { fields: ['name', 'partner_id', 'commitment_date', 'state'], limit: 500 });

const orderIds = orders.map(o => o.id);
// Fetch every line, including note-only rows (display_type='line_note') — Odoo lets a
// salesperson attach a note as its OWN line right under a product (see 2026-08-11 screenshot,
// S03161 "DÁN SẴN TEM VÀ HỘP DECOR" under Bánh Tiramisu), distinct from typing extra text
// inside the product line's own description (handled separately by extractNote() below).
// The previous ['display_type', '=', false] filter dropped these note rows entirely — they
// were never imported anywhere. Sorting by (order, sequence) below lets us attach each note
// to the product line immediately above it, matching Odoo's own display order.
const allSoLines: any[] = orderIds.length
  ? await odooExecute('sale.order.line', 'search_read',
      [[['order_id', 'in', orderIds]]],
      { fields: ['order_id', 'product_id', 'product_uom_qty', 'name', 'sequence', 'display_type'], limit: 6000 })
  : [];
allSoLines.sort((a, b) => (a.order_id?.[0] ?? 0) - (b.order_id?.[0] ?? 0) || (a.sequence ?? 0) - (b.sequence ?? 0));
const attachedNoteByLineId: Record<number, string> = {};
let lastProductLineId: number | null = null;
for (const l of allSoLines) {
  if (l.display_type === 'line_note') {
    const text = String(l.name ?? '').trim();
    if (lastProductLineId != null && text) {
      attachedNoteByLineId[lastProductLineId] = attachedNoteByLineId[lastProductLineId]
        ? `${attachedNoteByLineId[lastProductLineId]} / ${text}` : text;
    }
    continue;
  }
  if (!l.display_type) lastProductLineId = l.id;
}
const soLines: any[] = allSoLines.filter(l => !l.display_type);

// ── 2. Replenishment requests — draft/submitted/approved (everything entered, not yet shipped) ──
const repls: any[] = await odooExecute('stock.replenishment.request', 'search_read',
  [[['state', 'in', ['draft', 'submitted', 'approved']], ['delivery_date', '>=', threshold]]],
  { fields: ['name', 'warehouse_id', 'delivery_date', 'state'], limit: 200 });

const replIds = repls.map(r => r.id);
const replLines: any[] = replIds.length
  ? await odooExecute('stock.replenishment.request.line', 'search_read',
      [[['request_id', 'in', replIds]]],
      { fields: ['request_id', 'product_id', 'quantity_requested', 'note'], limit: 2000 })
  : [];

// ── 3. SKUs for all products involved ──
const productIds = Array.from(new Set([
  ...soLines.map(l => l.product_id?.[0]),
  ...replLines.map(l => l.product_id?.[0]),
].filter(Boolean))) as number[];
const products: any[] = productIds.length
  ? await odooExecute('product.product', 'read', [productIds], { fields: ['default_code', 'name'] })
  : [];
const skuByProductId: Record<number, { sku: string; name: string }> = {};
for (const p of products) skuByProductId[p.id] = { sku: p.default_code || '', name: p.name || '' };

// Permanently excluded SKUs (packaging, drinks, stickers…) — never imported
const { data: excludedRows } = await supabase.from('lab_excluded_skus').select('sku');
const excludedSet = new Set((excludedRows ?? []).map((r: any) => r.sku));

// ── 4. Team resolution from lab fiches (SKU → variant → fiche.teams[0]) ──
const allSkus = Array.from(new Set(Object.values(skuByProductId).map(p => p.sku).filter(Boolean)));
const { data: variantRows } = allSkus.length
  ? await supabase.from('lab_fiche_variants').select('sku, fiche_id').in('sku', allSkus)
  : { data: [] as any[] };
const ficheIds = Array.from(new Set((variantRows ?? []).map(v => v.fiche_id).filter(Boolean)));
const { data: ficheRows } = ficheIds.length
  ? await supabase.from('lab_fiche_meta').select('id, teams').in('id', ficheIds)
  : { data: [] as any[] };
const teamsByFiche: Record<string, string[]> = {};
for (const f of ficheRows ?? []) teamsByFiche[f.id] = f.teams ?? [];
const teamBySku: Record<string, { team: string; multi: boolean }> = {};
for (const v of variantRows ?? []) {
  const teams = teamsByFiche[v.fiche_id] ?? [];
  if (v.sku) teamBySku[v.sku] = { team: teams[0] ?? '', multi: teams.length > 1 };
}

const orderById: Record<number, any> = {};
for (const o of orders) orderById[o.id] = o;
const replById: Record<number, any> = {};
for (const r of repls) replById[r.id] = r;

// ── 5. Anti-duplicate + change detection: refs already imported into the lab app ──
const { data: existingLines } = await supabase
  .from('lab_order_lines')
  .select('id, order_ref, product_sku, product_name_vi, qty, import_id, team, variant_label, delivery_date')
  .gte('delivery_date', new Date().toISOString().split('T')[0])
  .limit(5000);
const alreadyImported = new Set((existingLines ?? []).map(r => r.order_ref).filter(Boolean));

// Current Odoo quantities per (order_ref, sku) — for already-imported refs
const odooQtyByRefSku: Record<string, { qty: number; name: string }> = {};
const refsSeenInOdoo = new Set<string>();
const addOdooQty = (ref: string, sku: string, qty: number, name: string) => {
  refsSeenInOdoo.add(ref);
  const k = `${ref}||${sku}`;
  const cur = odooQtyByRefSku[k];
  odooQtyByRefSku[k] = { qty: (cur?.qty ?? 0) + qty, name };
};
for (const l of soLines) {
  const order = orderById[l.order_id?.[0]];
  const prod = skuByProductId[l.product_id?.[0]];
  if (order && prod?.sku && alreadyImported.has(order.name)) {
    addOdooQty(order.name, prod.sku, Math.round(Number(l.product_uom_qty ?? 0)), prod.name);
  }
}
for (const l of replLines) {
  const req = replById[l.request_id?.[0]];
  const prod = skuByProductId[l.product_id?.[0]];
  if (req && prod?.sku && alreadyImported.has(req.name)) {
    addOdooQty(req.name, prod.sku, Math.round(Number(l.quantity_requested ?? 0)), prod.name);
  }
}
// Refs imported into the lab but no longer returned by Odoo (cancelled, or state left the
// imported scope) — check their actual state explicitly
const missingRefs = Array.from(alreadyImported).filter(r => !refsSeenInOdoo.has(r)) as string[];
const cancelledRefs: string[] = [];
let deletedRefs: string[] = [];
if (missingRefs.length > 0) {
  const soMissing: any[] = await odooExecute('sale.order', 'search_read',
    [[['name', 'in', missingRefs]]], { fields: ['name', 'state'], limit: 200 });
  const rrMissing: any[] = await odooExecute('stock.replenishment.request', 'search_read',
    [[['name', 'in', missingRefs]]], { fields: ['name', 'state'], limit: 200 });
  const foundMissing = new Set<string>([...soMissing, ...rrMissing].map((o: any) => o.name));
  for (const o of [...soMissing, ...rrMissing]) {
    if (['cancel', 'cancelled', 'rejected'].includes(o.state)) cancelledRefs.push(o.name);
  }
  // A ref that NO Odoo model returns when queried by name was HARD-DELETED (a ref merely out
  // of the sync window — e.g. delivery date moved — would still return a row). Treat a deletion
  // exactly like a cancellation so the order drops out of production.
  deletedRefs = missingRefs.filter(r => !foundMissing.has(r));
  for (const r of deletedRefs) if (!cancelledRefs.includes(r)) cancelledRefs.push(r);
}
// Build the change list: lab vs Odoo, per (order_ref, sku)
const labQtyByRefSku: Record<string, { qty: number; name: string }> = {};
for (const r of existingLines ?? []) {
  if (!r.order_ref || !r.product_sku) continue;
  const k = `${r.order_ref}||${r.product_sku}`;
  labQtyByRefSku[k] = { qty: (labQtyByRefSku[k]?.qty ?? 0) + (r.qty ?? 0), name: r.product_name_vi ?? r.product_sku };
}
const changesByRef: Record<string, { sku: string; name: string; old_qty: number; new_qty: number }[]> = {};
const pushChange = (ref: string, c: { sku: string; name: string; old_qty: number; new_qty: number }) => {
  (changesByRef[ref] = changesByRef[ref] ?? []).push(c);
};
for (const [k, lab] of Object.entries(labQtyByRefSku)) {
  const [ref, sku] = k.split('||');
  if (excludedSet.has(sku)) continue; // packaging/drinks — never produced, ignore qty changes
  if (!alreadyImported.has(ref)) continue;
  if (cancelledRefs.includes(ref)) { pushChange(ref, { sku, name: lab.name, old_qty: lab.qty, new_qty: 0 }); continue; }
  if (!refsSeenInOdoo.has(ref)) continue; // ref not in scope anymore but not cancelled — leave untouched
  const odoo = odooQtyByRefSku[k];
  if (!odoo) { pushChange(ref, { sku, name: lab.name, old_qty: lab.qty, new_qty: 0 }); continue; }
  if (odoo.qty !== lab.qty) pushChange(ref, { sku, name: lab.name, old_qty: lab.qty, new_qty: odoo.qty });
}
for (const [k, odoo] of Object.entries(odooQtyByRefSku)) {
  const [ref, sku] = k.split('||');
  if (excludedSet.has(sku)) continue; // packaging/drinks — never produced, don't flag as "added"
  if (!labQtyByRefSku[k]) pushChange(ref, { sku, name: odoo.name, old_qty: 0, new_qty: odoo.qty });
}
const changes = Object.entries(changesByRef)
  // Drop no-op items (old == new, e.g. a line long ago zeroed that Odoo no longer has) —
  // they aren't real changes and would otherwise re-surface on every sync.
  .map(([order_ref, items]) => ({
    order_ref,
    cancelled: cancelledRefs.includes(order_ref),
    items: items.filter(it => it.old_qty !== it.new_qty),
  }))
  .filter(c => c.cancelled || c.items.length > 0);

// ── 6. Build ParsedLine[] (same shape as the Excel parser output) ──
const lines: any[] = [];
const skippedRefs = new Set<string>();
let multiTeamSkus = new Set<string>();

// A salesperson's note lives on the Odoo line's `name`, AFTER the first line
// (which is the product label). Everything past the first newline = the note.
const extractNote = (raw: unknown): string | null => {
  const s = String(raw ?? '');
  if (!s.includes('\n')) return null;
  const note = s.split('\n').slice(1).join(' ').replace(/\s+/g, ' ').trim();
  return note || null;
};

for (const l of soLines) {
  const order = orderById[l.order_id?.[0]];
  if (!order) continue;
  if (alreadyImported.has(order.name)) { skippedRefs.add(order.name); continue; }
  const prod = skuByProductId[l.product_id?.[0]] ?? { sku: '', name: '' };
  const qty = Math.round(Number(l.product_uom_qty ?? 0));
  if (!prod.sku || !qty || excludedSet.has(prod.sku)) continue;
  const dt = odooDateTimeToLocal(order.commitment_date);
  const t = teamBySku[prod.sku];
  if (t?.multi) multiTeamSkus.add(prod.sku);
  lines.push({
    source_type: 'sales_order',
    order_ref: order.name,
    shop_name: order.partner_id?.[1] ?? '',
    product_sku: prod.sku,
    product_name_vi: String(l.name || prod.name).replace(/\[.*?\]\s*/, '').split('\n')[0].trim(),
    team: t?.team ?? '',
    variant_label: 'Standard',
    qty,
    delivery_date: dt.date,
    delivery_time: dt.time,
    note: [extractNote(l.name), attachedNoteByLineId[l.id]].filter(Boolean).join(' / ') || null,
  });
}

// Requests that got at least one real production line — used below to tell "genuinely 100%
// packaging" refs apart from ones that simply have zero qty/unmatched-SKU lines (nothing to do
// for those; only a request whose EXCLUDED lines are its ONLY content needs the fallback).
const replRefsWithProductionLine = new Set<string>();
const excludedReplLinesByRef: Record<string, { name: string; delivery_date: string; shop_name: string | null; sku: string; product_name_vi: string; qty: number; note: string | null }[]> = {};

for (const l of replLines) {
  const req = replById[l.request_id?.[0]];
  if (!req) continue;
  if (alreadyImported.has(req.name)) { skippedRefs.add(req.name); continue; }
  const prod = skuByProductId[l.product_id?.[0]] ?? { sku: '', name: '' };
  const qty = Math.round(Number(l.quantity_requested ?? 0));
  if (!prod.sku || !qty) continue;
  if (excludedSet.has(prod.sku)) {
    (excludedReplLinesByRef[req.name] ??= []).push({
      name: req.name, delivery_date: odooDateTimeToLocal(req.delivery_date).date,
      shop_name: (req.warehouse_id?.[1] ?? '').replace(/\s*-\s*warehouse\s*$/i, ''),
      sku: prod.sku, product_name_vi: prod.name,
      qty, note: (typeof l.note === 'string' && l.note.trim()) ? l.note.trim() : null,
    });
    continue;
  }
  replRefsWithProductionLine.add(req.name);
  const dt = odooDateTimeToLocal(req.delivery_date);
  const t = teamBySku[prod.sku];
  if (t?.multi) multiTeamSkus.add(prod.sku);
  lines.push({
    source_type: 'replenishment',
    order_ref: req.name,
    shop_name: (req.warehouse_id?.[1] ?? '').replace(/\s*-\s*warehouse\s*$/i, ''),
    product_sku: prod.sku,
    product_name_vi: prod.name,
    team: t?.team ?? '',
    variant_label: 'Standard',
    qty,
    delivery_date: dt.date,
    delivery_time: dt.time,
    // stock.replenishment.request.line DOES carry its own note field (confirmed 2026-08-11,
    // REP/2026/01005 "Cream Ganache Montée Vani 200g" — a previous assumption here that
    // replenishment lines never had notes was wrong).
    note: (typeof l.note === 'string' && l.note.trim()) ? l.note.trim() : null,
  });
}

// Odoo status per order ref — shown in the control report so assistants
// can spot lines that are still unconfirmed quotations before publishing
const orderStates: Record<string, string> = {};
for (const o of orders) orderStates[o.name] = o.state;      // draft | sent | sale
for (const r of repls) orderStates[r.name] = r.state;       // draft | submitted | approved

// Pure-packaging replenishments: only for refs with ZERO production lines — a ref that has
// at least one real production line already gets its excluded lines picked up next cron tick
// by odoo-packaging-sync.ts (which discovers refs via lab_order_lines), so injecting it here
// too would just be redundant work against the same table.
const packagingOnly: OdooSyncResult['packagingOnly'] = [];
for (const [ref, excludedLines] of Object.entries(excludedReplLinesByRef)) {
  if (replRefsWithProductionLine.has(ref) || alreadyImported.has(ref)) continue;
  for (const el of excludedLines) {
    packagingOnly.push({
      order_ref: el.name, delivery_date: el.delivery_date, source_type: 'replenishment',
      shop_name: el.shop_name, sku: el.sku,
      product_name_vi: el.product_name_vi, qty: el.qty, note: el.note,
    });
  }
}

// ── 7. Coverage gap detection ── flag any currently-open Odoo order with zero representation
// anywhere in the app by this point (see OdooSyncResult.syncGaps doc comment).
const producedRefs = new Set(lines.map((l: any) => l.order_ref));
const packagingRefs = new Set(packagingOnly.map(p => p.order_ref));
const soLineStatsByRef: Record<string, { total: number; excluded: number }> = {};
for (const l of soLines) {
  const order = orderById[l.order_id?.[0]];
  if (!order) continue;
  const s = soLineStatsByRef[order.name] ??= { total: 0, excluded: 0 };
  s.total++;
  const prod = skuByProductId[l.product_id?.[0]];
  if (prod?.sku && excludedSet.has(prod.sku)) s.excluded++;
}
const replLineStatsByRef: Record<string, { total: number; excluded: number }> = {};
for (const l of replLines) {
  const req = replById[l.request_id?.[0]];
  if (!req) continue;
  const s = replLineStatsByRef[req.name] ??= { total: 0, excluded: 0 };
  s.total++;
  const prod = skuByProductId[l.product_id?.[0]];
  if (prod?.sku && excludedSet.has(prod.sku)) s.excluded++;
}
const syncGaps: OdooSyncResult['syncGaps'] = [];
for (const o of orders) {
  if (alreadyImported.has(o.name) || producedRefs.has(o.name) || packagingRefs.has(o.name)) continue;
  const s = soLineStatsByRef[o.name];
  const reason = !s || s.total === 0 ? 'no_lines_in_odoo'
    : s.excluded === s.total ? 'all_lines_excluded_sku_no_fallback_yet' // known gap: no packaging-only fallback for sales orders yet
    : 'unmatched_sku_or_zero_qty';
  syncGaps.push({ order_ref: o.name, source_type: 'sales_order', delivery_date: odooDateTimeToLocal(o.commitment_date).date || null, state: o.state, reason });
}
for (const r of repls) {
  if (alreadyImported.has(r.name) || producedRefs.has(r.name) || packagingRefs.has(r.name)) continue;
  const s = replLineStatsByRef[r.name];
  const reason = !s || s.total === 0 ? 'no_lines_in_odoo'
    : s.excluded === s.total ? 'all_lines_excluded' // shouldn't happen (packagingOnly covers this) — safety net
    : 'unmatched_sku_or_zero_qty';
  syncGaps.push({ order_ref: r.name, source_type: 'replenishment', delivery_date: odooDateTimeToLocal(r.delivery_date).date || null, state: r.state, reason });
}

  return {
    lines,
    changes,
    deletedRefs,
    packagingOnly,
    syncGaps,
    stats: {
      sales_orders: orders.length,
      replenishments: repls.length,
      already_imported: Array.from(skippedRefs),
      multi_team_skus: Array.from(multiTeamSkus),
      order_states: orderStates,
    },
  };
}
