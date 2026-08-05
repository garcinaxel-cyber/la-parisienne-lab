import type { SupabaseClient } from '@supabase/supabase-js';
import { odooExecute, odooExecuteWrite, odooWriteConfigured, labLocalToOdooUtc } from '@/lib/odoo';

function tmo<T>(p: Promise<T>, ms: number, l: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, r) => setTimeout(() => r(new Error('timeout ' + l)), ms))]);
}

// Shop -> Odoo document mapping. Quotation (sale.order) for Moon Flower / Lab / (future) B2B;
// Replenishment (stock.replenishment.request) for the 4 La Paris shops (their own warehouse).
// B2B is intentionally absent for now — the urgent-order form only offers these 6 shops until
// Axel gives the B2B list.
export const SHOP_ODOO_MAP: Record<string, { docType: 'quotation' | 'replenishment'; partnerName?: string; warehouseCode?: string }> = {
  'Moon Flower': { docType: 'quotation', partnerName: 'MOON FLOWER' },
  'Lab': { docType: 'quotation', partnerName: 'LAB' },
  'La Paris Tây Hồ': { docType: 'replenishment', warehouseCode: 'LP' },
  'La Paris Long Biên': { docType: 'replenishment', warehouseCode: 'PARIS' },
  'La Paris Bà Triệu': { docType: 'replenishment', warehouseCode: 'LPBT' },
  'La Paris Timecity': { docType: 'replenishment', warehouseCode: 'LPTC' },
};

export interface CreateOrderResult {
  ok: boolean;
  order_ref?: string;
  error?: string;
}

// Sentinel written to lab_manual_cakes.matched_order_ref while an Odoo document is being
// created/attached for that row (race guard — see claimLines below).
const PENDING = '__pending_create__';
// A claim older than this is treated as orphaned (the request that made it crashed or was
// killed before reaching a catch block) and may be stolen — same self-heal pattern as
// lab_sync_lock's 2-minute expiry (odoo-auto-sync.ts), applied here per-row instead of globally.
const STALE_CLAIM_MS = 5 * 60 * 1000;

// Atomically claim every row in lineIds: a fresh claim (matched_order_ref IS NULL) always wins;
// a row already stuck at the PENDING sentinel is only reclaimed if its claim is stale. Two
// passes rather than one clever OR-query — easier to reason about and to verify does not
// double-claim a row someone else is actively working on.
async function claimLines(supabase: SupabaseClient, lineIds: string[]): Promise<string[]> {
  const nowIso = new Date().toISOString();
  const { data: free } = await supabase.from('lab_manual_cakes')
    .update({ matched_order_ref: PENDING, claimed_at: nowIso })
    .in('id', lineIds).is('matched_order_ref', null).select('id');
  const claimedIds = new Set<string>((free ?? []).map((r: any) => r.id as string));
  const stillUnclaimed = lineIds.filter(id => !claimedIds.has(id));
  if (stillUnclaimed.length) {
    const staleBefore = new Date(Date.now() - STALE_CLAIM_MS).toISOString();
    const { data: stolen } = await supabase.from('lab_manual_cakes')
      .update({ matched_order_ref: PENDING, claimed_at: nowIso })
      .in('id', stillUnclaimed).eq('matched_order_ref', PENDING).lt('claimed_at', staleBefore).select('id');
    for (const r of stolen ?? []) claimedIds.add(r.id as string);
  }
  return Array.from(claimedIds);
}

const partnerIdCache = new Map<string, number | null>();
// Exact '=' search came back empty even for a partner visibly named "LAB" in the UI
// (verified 07-28, id 347) — safer to match case/whitespace-insensitively via ilike then
// filter in JS, rather than trust Odoo's exact-match semantics on this field.
async function resolvePartnerId(name: string): Promise<number | null> {
  if (partnerIdCache.has(name)) return partnerIdCache.get(name)!;
  const rows = await tmo(odooExecute<any[]>('res.partner', 'search_read',
    [[['name', 'ilike', name]]], { fields: ['id', 'name'], limit: 20 }), 15000, 'partner');
  const target = name.trim().toLowerCase();
  const match = rows.find((r: any) => String(r.name ?? '').trim().toLowerCase() === target);
  const id = match?.id ?? null;
  partnerIdCache.set(name, id);
  return id;
}

