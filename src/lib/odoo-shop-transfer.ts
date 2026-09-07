import { odooExecute, odooExecuteWrite, odooWriteConfigured } from '@/lib/odoo';
import { SHOP_CONFIG } from '@/lib/shops';
import { writeQuantitiesAndValidatePicking, type PlannedWrite } from '@/lib/odoo-delivery-validate';

// Inter-shop stock transfers (Axel, 2026-09-07: "transferts de stock entre shops … et que ça se
// fasse sur Odoo aussi"). Option A of the study: ONE standard Odoo internal transfer
// (stock.picking, operation type = the SOURCE warehouse's "Internal Transfers") from
// <A>/Stock to <B>/Stock. Created + confirmed when the sending shop's manager validates in the
// portal; quantities written and picking validated when the receiving shop confirms what it
// actually got — that validation is the only moment stock moves in Odoo. No sale.order, no
// invoice, no stock.replenishment.request, so nothing here can ever reach the lab's production
// queue (odoo-sync.ts reads SO/REP only) or the shop's POS revenue.
//
// Scope: the four La Paris shops (SHOP_CONFIG entries with a warehouseCode). Moon Flower is an
// external partner with no Odoo warehouse and is refused on both sides. Every warehouse / type /
// product id is resolved dynamically by code — never hard-coded (same rule as odoo-scrap.ts).
//
// Auth is the caller's job (src/app/shop/actions.ts checks the manager PIN before creating, and
// the shop session before receiving/cancelling) — this module trusts its caller.

function tmo<T>(p: Promise<T>, ms: number, l: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, r) => setTimeout(() => r(new Error('timeout ' + l)), ms))]);
}

const NO_MAIL_CONTEXT = { tracking_disable: true, mail_notrack: true, mail_create_nolog: true, mail_notify_force_send: false };

export interface TransferLineInput { sku: string; name: string; qty: number; note?: string }

export interface TransferCreateResult {
  ok: boolean;
  pickingId?: number;
  pickingName?: string;
  moveIdBySku?: Record<string, number>;
  assigned?: boolean; // false when Odoo could not reserve (source warehouse short on Odoo stock) — not blocking
  error?: string;
}

type Warehouse = { id: number; name: string; code: string; stockLocationId: number; intTypeId: number | null };

export function transferWarehouseCode(shopName: string): string | null {
  const cfg = SHOP_CONFIG[shopName];
  if (!cfg || cfg.docType !== 'replenishment' || !cfg.warehouseCode) return null;
  return cfg.warehouseCode;
}

async function resolveWarehouse(shopName: string): Promise<Warehouse | { error: string }> {
  const code = transferWarehouseCode(shopName);
  if (!code) return { error: `"${shopName}" không có kho Odoo — không thể chuyển kho` };
  const rows = await tmo(odooExecute<any[]>('stock.warehouse', 'search_read',
    [[['code', '=', code]]], { fields: ['id', 'name', 'code', 'lot_stock_id', 'int_type_id'], limit: 1 }), 15000, 'warehouse');
  const w = rows[0];
  if (!w?.lot_stock_id) return { error: `Kho Odoo "${code}" (${shopName}) không tìm thấy` };
  return {
    id: w.id, name: w.name, code: w.code,
    stockLocationId: Array.isArray(w.lot_stock_id) ? w.lot_stock_id[0] : w.lot_stock_id,
    intTypeId: w.int_type_id ? (Array.isArray(w.int_type_id) ? w.int_type_id[0] : w.int_type_id) : null,
  };
}

