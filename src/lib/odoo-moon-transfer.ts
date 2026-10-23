// Transfers to / from Hoàn Kiếm (Moon Flower) — Axel, 2026-10-16, "option 1".
//
// Moon Flower is OUR shop but a real invoiced customer in Odoo (partner "MOON FLOWER", pricelist
// "Shops (VND)", no warehouse). So a transfer that touches it can't be an internal transfer:
//
//  • shop → Moon : a Moon sale.order delivered from the SENDING shop's warehouse (client_order_ref
//    = the TRF ref, no commitment_date so the production sync never imports it). Created +
//    confirmed at send time; at reception the delivery is validated at the received quantities
//    and a draft invoice is created (same "Regular invoice" wizard as the Lab's Moon deliveries).
//
//  • Moon → shop : nothing in Odoo at send time (the app only checks it CAN be done). At reception,
//    a RETURN on Moon's latest UNPAID Lab deliveries that carry the product, newest first, split
//    over several if needed, with the return's destination set to the receiving shop's stock.
//    Each touched invoice goes back to draft with its quantity lowered — no credit note, and no
//    negative line ever. Credit-note path on PAID deliveries exists but is OFF (ALLOW_CREDIT_NOTE).
//
// Moon pays its invoices in monthly batches (checked live 2026-10-16: everything since 1/09 is
// unpaid) and there is no accounting lock date, so an unpaid delivery is practically always there.
import { odooExecute, odooExecuteWrite, odooWriteConfigured } from './odoo';
import { SHOP_CONFIG } from './shops';
import { writeQuantitiesAndValidatePicking, type PlannedWrite } from './odoo-delivery-validate';

const NO_MAIL = { tracking_disable: true, mail_notrack: true, mail_create_nolog: true, mail_notify_force_send: false };
const LAB_WAREHOUSE_ID = 1;
const LAB_STOCK_LOCATION_ID = 8;
const LOOKBACK_DAYS = 75;

function tmo<T>(p: Promise<T>, ms: number, l: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, r) => setTimeout(() => r(new Error('timeout ' + l)), ms))]);
}

// A partner-type shop of ours (no warehouse, invoiced as a customer): today only Moon Flower.
export function isPartnerShop(shopName: string): boolean {
  const c = SHOP_CONFIG[shopName];
  return !!c && c.portalAccount && c.docType === 'quotation' && !!c.partnerName && !c.warehouseCode;
}

async function resolvePartnerId(shopName: string): Promise<number | { error: string }> {
  const name = SHOP_CONFIG[shopName]?.partnerName;
  if (!name) return { error: `${shopName}: no Odoo partner` };
  const rows = await tmo(odooExecute<any[]>('res.partner', 'search_read', [[['name', '=ilike', name]]], { fields: ['id'], limit: 2, order: 'id asc' }), 15000, 'partner');
  if (!rows[0]) return { error: `Odoo partner "${name}" not found` };
  return rows[0].id;
}

async function resolveWarehouse(code: string): Promise<{ id: number; stockLocationId: number; name: string } | { error: string }> {
  const rows = await tmo(odooExecute<any[]>('stock.warehouse', 'search_read', [[['code', '=', code]]], { fields: ['id', 'name', 'lot_stock_id'], limit: 1 }), 15000, 'warehouse');
  const w = rows[0];
  if (!w?.lot_stock_id) return { error: `Odoo warehouse ${code} not found` };
  return { id: w.id, name: w.name, stockLocationId: Array.isArray(w.lot_stock_id) ? w.lot_stock_id[0] : w.lot_stock_id };
}

async function productsBySku(skus: string[]): Promise<Map<string, { id: number; uomId: number }>> {
  const rows = skus.length ? await tmo(odooExecute<any[]>('product.product', 'search_read', [[['default_code', 'in', skus]]], { fields: ['id', 'default_code', 'uom_id'], limit: 2000 }), 20000, 'products') : [];
  return new Map(rows.filter(p => p.default_code).map(p => [p.default_code as string, { id: p.id, uomId: Array.isArray(p.uom_id) ? p.uom_id[0] : p.uom_id }]));
}