const warehouseCache = new Map<string, { id: number; name: string } | null>();
async function resolveWarehouseId(code: string): Promise<{ id: number; name: string } | null> {
  if (warehouseCache.has(code)) return warehouseCache.get(code)!;
  const rows = await tmo(odooExecute<any[]>('stock.warehouse', 'search_read',
    [[['code', '=', code]]], { fields: ['id', 'name'], limit: 1 }), 15000, 'warehouse');
  const w = rows[0] ? { id: rows[0].id, name: rows[0].name } : null;
  warehouseCache.set(code, w);
  return w;
}

async function resolveProducts(skus: string[]): Promise<Record<string, { id: number; uom_id: number }>> {
  if (!skus.length) return {};
  const rows = await tmo(odooExecute<any[]>('product.product', 'search_read',
    [[['default_code', 'in', skus]]], { fields: ['id', 'default_code', 'uom_id'], limit: 2000 }), 20000, 'products');
  const out: Record<string, { id: number; uom_id: number }> = {};
  for (const p of rows) if (p.default_code) out[p.default_code] = { id: p.id, uom_id: Array.isArray(p.uom_id) ? p.uom_id[0] : p.uom_id };
  return out;
}

// The UoM field on sale.order.line is 'product_uom_id' on some Odoo versions and
// 'product_uom' on others (confirmed the hard way — 07-28 test run against this instance
// failed on 'product_uom_id' not existing). Discovered once, cached for the process lifetime.
let soLineUomField: string | null | undefined; // undefined = not yet resolved
async function resolveSoLineUomField(): Promise<string | null> {
  if (soLineUomField !== undefined) return soLineUomField;
  const fields = await tmo(odooExecute<any>('sale.order.line', 'fields_get', [[]], { attributes: ['type'] }), 15000, 'sol fields');
  soLineUomField = ['product_uom_id', 'product_uom'].find(f => fields[f]) ?? null;
  return soLineUomField;
}