// The source warehouse's internal-transfer operation type. Odoo creates one per warehouse but
// may archive it when multi-step routes are off — checked with active_test:false so an archived
// type is reported precisely (unarchive in Inventory > Configuration > Operation Types) instead
// of silently picking some other type.
async function resolveInternalPickingType(wh: Warehouse): Promise<{ id: number; name: string } | { error: string }> {
  if (wh.intTypeId) {
    const rows = await tmo(odooExecute<any[]>('stock.picking.type', 'search_read',
      [[['id', '=', wh.intTypeId]]], { fields: ['id', 'name', 'active', 'code'], context: { active_test: false }, limit: 1 }), 15000, 'picking type');
    const t = rows[0];
    if (t?.active && t.code === 'internal') return { id: t.id, name: t.name };
  }
  const alt = await tmo(odooExecute<any[]>('stock.picking.type', 'search_read',
    [[['warehouse_id', '=', wh.id], ['code', '=', 'internal']]], { fields: ['id', 'name'], limit: 1 }), 15000, 'picking type alt');
  if (alt[0]) return { id: alt[0].id, name: alt[0].name };
  return { error: `Loại hoạt động "Chuyển nội bộ" (Internal Transfers) chưa được bật cho kho ${wh.name} trên Odoo — cần bật (bỏ lưu trữ) trong Inventory › Configuration › Operation Types` };
}

async function resolveProducts(skus: string[]): Promise<Record<string, { id: number; uomId: number; displayName: string }>> {
  if (!skus.length) return {};
  const rows = await tmo(odooExecute<any[]>('product.product', 'search_read',
    [[['default_code', 'in', skus]]], { fields: ['id', 'default_code', 'uom_id', 'display_name'], limit: 2000 }), 20000, 'products');
  const out: Record<string, { id: number; uomId: number; displayName: string }> = {};
  for (const p of rows) {
    if (!p.default_code) continue;
    out[p.default_code] = { id: p.id, uomId: Array.isArray(p.uom_id) ? p.uom_id[0] : p.uom_id, displayName: String(p.display_name || p.default_code) };
  }
  return out;
}