// ── shop → Moon ───────────────────────────────────────────────────────────────────────────────
export async function createSaleToPartnerShop(input: {
  fromWarehouseCode: string; toShop: string; ref: string; note?: string; lines: { sku: string; qty: number }[];
}): Promise<{ ok: true; soId: number; soName: string; pickingId: number; pickingName: string; assigned: boolean } | { ok: false; error: string }> {
  if (!odooWriteConfigured()) return { ok: false, error: 'Odoo write account not configured' };
  const partner = await resolvePartnerId(input.toShop);
  if (typeof partner !== 'number') return { ok: false, error: partner.error };
  const wh = await resolveWarehouse(input.fromWarehouseCode);
  if ('error' in wh) return { ok: false, error: wh.error };
  const prods = await productsBySku(input.lines.map(l => l.sku));
  const missing = input.lines.filter(l => !prods.has(l.sku)).map(l => l.sku);
  if (missing.length) return { ok: false, error: `Sản phẩm không tìm thấy trên Odoo: ${missing.join(', ')}` };
  let soId: number | undefined;
  try {
    soId = await tmo(odooExecuteWrite<number>('sale.order', 'create', [{
      partner_id: partner, warehouse_id: wh.id, client_order_ref: input.ref, origin: input.ref,
      ...(input.note?.trim() ? { note: input.note.trim() } : {}),
      order_line: input.lines.map(l => [0, 0, { product_id: prods.get(l.sku)!.id, product_uom_qty: l.qty }]),
    }], { context: NO_MAIL }), 30000, 'create so');
    await tmo(odooExecuteWrite('sale.order', 'action_confirm', [[soId]], { context: NO_MAIL }), 30000, 'confirm so');
    const [so] = await odooExecute<any[]>('sale.order', 'read', [[soId]], { fields: ['name', 'picking_ids', 'warehouse_id'] });
    const pickings = so?.picking_ids?.length ? await odooExecute<any[]>('stock.picking', 'read', [so.picking_ids], { fields: ['id', 'name', 'state', 'location_id'] }) : [];
    const pick = pickings.find(p => p.location_id?.[0] === wh.stockLocationId && p.state !== 'cancel');
    if (!pick) {
      await cancelSaleToPartnerShop(soId).catch(() => {});
      return { ok: false, error: `Odoo did not create the delivery from ${wh.name} (got ${pickings.map(p => p.name).join(', ') || 'none'}) — order cancelled` };
    }
    return { ok: true, soId, soName: so.name, pickingId: pick.id, pickingName: pick.name, assigned: pick.state === 'assigned' };
  } catch (e: any) {
    if (soId) await cancelSaleToPartnerShop(soId).catch(() => {});
    return { ok: false, error: `Odoo: ${e?.message ?? String(e)}` };
  }
}

export async function cancelSaleToPartnerShop(soId: number): Promise<{ ok: boolean; error?: string }> {
  try {
    const [so] = await odooExecute<any[]>('sale.order', 'read', [[soId]], { fields: ['state', 'picking_ids'] });
    if (!so) return { ok: false, error: `Odoo order #${soId} not found` };
    if (so.state === 'cancel') return { ok: true };
    const picks = so.picking_ids?.length ? await odooExecute<any[]>('stock.picking', 'read', [so.picking_ids], { fields: ['state', 'name'] }) : [];
    const done = picks.find(p => p.state === 'done');
    if (done) return { ok: false, error: `${done.name} đã xác nhận trên Odoo — không thể huỷ` };
    const res = await odooExecuteWrite<any>('sale.order', 'action_cancel', [[soId]], { context: { disable_cancel_warning: true, ...NO_MAIL } });
    if (res && typeof res === 'object' && res.res_model === 'sale.order.cancel') {
      const wiz = await odooExecuteWrite<number>('sale.order.cancel', 'create', [{ order_id: soId }], { context: NO_MAIL });
      await odooExecuteWrite('sale.order.cancel', 'action_cancel', [[wiz]], { context: NO_MAIL });
    }
    const [after] = await odooExecute<any[]>('sale.order', 'read', [[soId]], { fields: ['state'] });
    return after?.state === 'cancel' ? { ok: true } : { ok: false, error: `Odoo order still "${after?.state}" after cancel` };
  } catch (e: any) {
    return { ok: false, error: `Odoo: ${e?.message ?? String(e)}` };
  }
}