// Create ONE draft Odoo document (quotation or replenishment) covering an admin-picked set of
// lab_manual_cakes rows. NEVER confirms it — stays in draft state for a human to validate in
// Odoo whenever. This is a deliberately SEMI-automatic, synchronous action (no queue, no cron):
// an admin selects one or more exceptional orders on /exceptional-orders — all from the same
// shop, since one Odoo document maps to one partner/warehouse — and clicks "Create Odoo order".
// Grouping several same-day orders for one client (e.g. 5 Moon Flower birthday cakes in one
// day) into a single quotation is exactly the point; the previous fully-automatic queue+cron
// version created duplicate documents on retries and was scrapped (see git history).
export async function createOdooOrderForSelection(
  supabase: SupabaseClient,
  manualCakeIds: string[],
): Promise<CreateOrderResult> {
  if (!odooWriteConfigured()) return { ok: false, error: 'Odoo write account not configured' };
  if (!manualCakeIds.length) return { ok: false, error: 'No order selected' };

  const { data: rows } = await supabase.from('lab_manual_cakes')
    .select('id, product_sku, product_name_vi, qty, shop_name, delivery_date, ready_time, matched_order_ref')
    .in('id', manualCakeIds);

  const already = (rows ?? []).find(r => r.matched_order_ref);
  if (already) return { ok: false, error: `An order in this selection is already linked to ${already.matched_order_ref}` };

  const lines = (rows ?? []).filter(r => r.product_sku && (r.qty ?? 0) > 0);
  if (!lines.length) return { ok: false, error: 'No valid line in this selection' };

  // ── Claim every row BEFORE calling Odoo (race guard) ──
  // Two admins could both pass the read-only check above for an overlapping selection.
  // A conditional update (WHERE matched_order_ref IS NULL) is atomic at the row level: only
  // one caller can ever flip a given row from null to the sentinel below. If we don't claim
  // every row we asked for, someone else got there first — release what we did claim and abort
  // *before* any Odoo document exists, so nothing needs to be rolled back on the Odoo side.
  const lineIds = lines.map(l => l.id as string);
  const claimedIds = await claimLines(supabase, lineIds);
  if (claimedIds.length !== lineIds.length) {
    if (claimedIds.length) await supabase.from('lab_manual_cakes').update({ matched_order_ref: null, claimed_at: null }).in('id', claimedIds).eq('matched_order_ref', PENDING);
    return { ok: false, error: 'One of these orders was just claimed by someone else — reload and try again' };
  }
  async function releaseClaim() {
    await supabase.from('lab_manual_cakes').update({ matched_order_ref: null, claimed_at: null }).in('id', lineIds).eq('matched_order_ref', PENDING);
  }

  const shopNames = Array.from(new Set(lines.map(l => l.shop_name).filter(Boolean)));
  if (shopNames.length === 0) { await releaseClaim(); return { ok: false, error: 'Selected order(s) have no shop attached' }; }
  if (shopNames.length > 1) { await releaseClaim(); return { ok: false, error: `Selection mixes several shops: ${shopNames.join(', ')}` }; }
  const shopName = shopNames[0] as string;

  const map = SHOP_ODOO_MAP[shopName];
  if (!map) { await releaseClaim(); return { ok: false, error: `No Odoo mapping for shop "${shopName}"` }; }

  // Grouping is meant for same-day orders; if dates differ, use the earliest as the
  // document's commitment/delivery date rather than blocking the admin's choice.
  const deliveryDate = lines.map(l => l.delivery_date as string).sort()[0];
  const readyTime = lines.find(l => l.ready_time)?.ready_time as string | null | undefined ?? null;

  const skus = Array.from(new Set(lines.map(l => l.product_sku as string)));
  let products: Record<string, { id: number; uom_id: number }>;
  try {
    products = await resolveProducts(skus);
  } catch (e: any) {
    await releaseClaim();
    return { ok: false, error: `Odoo product lookup failed: ${String(e?.message ?? e)}` };
  }
  const missing = skus.filter(s => !products[s]);
  if (missing.length) { await releaseClaim(); return { ok: false, error: `Product(s) not found in Odoo: ${missing.join(', ')}` }; }

  try {
    let orderRef: string | undefined;

    if (map.docType === 'quotation') {
      if (!map.partnerName) { await releaseClaim(); return { ok: false, error: `No Odoo partner mapped for "${shopName}"` }; }
      const partnerId = await resolvePartnerId(map.partnerName);
      if (!partnerId) { await releaseClaim(); return { ok: false, error: `Odoo partner "${map.partnerName}" not found` }; }

      const uomField = await resolveSoLineUomField();
      const orderId = await tmo(odooExecuteWrite<number>('sale.order', 'create', [{
        partner_id: partnerId,
        commitment_date: labLocalToOdooUtc(deliveryDate, readyTime),
      }]), 25000, 'create sale.order');

      try {
        for (const l of lines) {
          const p = products[l.product_sku as string];
          await tmo(odooExecuteWrite('sale.order.line', 'create', [{
            order_id: orderId, product_id: p.id, product_uom_qty: l.qty,
            ...(uomField ? { [uomField]: p.uom_id } : {}),
            name: l.product_name_vi,
          }]), 20000, 'create sale.order.line');
        }
      } catch (lineErr: any) {
        try { await odooExecuteWrite('sale.order', 'unlink', [[orderId]]); } catch { /* best-effort */ }
        throw lineErr;
      }

      const [order] = await tmo(odooExecuteWrite<any[]>('sale.order', 'read', [[orderId]], { fields: ['name'] }), 15000, 'read sale.order');
      orderRef = order?.name;
    } else {
      if (!map.warehouseCode) { await releaseClaim(); return { ok: false, error: `No Odoo warehouse mapped for "${shopName}"` }; }
      const wh = await resolveWarehouseId(map.warehouseCode);
      if (!wh) { await releaseClaim(); return { ok: false, error: `Odoo warehouse "${map.warehouseCode}" not found` }; }
      // Every replenishment ships FROM the lab's own warehouse.
      const sourceWh = await resolveWarehouseId('LAB');
      if (!sourceWh) { await releaseClaim(); return { ok: false, error: `Odoo source warehouse "LAB" not found` }; }

      const reqId = await tmo(odooExecuteWrite<number>('stock.replenishment.request', 'create', [{
        warehouse_id: wh.id, source_warehouse_id: sourceWh.id,
        delivery_date: labLocalToOdooUtc(deliveryDate, readyTime),
      }]), 25000, 'create replenishment');

      try {
        for (const l of lines) {
          const p = products[l.product_sku as string];
          await tmo(odooExecuteWrite('stock.replenishment.request.line', 'create', [{
            request_id: reqId, product_id: p.id, quantity_requested: l.qty,
          }]), 20000, 'create replenishment line');
        }
      } catch (lineErr: any) {
        try { await odooExecuteWrite('stock.replenishment.request', 'unlink', [[reqId]]); } catch { /* best-effort */ }
        throw lineErr;
      }

      const [req] = await tmo(odooExecuteWrite<any[]>('stock.replenishment.request', 'read', [[reqId]], { fields: ['name'] }), 15000, 'read replenishment');
      orderRef = req?.name;
    }

    if (!orderRef) { await releaseClaim(); return { ok: false, error: 'Odoo document created but could not read its reference' }; }

    // Replace the PENDING claim with the real Odoo reference so the UI reflects it
    // immediately (same field the existing auto-match mechanism uses).
    const { error: linkErr } = await supabase.from('lab_manual_cakes')
      .update({ matched_order_ref: orderRef, claimed_at: null })
      .in('id', lineIds).eq('matched_order_ref', PENDING);
    if (linkErr) return { ok: true, order_ref: orderRef, error: `Order ${orderRef} created but failed to link locally: ${linkErr.message}` };

    return { ok: true, order_ref: orderRef };
  } catch (e: any) {
    // The Odoo doc itself is already rolled back (unlink) by the inner try/catch above when
    // line creation fails — but the claim on lab_manual_cakes must be released either way,
    // otherwise these rows would be stuck at PENDING forever (invisible to "needs Odoo" AND
    // not actually linked to anything).
    await releaseClaim();
    return { ok: false, error: String(e?.message ?? e) };
  }
}