// Creates the internal transfer A -> B and confirms it (draft -> confirmed/assigned). Leaves NO
// draft behind on failure: anything created before the confirm step succeeds is unlinked.
export async function createInterShopTransfer(
  fromShop: string, toShop: string, lines: TransferLineInput[], ref: string, note?: string,
): Promise<TransferCreateResult> {
  if (!odooWriteConfigured()) return { ok: false, error: 'Tài khoản Odoo ghi chưa được cấu hình' };
  if (fromShop === toShop) return { ok: false, error: 'Kho gửi và kho nhận phải khác nhau' };

  const [src, dst] = await Promise.all([resolveWarehouse(fromShop), resolveWarehouse(toShop)]);
  if ('error' in src) return { ok: false, error: src.error };
  if ('error' in dst) return { ok: false, error: dst.error };

  const type = await resolveInternalPickingType(src);
  if ('error' in type) return { ok: false, error: type.error };

  // One move per SKU — merge duplicates so the reception plan is always unambiguous.
  const merged = new Map<string, TransferLineInput>();
  for (const l of lines) {
    const sku = l.sku.trim();
    if (!sku || !(l.qty > 0)) continue;
    const cur = merged.get(sku);
    if (cur) { cur.qty += l.qty; if (l.note && !cur.note) cur.note = l.note; }
    else merged.set(sku, { sku, name: l.name, qty: l.qty, note: l.note });
  }
  const valid = Array.from(merged.values());
  if (!valid.length) return { ok: false, error: 'Không có sản phẩm nào để chuyển' };

  const products = await resolveProducts(valid.map(l => l.sku));
  const missing = valid.filter(l => !products[l.sku]).map(l => l.sku);
  if (missing.length) return { ok: false, error: `Sản phẩm không tìm thấy trên Odoo: ${missing.join(', ')}` };

  let pickingId: number | undefined;
  let confirmed = false;
  try {
    pickingId = await tmo(odooExecuteWrite<number>('stock.picking', 'create', [{
      picking_type_id: type.id,
      location_id: src.stockLocationId,
      location_dest_id: dst.stockLocationId,
      origin: ref,
      ...(note?.trim() ? { note: note.trim() } : {}),
    }], { context: NO_MAIL_CONTEXT }), 25000, 'create picking');

    const moveIdBySku: Record<string, number> = {};
    for (const l of valid) {
      const p = products[l.sku];
      const lineNote = l.note?.trim();
      const moveId = await tmo(odooExecuteWrite<number>('stock.move', 'create', [{
        name: p.displayName,
        product_id: p.id,
        product_uom: p.uomId,
        product_uom_qty: l.qty,
        picking_id: pickingId,
        picking_type_id: type.id,
        location_id: src.stockLocationId,
        location_dest_id: dst.stockLocationId,
        ...(lineNote ? { description_picking: lineNote } : {}),
      }], { context: NO_MAIL_CONTEXT }), 20000, 'create move');
      moveIdBySku[l.sku] = moveId;
    }

    await tmo(odooExecuteWrite('stock.picking', 'action_confirm', [[pickingId]], { context: NO_MAIL_CONTEXT }), 25000, 'confirm picking');
    confirmed = true;

    // Reservation is best-effort: a shop whose Odoo stock is short still sends the physical
    // goods; the picking just stays "confirmed" (waiting) until reception, where the real
    // quantities are written. Surfaced as assigned:false, never as a failure.
    let assigned = true;
    try {
      await tmo(odooExecuteWrite('stock.picking', 'action_assign', [[pickingId]], { context: NO_MAIL_CONTEXT }), 25000, 'assign picking');
      const [after] = await tmo(odooExecute<any[]>('stock.picking', 'read', [[pickingId]], { fields: ['name', 'state'] }), 15000, 'read picking');
      assigned = after?.state === 'assigned';
      return { ok: true, pickingId, pickingName: after?.name, moveIdBySku, assigned };
    } catch {
      const [after] = await tmo(odooExecute<any[]>('stock.picking', 'read', [[pickingId]], { fields: ['name', 'state'] }), 15000, 'read picking');
      return { ok: true, pickingId, pickingName: after?.name, moveIdBySku, assigned: false };
    }
  } catch (e: any) {
    if (pickingId && !confirmed) {
      try { await odooExecuteWrite('stock.picking', 'unlink', [[pickingId]]); } catch { /* best-effort */ }
    }
    return { ok: false, error: `Odoo: ${e?.message ?? String(e)}` };
  }
}

export interface TransferReceiveLine { sku: string; qtyReceived: number }

export interface TransferReceiveResult {
  ok: boolean;
  alreadyDone?: boolean;
  pickingName?: string;
  backorderWarning?: string;
  error?: string;
}