// Reception at Moon: validate the delivery at the received quantities, then draft invoice.
export async function receiveSaleToPartnerShop(soId: number, pickingId: number, received: { sku: string; qty: number }[]): Promise<{ ok: true; docs: string[]; warning?: string } | { ok: false; error: string }> {
  if (!odooWriteConfigured()) return { ok: false, error: 'Odoo write account not configured' };
  try {
    const [picking] = await odooExecute<any[]>('stock.picking', 'read', [[pickingId]], { fields: ['name', 'state'] });
    if (!picking) return { ok: false, error: `Odoo delivery #${pickingId} not found` };
    if (picking.state === 'cancel') return { ok: false, error: `${picking.name} đã bị huỷ trên Odoo` };
    const docs: string[] = [];
    if (picking.state !== 'done') {
      const moves = await odooExecute<any[]>('stock.move', 'search_read', [[['picking_id', '=', pickingId], ['state', 'not in', ['cancel', 'done']]]], { fields: ['id', 'product_id', 'product_uom_qty'] });
      const prods = await productsBySku(received.map(r => r.sku));
      const plan: PlannedWrite[] = [];
      for (const m of moves) {
        const sku = Array.from(prods.entries()).find(([, p]) => p.id === m.product_id?.[0])?.[0];
        const q = sku ? (received.find(r => r.sku === sku)?.qty ?? 0) : 0;
        plan.push({ sku: sku ?? String(m.product_id?.[0]), moveId: m.id, note: null, expectedQty: Number(m.product_uom_qty), deliverQty: Math.max(0, q) });
      }
      const w = await writeQuantitiesAndValidatePicking(pickingId, plan);
      if (!w.ok) return { ok: false, error: w.error };
    }
    docs.push(picking.name);
    // Invoice (draft) — idempotent: skip when the order already has a live invoice.
    const [so] = await odooExecute<any[]>('sale.order', 'read', [[soId]], { fields: ['invoice_ids', 'name'] });
    const existing = so?.invoice_ids?.length ? await odooExecute<any[]>('account.move', 'read', [so.invoice_ids], { fields: ['name', 'state'] }) : [];
    const live = existing.filter(i => i.state !== 'cancel');
    if (live.length) { docs.push(`${so.name} · ${live.map(i => i.name || 'draft').join(', ')}`); return { ok: true, docs }; }
    let warning: string | undefined;
    try {
      const wiz = await odooExecuteWrite<number>('sale.advance.payment.inv', 'create', [{ advance_payment_method: 'delivered', sale_order_ids: [[6, 0, [soId]]] }], { context: { active_ids: [soId], active_model: 'sale.order', ...NO_MAIL } });
      await odooExecuteWrite('sale.advance.payment.inv', 'create_invoices', [[wiz]], { context: { active_ids: [soId], active_model: 'sale.order', ...NO_MAIL } });
      const [after] = await odooExecute<any[]>('sale.order', 'read', [[soId]], { fields: ['invoice_ids'] });
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date());
      if (after?.invoice_ids?.length) {
        await odooExecuteWrite('account.move', 'write', [after.invoice_ids, { invoice_date: today }], { context: NO_MAIL }).catch(() => {});
        docs.push(`${so.name} · invoice (draft)`);
      } else warning = `${so.name}: no invoice created (nothing delivered?)`;
    } catch (e: any) {
      warning = `${so.name}: delivery validated but invoice creation failed — ${e?.message ?? e}`;
    }
    return { ok: true, docs, warning };
  } catch (e: any) {
    return { ok: false, error: `Odoo: ${e?.message ?? String(e)}` };
  }
}