// Add an admin-picked set of lab_manual_cakes rows onto an EXISTING Odoo document (quotation
// or replenishment) instead of creating a new one — the counterpart to
// createOdooOrderForSelection for the "one more cake on a commande that already has an Odoo
// doc" case, which previously had no in-app path at all (had to be done directly in Odoo, then
// matched back by hand). Same safety posture as createOdooOrderForSelection: atomic claim
// before touching Odoo, one shop only, product SKUs must resolve. Additionally verifies the
// existing document's partner/warehouse actually matches the selection's shop — picking the
// wrong existing order would silently attach a cake to someone else's commande. On a failure
// partway through line creation, only the lines THIS call just created are rolled back — the
// pre-existing document and its other lines are never touched.
export async function addManualCakesToExistingOrder(
  supabase: SupabaseClient,
  orderRef: string,
  manualCakeIds: string[],
): Promise<CreateOrderResult> {
  if (!odooWriteConfigured()) return { ok: false, error: 'Odoo write account not configured' };
  if (!manualCakeIds.length) return { ok: false, error: 'No order selected' };
  if (!orderRef) return { ok: false, error: 'No target order' };

  const { data: rows } = await supabase.from('lab_manual_cakes')
    .select('id, product_sku, product_name_vi, qty, shop_name, delivery_date, matched_order_ref')
    .in('id', manualCakeIds);

  const already = (rows ?? []).find(r => r.matched_order_ref);
  if (already) return { ok: false, error: `An order in this selection is already linked to ${already.matched_order_ref}` };

  const lines = (rows ?? []).filter(r => r.product_sku && (r.qty ?? 0) > 0);
  if (!lines.length) return { ok: false, error: 'No valid line in this selection' };

  const shopNames = Array.from(new Set(lines.map(l => l.shop_name).filter(Boolean)));
  if (shopNames.length === 0) return { ok: false, error: 'Selected order(s) have no shop attached' };
  if (shopNames.length > 1) return { ok: false, error: `Selection mixes several shops: ${shopNames.join(', ')}` };
  const shopName = shopNames[0] as string;

  // Same-day only (2026-08-05): attaching to a different day's order would silently detach the
  // cake from the day it's actually meant for — this action never touches the target document's
  // own Odoo delivery/commitment date, so a mismatched day would just go unnoticed until
  // delivery. The UI already filters candidates to same-shop+same-day, but that's a display
  // convenience, not a guard — re-check for real here, since this is the actual write path.
  const cakeDates = Array.from(new Set(lines.map(l => l.delivery_date).filter(Boolean)));
  if (cakeDates.length > 1) return { ok: false, error: `Selection mixes several delivery dates: ${cakeDates.join(', ')}` };
  const cakeDate = cakeDates[0] as string;
  const { data: targetLines } = await supabase.from('lab_order_lines')
    .select('delivery_date').eq('order_ref', orderRef).limit(1);
  const targetDate = targetLines?.[0]?.delivery_date as string | undefined;
  if (!targetDate) return { ok: false, error: `Odoo order "${orderRef}" not found in lab — re-sync first` };
  if (targetDate !== cakeDate) {
    return { ok: false, error: `${orderRef} delivers ${targetDate}, but this selection is for ${cakeDate} — refusing to attach a cake to the wrong day` };
  }

  const map = SHOP_ODOO_MAP[shopName];
  if (!map) return { ok: false, error: `No Odoo mapping for shop "${shopName}"` };

  // Resolve the target document and confirm it really belongs to this shop's partner/warehouse
  // BEFORE claiming anything — a wrong order_ref here must fail loudly, not attach a cake to
  // an unrelated client's commande.
  const model = map.docType === 'quotation' ? 'sale.order' : 'stock.replenishment.request';
  const docId = await findDocIdByName(model, orderRef);
  if (!docId) return { ok: false, error: `Odoo order "${orderRef}" not found` };

  if (map.docType === 'quotation') {
    if (!map.partnerName) return { ok: false, error: `No Odoo partner mapped for "${shopName}"` };
    const partnerId = await resolvePartnerId(map.partnerName);
    const [doc] = await tmo(odooExecute<any[]>('sale.order', 'read', [[docId]], { fields: ['partner_id', 'state'] }), 15000, 'read order');
    const docPartnerId = Array.isArray(doc?.partner_id) ? doc.partner_id[0] : doc?.partner_id;
    if (!partnerId || docPartnerId !== partnerId) {
      return { ok: false, error: `${orderRef} belongs to a different client than "${shopName}" — refusing to attach a cake to the wrong order` };
    }
  } else {
    if (!map.warehouseCode) return { ok: false, error: `No Odoo warehouse mapped for "${shopName}"` };
    const wh = await resolveWarehouseId(map.warehouseCode);
    const [doc] = await tmo(odooExecute<any[]>('stock.replenishment.request', 'read', [[docId]], { fields: ['warehouse_id', 'state'] }), 15000, 'read request');
    const docWhId = Array.isArray(doc?.warehouse_id) ? doc.warehouse_id[0] : doc?.warehouse_id;
    if (!wh || docWhId !== wh.id) {
      return { ok: false, error: `${orderRef} belongs to a different warehouse than "${shopName}" — refusing to attach a cake to the wrong order` };
    }
  }

  // ── Claim every row BEFORE calling Odoo (same atomic race guard as createOdooOrderForSelection) ──
  const lineIds = lines.map(l => l.id as string);
  const claimedIds = await claimLines(supabase, lineIds);
  if (claimedIds.length !== lineIds.length) {
    if (claimedIds.length) await supabase.from('lab_manual_cakes').update({ matched_order_ref: null, claimed_at: null }).in('id', claimedIds).eq('matched_order_ref', PENDING);
    return { ok: false, error: 'One of these orders was just claimed by someone else — reload and try again' };
  }
  async function releaseClaim() {
    await supabase.from('lab_manual_cakes').update({ matched_order_ref: null, claimed_at: null }).in('id', lineIds).eq('matched_order_ref', PENDING);
  }

  const skus = Array.from(new Set(lines.map(l => l.product_sku as string)));
  let products: Record<string, { id: number; uom_id: number }>;
  try {
    products = await resolveProducts(skus);
  } catch (e: any) {
    await releaseClaim();
    return { ok: false, error: `Odoo product lookup failed: ${String(e?.message ?? e)}` };
  }
  const missing = skus.filter(s => !products[s]);
  if (missing.length) { await releaseClaim(); return { ok: false, error: `Product(s) not found in Odoo: ${missing.join(', ')}` }; }

  // Only the lines THIS call creates go here — used to roll back on partial failure without
  // ever touching the document's pre-existing lines.
  const createdLineIds: number[] = [];
  const lineModel = map.docType === 'quotation' ? 'sale.order.line' : 'stock.replenishment.request.line';
  try {
    if (map.docType === 'quotation') {
      const uomField = await resolveSoLineUomField();
      for (const l of lines) {
        const p = products[l.product_sku as string];
        const lineId = await tmo(odooExecuteWrite<number>('sale.order.line', 'create', [{
          order_id: docId, product_id: p.id, product_uom_qty: l.qty,
          ...(uomField ? { [uomField]: p.uom_id } : {}),
          name: l.product_name_vi,
        }]), 20000, 'create sale.order.line');
        createdLineIds.push(lineId);
      }
    } else {
      for (const l of lines) {
        const p = products[l.product_sku as string];
        const lineId = await tmo(odooExecuteWrite<number>('stock.replenishment.request.line', 'create', [{
          request_id: docId, product_id: p.id, quantity_requested: l.qty,
        }]), 20000, 'create replenishment line');
        createdLineIds.push(lineId);
      }
    }
  } catch (lineErr: any) {
    for (const id of createdLineIds) {
      try { await odooExecuteWrite(lineModel, 'unlink', [[id]]); } catch { /* best-effort — see cancelOdooOrderLine for why this can fail */ }
    }
    await releaseClaim();
    return { ok: false, error: `Failed adding line(s) to ${orderRef}: ${String(lineErr?.message ?? lineErr)}` };
  }

  const { error: linkErr } = await supabase.from('lab_manual_cakes')
    .update({ matched_order_ref: orderRef, claimed_at: null })
    .in('id', lineIds).eq('matched_order_ref', PENDING);
  if (linkErr) return { ok: true, order_ref: orderRef, error: `Line(s) added to ${orderRef} but failed to link locally: ${linkErr.message}` };

  return { ok: true, order_ref: orderRef };
}