// Writes the received quantities on the picking's moves and validates it — same proven write /
// validate path as the lab delivery validation (writeQuantitiesAndValidatePicking: shortfalls
// shrink the demand so Odoo never spins a backorder). Received > sent is refused upstream.
export async function receiveInterShopTransfer(pickingId: number, lines: TransferReceiveLine[]): Promise<TransferReceiveResult> {
  if (!odooWriteConfigured()) return { ok: false, error: 'Tài khoản Odoo ghi chưa được cấu hình' };
  const pickings = await tmo(odooExecute<any[]>('stock.picking', 'search_read',
    [[['id', '=', pickingId]]], { fields: ['id', 'name', 'state'] }), 15000, 'read picking');
  const picking = pickings[0];
  if (!picking) return { ok: false, error: `Phiếu chuyển kho Odoo #${pickingId} không tìm thấy` };
  if (picking.state === 'done') return { ok: true, alreadyDone: true, pickingName: picking.name };
  if (picking.state === 'cancel') return { ok: false, error: `Phiếu ${picking.name} đã bị huỷ trên Odoo` };

  const moves = await tmo(odooExecute<any[]>('stock.move', 'search_read',
    [[['picking_id', '=', pickingId], ['state', 'not in', ['cancel', 'done']]]],
    { fields: ['id', 'product_id', 'product_uom_qty'] }), 15000, 'read moves');
  const productIds = Array.from(new Set(moves.map(m => m.product_id?.[0]).filter(Boolean))) as number[];
  const products = productIds.length
    ? await tmo(odooExecute<any[]>('product.product', 'read', [productIds], { fields: ['default_code'] }), 15000, 'read products')
    : [];
  const skuByProductId: Record<number, string> = {};
  for (const p of products) skuByProductId[p.id] = p.default_code || '';

  const moveBySku: Record<string, { moveId: number; expectedQty: number }> = {};
  for (const m of moves) {
    const sku = skuByProductId[m.product_id?.[0]];
    if (!sku) continue;
    const cur = moveBySku[sku];
    // One move per SKU by construction (createInterShopTransfer merges duplicates); if Odoo ever
    // split one, keep the larger and let the redistribution below handle it conservatively.
    if (!cur || Number(m.product_uom_qty) > cur.expectedQty) moveBySku[sku] = { moveId: m.id, expectedQty: Number(m.product_uom_qty ?? 0) };
  }

  const plan: PlannedWrite[] = [];
  const unknown: string[] = [];
  for (const l of lines) {
    const mv = moveBySku[l.sku];
    if (!mv) { unknown.push(l.sku); continue; }
    plan.push({ sku: l.sku, moveId: mv.moveId, note: null, expectedQty: mv.expectedQty, deliverQty: Math.max(0, l.qtyReceived) });
  }
  if (unknown.length) return { ok: false, error: `Sản phẩm không có trên phiếu Odoo ${picking.name}: ${unknown.join(', ')}` };
  // Moves the receiving shop did not list at all count as not received.
  for (const [sku, mv] of Object.entries(moveBySku)) {
    if (!plan.some(p => p.sku === sku)) plan.push({ sku, moveId: mv.moveId, note: null, expectedQty: mv.expectedQty, deliverQty: 0 });
  }
  if (!plan.some(p => p.deliverQty > 0)) return { ok: false, error: 'Không có sản phẩm nào được nhận — nếu không nhận được gì, kho gửi cần huỷ phiếu chuyển' };

  const written = await writeQuantitiesAndValidatePicking(pickingId, plan);
  if (!written.ok) return { ok: false, pickingName: picking.name, error: written.error };

  let backorderWarning: string | undefined;
  try {
    const bo = await tmo(odooExecute<any[]>('stock.picking', 'search_read',
      [[['backorder_id', '=', pickingId]]], { fields: ['name', 'state'] }), 15000, 'backorder check');
    if (bo.length) backorderWarning = `Odoo đã tạo phiếu dở dang ${bo.map(b => b.name).join(', ')} — cần kiểm tra thủ công`;
  } catch { /* diagnostic only */ }
  return { ok: true, pickingName: picking.name, backorderWarning };
}

export async function cancelInterShopTransfer(pickingId: number): Promise<{ ok: boolean; error?: string }> {
  if (!odooWriteConfigured()) return { ok: false, error: 'Tài khoản Odoo ghi chưa được cấu hình' };
  const [picking] = await tmo(odooExecute<any[]>('stock.picking', 'read', [[pickingId]], { fields: ['name', 'state'] }), 15000, 'read picking');
  if (!picking) return { ok: false, error: `Phiếu chuyển kho Odoo #${pickingId} không tìm thấy` };
  if (picking.state === 'done') return { ok: false, error: `Phiếu ${picking.name} đã được xác nhận nhận hàng trên Odoo — không thể huỷ` };
  if (picking.state === 'cancel') return { ok: true };
  try {
    await tmo(odooExecuteWrite('stock.picking', 'action_cancel', [[pickingId]], { context: NO_MAIL_CONTEXT }), 25000, 'cancel picking');
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: `Odoo: ${e?.message ?? String(e)}` };
  }
}