// ── Moon → shop ───────────────────────────────────────────────────────────────────────────────
// refund=false → taken back on an UNPAID invoice (quantity lowered, no credit note).
// refund=true  → the covering invoice is already paid: return + DRAFT credit note (Axel, 2026-10-23).
type Allocation = { soId: number; soName: string; deliveryId: number; deliveryName: string; productId: number; sku: string; qty: number; refund: boolean };
const REFUND_LOOKBACK_DAYS = 240;
// Axel, 2026-10-23: credit notes stay the exception ("on essaie au max de pas faire d'avoir") —
// OFF in the app: a product covered only by paid deliveries is still refused at send, and the
// rare case is handled by hand in Odoo. Flip to true only on his explicit decision.
const ALLOW_CREDIT_NOTE = false;

// Which Moon deliveries can take back these quantities (newest first). Read-only.
// Unpaid deliveries first (no credit note); what is left goes on paid ones (credit note).
// 2026-10-23 fix: read the delivered MOVES of the requested products directly — the old
// "150 latest Moon orders" cap missed older deliveries (Moon has ~4 orders a day).
export async function planReturnFromPartnerShop(fromShop: string, lines: { sku: string; qty: number }[]): Promise<{ ok: true; allocations: Allocation[] } | { ok: false; error: string; short?: { sku: string; missing: number }[] }> {
  const partner = await resolvePartnerId(fromShop);
  if (typeof partner !== 'number') return { ok: false, error: partner.error };
  const prods = await productsBySku(lines.map(l => l.sku));
  const unknown = lines.filter(l => !prods.has(l.sku)).map(l => l.sku);
  if (unknown.length) return { ok: false, error: `Sản phẩm không tìm thấy trên Odoo: ${unknown.join(', ')}` };
  const since = new Date(Date.now() - REFUND_LOOKBACK_DAYS * 86400 * 1000).toISOString().slice(0, 19).replace('T', ' ');
  const pids = Array.from(new Set(Array.from(prods.values()).map(p => p.id)));
  const dMoves = await tmo(odooExecute<any[]>('stock.move', 'search_read',
    [[['product_id', 'in', pids], ['state', '=', 'done'], ['location_id', '=', LAB_STOCK_LOCATION_ID], ['location_dest_id.usage', '=', 'customer'],
      ['picking_id.partner_id', 'child_of', partner], ['picking_id.sale_id', '!=', false], ['date', '>=', since]]],
    { fields: ['id', 'picking_id', 'product_id', 'quantity', 'date'], order: 'date desc, id desc', limit: 2000 }), 20000, 'moon moves');
  const pickIds = Array.from(new Set(dMoves.map(m => m.picking_id[0]))) as number[];
  const picks = pickIds.length ? await odooExecute<any[]>('stock.picking', 'read', [pickIds], { fields: ['id', 'name', 'sale_id'] }) : [];
  const soIds = Array.from(new Set(picks.map(p => p.sale_id?.[0]).filter(Boolean))) as number[];
  const sos = soIds.length ? await odooExecute<any[]>('sale.order', 'read', [soIds], { fields: ['id', 'name', 'state', 'invoice_ids', 'warehouse_id'] }) : [];
  const soById = new Map(sos.filter(s => s.state === 'sale' && s.warehouse_id?.[0] === LAB_WAREHOUSE_ID).map(s => [s.id, s]));
  const invIds = Array.from(new Set(sos.flatMap(s => s.invoice_ids ?? []))) as number[];
  const invs = invIds.length ? await odooExecute<any[]>('account.move', 'read', [invIds], { fields: ['id', 'state', 'move_type', 'payment_state'] }) : [];
  const invById = new Map(invs.map(i => [i.id, i]));
  const live = (s: any) => (s.invoice_ids ?? []).map((id: number) => invById.get(id)).filter((i: any) => i && i.state !== 'cancel' && i.move_type === 'out_invoice');
  const unpaid = (s: any) => live(s).every((i: any) => i.payment_state === 'not_paid');
  const recentCut = new Date(Date.now() - LOOKBACK_DAYS * 86400 * 1000).toISOString().slice(0, 19).replace('T', ' ');
  const returned = dMoves.length ? await odooExecute<any[]>('stock.move', 'search_read',
    [[['origin_returned_move_id', 'in', dMoves.map(m => m.id)], ['state', '!=', 'cancel']]], { fields: ['origin_returned_move_id', 'product_uom_qty', 'quantity', 'state'] }) : [];
  const retByMove = new Map<number, number>();
  for (const r of returned) {
    const q = r.state === 'done' ? Number(r.quantity) : Number(r.product_uom_qty);
    retByMove.set(r.origin_returned_move_id[0], (retByMove.get(r.origin_returned_move_id[0]) ?? 0) + q);
  }
  type Cand = { deliveryId: number; deliveryName: string; productId: number; so: any; refund: boolean; avail: number; date: string };
  const cands: Cand[] = [];
  for (const m of dMoves) {
    const pk = picks.find(p => p.id === m.picking_id[0]);
    const so = pk?.sale_id ? soById.get(pk.sale_id[0]) : undefined;
    if (!so) continue;
    const isUnpaid = unpaid(so);
    // Unpaid: recent window only (as before). Paid (credit note): needs a posted invoice.
    if (isUnpaid && String(m.date) < recentCut) continue;
    if (!isUnpaid && (!ALLOW_CREDIT_NOTE || !live(so).some((i: any) => i.state === 'posted'))) continue;
    const avail = Number(m.quantity) - (retByMove.get(m.id) ?? 0);
    if (avail <= 0) continue;
    const ex = cands.find(c => c.deliveryId === pk.id && c.productId === m.product_id[0]);
    if (ex) ex.avail += avail;
    else cands.push({ deliveryId: pk.id, deliveryName: pk.name, productId: m.product_id[0], so, refund: !isUnpaid, avail, date: String(m.date) });
  }
  // unpaid first, then paid; newest first inside each group
  cands.sort((a, b) => Number(a.refund) - Number(b.refund) || (a.date < b.date ? 1 : a.date > b.date ? -1 : b.deliveryId - a.deliveryId));
  const allocations: Allocation[] = [];
  const short: { sku: string; missing: number }[] = [];
  for (const l of lines) {
    const pid = prods.get(l.sku)!.id;
    let left = l.qty;
    for (const c of cands) {
      if (left <= 0) break;
      if (c.productId !== pid || c.avail <= 0) continue;
      const q = Math.min(c.avail, left);
      c.avail -= q;
      left -= q;
      allocations.push({ soId: c.so.id, soName: c.so.name, deliveryId: c.deliveryId, deliveryName: c.deliveryName, productId: pid, sku: l.sku, qty: q, refund: c.refund });
    }
    if (left > 0) short.push({ sku: l.sku, missing: left });
  }
  if (short.length) {
    return { ok: false, short, error: `Không tìm thấy giao hàng Moon chưa thanh toán đủ cho: ${short.map(s => `${s.sku} (thiếu ${s.missing})`).join(', ')} — liên hệ Lab` };
  }
  return { ok: true, allocations };
}

