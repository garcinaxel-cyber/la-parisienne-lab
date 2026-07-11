import type { SupabaseClient } from '@supabase/supabase-js';
import { odooExecute, odooDateTimeToLocal, labTodayUtcThreshold } from '@/lib/odoo';

export interface OdooSyncResult {
  lines: any[];
  changes: { order_ref: string; cancelled: boolean; items: { sku: string; name: string; old_qty: number; new_qty: number }[] }[];
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
const soLines: any[] = orderIds.length
  ? await odooExecute('sale.order.line', 'search_read',
      [[['order_id', 'in', orderIds], ['display_type', '=', false]]],
      { fields: ['order_id', 'product_id', 'product_uom_qty', 'name'], limit: 4000 })
  : [];

// ── 2. Replenishment requests — draft/submitted/approved (everything entered, not yet shipped) ──
const repls: any[] = await odooExecute('stock.replenishment.request', 'search_read',
  [[['state', 'in', ['draft', 'submitted', 'approved']], ['delivery_date', '>=', threshold]]],
  { fields: ['name', 'warehouse_id', 'delivery_date', 'state'], limit: 200 });

const replIds = repls.map(r => r.id);
const replLines: any[] = replIds.length
  ? await odooExecute('stock.replenishment.request.line', 'search_read',
      [[['request_id', 'in', replIds]]],
      { fields: ['request_id', 'product_id', 'quantity_requested'], limit: 2000 })
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
if (missingRefs.length > 0) {
  const soMissing: any[] = await odooExecute('sale.order', 'search_read',
    [[['name', 'in', missingRefs]]], { fields: ['name', 'state'], limit: 200 });
  const rrMissing: any[] = await odooExecute('stock.replenishment.request', 'search_read',
    [[['name', 'in', missingRefs]]], { fields: ['name', 'state'], limit: 200 });
  for (const o of [...soMissing, ...rrMissing]) {
    if (['cancel', 'cancelled', 'rejected'].includes(o.state)) cancelledRefs.push(o.name);
  }
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
const changes = Object.entries(changesByRef).map(([order_ref, items]) => ({
  order_ref,
  cancelled: cancelledRefs.includes(order_ref),
  items,
}));

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
    note: extractNote(l.name),
  });
}

for (const l of replLines) {
  const req = replById[l.request_id?.[0]];
  if (!req) continue;
  if (alreadyImported.has(req.name)) { skippedRefs.add(req.name); continue; }
  const prod = skuByProductId[l.product_id?.[0]] ?? { sku: '', name: '' };
  const qty = Math.round(Number(l.quantity_requested ?? 0));
  if (!prod.sku || !qty || excludedSet.has(prod.sku)) continue;
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
    note: null, // replenishment lines carry no salesperson note
  });
}

// Odoo status per order ref — shown in the control report so assistants
// can spot lines that are still unconfirmed quotations before publishing
const orderStates: Record<string, string> = {};
for (const o of orders) orderStates[o.name] = o.state;      // draft | sent | sale
for (const r of repls) orderStates[r.name] = r.state;       // draft | submitted | approved

  return {
    lines,
    changes,
    stats: {
      sales_orders: orders.length,
      replenishments: repls.length,
      already_imported: Array.from(skippedRefs),
      multi_team_skus: Array.from(multiTeamSkus),
      order_states: orderStates,
    },
  };
}