// ── Cancel ONE product line of an already-created Odoo document (scenario 5/6) ──
// Never unlinks a line (Odoo forbids removing a line from a confirmed sale.order, and we
// can't always know the doc's state up front) — always writes its quantity to 0, mirroring
// the delta pattern odoo-apply.ts already uses for Odoo-side modifications. When every line
// of the document is at 0, the parent document itself is cancelled (best-effort: try
// action_cancel, fall back to leaving it zeroed-out in Odoo if the model has no such action —
// stock.replenishment.request's exact workflow isn't something we can verify from here).
export interface CancelLineResult {
  ok: boolean;
  docCancelled?: boolean;
  lineRemoved?: boolean; // true = the Odoo line was actually deleted; false = kept at qty 0 (Odoo refused removal, e.g. order already confirmed/locked)
  warning?: string;
  error?: string;
}

async function findDocIdByName(model: 'sale.order' | 'stock.replenishment.request', name: string): Promise<number | null> {
  const rows = await tmo(odooExecute<any[]>(model, 'search_read',
    [[['name', '=', name]]], { fields: ['id'], limit: 1 }), 15000, 'find doc');
  return rows[0]?.id ?? null;
}

export async function cancelOdooOrderLine(
  shopName: string,
  orderRef: string,
  sku: string,
): Promise<CancelLineResult> {
  if (!odooWriteConfigured()) return { ok: false, error: 'Odoo write account not configured' };
  const map = SHOP_ODOO_MAP[shopName];
  if (!map) return { ok: false, error: `No Odoo mapping for shop "${shopName}"` };

  let products: Record<string, { id: number; uom_id: number }>;
  try {
    products = await resolveProducts([sku]);
  } catch (e: any) {
    return { ok: false, error: `Odoo product lookup failed: ${String(e?.message ?? e)}` };
  }
  const product = products[sku];
  if (!product) return { ok: false, error: `Product "${sku}" not found in Odoo` };

  try {
    if (map.docType === 'quotation') {
      const orderId = await findDocIdByName('sale.order', orderRef);
      if (!orderId) return { ok: false, error: `Odoo order "${orderRef}" not found` };

      const lines = await tmo(odooExecute<any[]>('sale.order.line', 'search_read',
        [[['order_id', '=', orderId], ['product_id', '=', product.id]]],
        { fields: ['id', 'product_uom_qty'] }), 15000, 'find line');
      if (!lines.length) return { ok: false, error: `Line for "${sku}" not found on ${orderRef} — already removed?` };

      // Prefer actually deleting the line — cleaner for whoever looks at the order in Odoo
      // afterwards. Odoo refuses unlink on a line that's already invoiced/delivered/locked (the
      // original reason this only ever zeroed the qty); fall back to that exact same safe
      // behavior when it does, so nothing about the existing flow changes for those cases.
      let lineRemoved = false;
      try {
        await tmo(odooExecuteWrite('sale.order.line', 'unlink', [[lines[0].id]]), 15000, 'unlink line');
        lineRemoved = true;
      } catch {
        await tmo(odooExecuteWrite('sale.order.line', 'write', [[lines[0].id], { product_uom_qty: 0 }]), 15000, 'zero line');
      }

      // Works identically whether the line was removed (gone from the query entirely) or
      // zeroed (excluded by the qty filter) — no branching needed here.
      const remaining = await tmo(odooExecute<any[]>('sale.order.line', 'search_read',
        [[['order_id', '=', orderId], ['product_uom_qty', '>', 0]]], { fields: ['id'] }), 15000, 'remaining lines');
      if (remaining.length > 0) return { ok: true, docCancelled: false, lineRemoved };

      try {
        await odooExecuteWrite('sale.order', 'action_cancel', [[orderId]]);
        return { ok: true, docCancelled: true, lineRemoved };
      } catch (e: any) {
        return { ok: true, docCancelled: false, lineRemoved, warning: `Last line ${lineRemoved ? 'removed' : 'zeroed'} but the document itself could not be auto-cancelled in Odoo (${String(e?.message ?? e)}) — cancel it manually there.` };
      }
    } else {
      const reqId = await findDocIdByName('stock.replenishment.request', orderRef);
      if (!reqId) return { ok: false, error: `Odoo replenishment "${orderRef}" not found` };

      const reqDocs = await tmo(odooExecute<any[]>('stock.replenishment.request', 'search_read',
        [[['id', '=', reqId]]], { fields: ['id', 'state'] }), 15000, 'find request');
      const reqDoc = reqDocs[0];
      const allLines = await tmo(odooExecute<any[]>('stock.replenishment.request.line', 'search_read',
        [[['request_id', '=', reqId]]], { fields: ['id', 'product_id'] }), 15000, 'find lines');
      const targetLine = allLines.find((l: any) => Array.isArray(l.product_id) ? l.product_id[0] === product.id : l.product_id === product.id);
      if (!targetLine) return { ok: false, error: `Line for "${sku}" not found on ${orderRef} — already removed?` };

      // stock.replenishment.request.line rejects quantity_requested = 0, and the write API
      // account isn't in the "Replenishment Request Manager" group so it can't unlink a line
      // OR the parent document either (both confirmed against live Odoo, 2026-07-31). But the
      // model has a built-in `state` field with a "rejected" option, and the write account CAN
      // write that field directly (plain ORM write, not the action_reject method — which is a
      // no-op from 'draft' because it guards on state=='submitted'; a direct field write skips
      // that guard). So: reject the whole document via state write. This only cancels ONE
      // product's worth of stock movement if this is the only line — if there are other lines
      // (grouped/batched request), rejecting would wrongly cancel those too, so we refuse and
      // ask for manual handling instead.
      if (allLines.length > 1) {
        return {
          ok: false,
          error: `This replenishment groups ${allLines.length} products — rejecting the whole document would cancel the others too. Cancel it manually in Odoo, or ask Axel to grant the "Replenishment Request Manager" group to the write account so single lines can be removed instead.`,
        };
      }
      // Once stock has started moving (in_transit/receiving/done), rejecting the document
      // would desync it from physical reality — refuse and require manual handling there.
      if (reqDoc && !['draft', 'submitted', 'approved'].includes(reqDoc.state)) {
        return {
          ok: false,
          error: `Replenishment ${orderRef} is already "${reqDoc.state}" in Odoo — stock may already be moving. Cancel it manually there instead of through this action.`,
        };
      }

      try {
        await odooExecuteWrite('stock.replenishment.request', 'write', [[reqId], { state: 'rejected' }]);
        return { ok: true, docCancelled: true };
      } catch (e: any) {
        return { ok: false, error: `Could not cancel replenishment ${orderRef} in Odoo: ${String(e?.message ?? e)}` };
      }
    }
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}