// Paid invoice → DRAFT credit note for the returned quantities, same price / discount / taxes,
// linked to the sale lines (the order's invoiced qty follows the return). Never posted here.
async function draftCreditNote(soId: number, soName: string, qtyByProduct: Map<number, number>, skuOf: (pid: number) => string, returnName: string, ref: string, toCode: string): Promise<{ ok: true; label: string } | { ok: false; error: string }> {
  const [so] = await odooExecute<any[]>('sale.order', 'read', [[soId]], { fields: ['invoice_ids', 'partner_invoice_id'] });
  const invs = so?.invoice_ids?.length ? await odooExecute<any[]>('account.move', 'read', [so.invoice_ids], { fields: ['id', 'name', 'state', 'move_type', 'partner_id', 'journal_id'] }) : [];
  const inv = invs.filter(i => i.move_type === 'out_invoice' && i.state === 'posted').sort((a, b) => b.id - a.id)[0];
  if (!inv) return { ok: false, error: `${soName}: no posted invoice to credit` };
  const iLines = await odooExecute<any[]>('account.move.line', 'search_read', [[['move_id', '=', inv.id], ['display_type', '=', 'product']]],
    { fields: ['id', 'product_id', 'quantity', 'price_unit', 'discount', 'tax_ids', 'sale_line_ids', 'analytic_distribution', 'name'] });
  const cmds: any[] = [];
  for (const [pid, q] of Array.from(qtyByProduct.entries())) {
    const il = iLines.find(l => l.product_id?.[0] === pid);
    if (!il) return { ok: false, error: `${inv.name}: product ${skuOf(pid)} not on the invoice` };
    cmds.push([0, 0, {
      product_id: pid, name: il.name, quantity: q, price_unit: il.price_unit, discount: il.discount,
      tax_ids: [[6, 0, il.tax_ids ?? []]], sale_line_ids: [[6, 0, il.sale_line_ids ?? []]],
      ...(il.analytic_distribution ? { analytic_distribution: il.analytic_distribution } : {}),
    }]);
  }
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date());
  const rid = await odooExecuteWrite<number>('account.move', 'create', [{
    move_type: 'out_refund', partner_id: inv.partner_id?.[0], journal_id: inv.journal_id?.[0], reversed_entry_id: inv.id,
    invoice_origin: soName, ref: `${ref} — ${returnName} → ${toCode}`, invoice_date: today, invoice_line_ids: cmds,
  }], { context: NO_MAIL });
  const [cn] = await odooExecute<any[]>('account.move', 'read', [[rid]], { fields: ['name', 'amount_total', 'state'] });
  try {
    await odooExecuteWrite('account.move', 'message_post', [[rid]], { body: `Avoir brouillon créé par la lab-app — transfert ${ref} Moon → ${toCode}, retour ${returnName} sur ${soName} (${inv.name} déjà payée). À valider par la comptabilité. / Credit note nháp — chuyển kho ${ref}, hàng trả về ${toCode}.`, message_type: 'comment', subtype_xmlid: 'mail.mt_note' });
  } catch { /* note is best effort */ }
  return { ok: true, label: `${cn?.name && cn.name !== '/' ? cn.name : 'credit note'} (draft, −${Math.round(Number(cn?.amount_total ?? 0)).toLocaleString('en-US')}) on ${inv.name}` };
}

async function returnIntoLocation(deliveryId: number, qtyByProduct: Map<number, number>, destLocationId: number, origin: string): Promise<{ ok: true; name: string } | { ok: false; error: string }> {
  const dMoves = await odooExecute<any[]>('stock.move', 'search_read', [[['picking_id', '=', deliveryId], ['state', '=', 'done']]], { fields: ['id', 'product_id', 'quantity'] });
  const wizId = await odooExecuteWrite<number>('stock.return.picking', 'create', [{ picking_id: deliveryId }], { context: { active_id: deliveryId, active_ids: [deliveryId], active_model: 'stock.picking', ...NO_MAIL } });
  const wiz = await odooExecuteWrite<any[]>('stock.return.picking', 'read', [[wizId]], { fields: ['product_return_moves'] });
  const rLines = wiz[0]?.product_return_moves?.length ? await odooExecuteWrite<any[]>('stock.return.picking.line', 'read', [wiz[0].product_return_moves], { fields: ['id', 'product_id', 'move_id'] }) : [];
  const remaining = new Map(qtyByProduct);
  const cmds: any[] = [];
  for (const rl of rLines) {
    const pid = rl.product_id?.[0];
    const want = remaining.get(pid) ?? 0;
    const mv = dMoves.find(m => m.id === rl.move_id?.[0]);
    const q = Math.min(want, Number(mv?.quantity ?? want));
    remaining.set(pid, want - q);
    cmds.push([1, rl.id, { quantity: q, to_refund: q > 0 }]);
  }
  const short = Array.from(remaining.entries()).filter(([, q]) => q > 0);
  if (short.length) return { ok: false, error: `Return: product(s) ${short.map(([p]) => p).join(', ')} not on the delivery` };
  await odooExecuteWrite('stock.return.picking', 'write', [[wizId], { product_return_moves: cmds }], { context: NO_MAIL });
  let res: any;
  try { res = await odooExecuteWrite<any>('stock.return.picking', 'action_create_returns', [[wizId]], { context: NO_MAIL }); }
  catch { res = await odooExecuteWrite<any>('stock.return.picking', 'create_returns', [[wizId]], { context: NO_MAIL }); }
  const retId: number | undefined = res?.res_id;
  if (!retId) return { ok: false, error: `Return not created: ${JSON.stringify(res)}` };
  // Into the receiving shop's stock instead of LAB/Stock.
  await odooExecuteWrite('stock.picking', 'write', [[retId], { location_dest_id: destLocationId, origin }], { context: NO_MAIL });
  const rMoves = await odooExecuteWrite<any[]>('stock.move', 'search_read', [[['picking_id', '=', retId]]], { fields: ['id', 'product_uom_qty', 'move_line_ids'] });
  for (const m of rMoves) {
    await odooExecuteWrite('stock.move', 'write', [[m.id], { location_dest_id: destLocationId }], { context: NO_MAIL });
    if (m.move_line_ids?.length) await odooExecuteWrite('stock.move.line', 'write', [m.move_line_ids, { location_dest_id: destLocationId }], { context: NO_MAIL });
  }
  for (const m of rMoves) await odooExecuteWrite('stock.move', 'write', [[m.id], { quantity: m.product_uom_qty, picked: true }], { context: NO_MAIL });
  const fresh = await odooExecuteWrite<any[]>('stock.move', 'search_read', [[['picking_id', '=', retId]]], { fields: ['move_line_ids'] });
  const mlIds = fresh.flatMap(m => m.move_line_ids ?? []);
  if (mlIds.length) await odooExecuteWrite('stock.move.line', 'write', [mlIds, { location_dest_id: destLocationId }], { context: NO_MAIL });
  const v = await odooExecuteWrite<any>('stock.picking', 'button_validate', [[retId]], { context: { skip_backorder: true, cancel_backorder: true, ...NO_MAIL } });
  const [ret] = await odooExecuteWrite<any[]>('stock.picking', 'read', [[retId]], { fields: ['name', 'location_dest_id'] });
  if (v !== true) return { ok: false, error: `Return ${ret?.name ?? retId} created but not validated: ${JSON.stringify(v)}` };
  if (ret?.location_dest_id?.[0] !== destLocationId) return { ok: false, error: `Return ${ret?.name} validated into ${ret?.location_dest_id?.[1]} instead of the shop — check in Odoo` };
  return { ok: true, name: ret?.name ?? String(retId) };
}

// Reception at the shop of goods sent by Moon.
export async function receiveReturnFromPartnerShop(input: { fromShop: string; toWarehouseCode: string; ref: string; lines: { sku: string; qty: number }[] }): Promise<{ ok: true; docs: string[] } | { ok: false; error: string; docs: string[] }> {
  const docs: string[] = [];
  if (!odooWriteConfigured()) return { ok: false, error: 'Odoo write account not configured', docs };
  const lines = input.lines.filter(l => l.qty > 0);
  if (!lines.length) return { ok: true, docs };
  try {
    const wh = await resolveWarehouse(input.toWarehouseCode);
    if ('error' in wh) return { ok: false, error: wh.error, docs };
    const plan = await planReturnFromPartnerShop(input.fromShop, lines);
    if (!plan.ok) return { ok: false, error: plan.error, docs };
    const byDelivery = new Map<number, Allocation[]>();
    for (const a of plan.allocations) byDelivery.set(a.deliveryId, [...(byDelivery.get(a.deliveryId) ?? []), a]);
    for (const [deliveryId, allocs] of Array.from(byDelivery.entries())) {
      const qty = new Map<number, number>();
      for (const a of allocs) qty.set(a.productId, (qty.get(a.productId) ?? 0) + a.qty);
      const r = await returnIntoLocation(deliveryId, qty, wh.stockLocationId, input.ref);
      if (!r.ok) return { ok: false, error: r.error, docs };
      docs.push(`${r.name} (${allocs[0].soName})`);
      if (allocs[0].refund) {
        const cn = await draftCreditNote(allocs[0].soId, allocs[0].soName, qty, pid => allocs.find(a => a.productId === pid)?.sku ?? String(pid), r.name, input.ref, input.toWarehouseCode);
        if (!cn.ok) return { ok: false, error: `${r.name} validated but credit note failed: ${cn.error}`, docs };
        docs.push(cn.label);
        continue;
      }
      // Invoice of that order: back to draft, quantity lowered. Left in DRAFT for accounting.
      const [so] = await odooExecute<any[]>('sale.order', 'read', [[allocs[0].soId]], { fields: ['invoice_ids'] });
      const invs = so?.invoice_ids?.length ? await odooExecute<any[]>('account.move', 'read', [so.invoice_ids], { fields: ['id', 'name', 'state', 'move_type'] }) : [];
      const inv = invs.filter(i => i.move_type === 'out_invoice' && i.state !== 'cancel').sort((a, b) => b.id - a.id)[0];
      if (!inv) { docs.push(`${allocs[0].soName}: chưa có hóa đơn`); continue; }
      if (inv.state === 'posted') await odooExecuteWrite('account.move', 'button_draft', [[inv.id]], { context: NO_MAIL });
      const iLines = await odooExecute<any[]>('account.move.line', 'search_read', [[['move_id', '=', inv.id], ['display_type', '=', 'product']]], { fields: ['id', 'product_id', 'quantity'] });
      const cmds: any[] = [];
      const changes: { code: string; name?: string; from: number; to: number }[] = [];
      for (const [pid, q] of Array.from(qty.entries())) {
        const il = iLines.find(l => l.product_id?.[0] === pid);
        if (!il) continue;
        const to = Math.max(0, Number(il.quantity) - q);
        cmds.push([1, il.id, { quantity: to }]);
        const label = String(il.product_id?.[1] ?? '');
        const code = allocs.find(a => a.productId === pid)?.sku ?? (label.match(/^\[([^\]]+)\]/)?.[1] ?? String(pid));
        changes.push({ code, name: label.replace(/^\[[^\]]*\]\s*/, ''), from: Number(il.quantity), to });
      }
      if (cmds.length) {
        await odooExecuteWrite('account.move', 'write', [[inv.id], { invoice_line_ids: cmds }], { context: NO_MAIL });
        const { postInvoiceNote } = await import('@/lib/odoo-invoice-note');
        const noted = await postInvoiceNote({
          invoiceId: inv.id, orderRef: allocs[0].soName, changes, docs: [`return / trả hàng ${r.name} → ${input.toWarehouseCode}`, input.ref],
          reasonEn: `stock transfer ${input.fromShop} → ${input.toWarehouseCode}, goods returned to the receiving shop`,
          reasonVi: `chuyển hàng ${input.fromShop} → ${input.toWarehouseCode}, hàng trả về kho shop nhận`,
        });
        if (!noted) docs.push(`${allocs[0].soName}: ghi chú hóa đơn lỗi`);
      }
      docs.push(`${inv.name || allocs[0].soName}: −${allocs.map(a => `${a.sku}×${a.qty}`).join(', ')} (draft)`);
    }
    return { ok: true, docs };
  } catch (e: any) {
    return { ok: false, error: `Odoo: ${e?.message ?? String(e)}`, docs };
  }
}
