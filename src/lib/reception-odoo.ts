// Shop reception gaps → Odoo (Axel, 2026-10-13). PREVIEW: plans only, never writes.
//
// "pour le moment je veux pas que ça impacte l'opérationnel": every function here READS Odoo
// (to build a concrete plan with real picking / move ids) and returns what it WOULD do. The live
// path is gated twice — RECEPTION_ODOO_LIVE=1 AND VERCEL_ENV=production — and even then is not
// implemented yet: it only gets coded and tested once Axel has validated the flow on the preview.
//
// Odoo flow reminder: REP → LAB/OUT (LAB/Stock 8 → transit 13) → SHOP/IN (transit 13 → shop).
// The SHOP/IN picking is found by origin = REP ref and source location = transit.
import { odooConfigured, odooExecute, odooExecuteWrite, odooWriteConfigured, ADJUST_REP_MARKER } from '@/lib/odoo';
import { writeQuantitiesAndValidatePicking, type PlannedWrite } from '@/lib/odoo-delivery-validate';

export const LAB_STOCK_LOCATION_ID = 8;
export const TRANSIT_LOCATION_ID = 13;

export type ReceptionOdooMode = 'simulated' | 'live';

export function receptionOdooMode(): ReceptionOdooMode {
  return process.env.RECEPTION_ODOO_LIVE === '1' && process.env.VERCEL_ENV === 'production' ? 'live' : 'simulated';
}

export type PlannedStep =
  | { op: 'set_move_qty'; pickingName: string; moveId: number; sku: string; product: string; demand: number; qty: number }
  | { op: 'validate_no_backorder'; pickingName: string; pickingId: number }
  | { op: 'move'; sku: string | null; product: string; qty: number; from: string; to: string }
  | { op: 'scrap'; sku: string | null; product: string; qty: number; location: string; reason: string }
  | { op: 'note'; text: string };

export type ReceptionPlan = { mode: ReceptionOdooMode; ok: boolean; error?: string; steps: PlannedStep[] };

// ── 1. Validate the shop IN at the GOOD quantity received ───────────────────────────────────
// good = received − damaged, never above what the Lab sent. Missing / damaged units stay in
// transit until the Lab decides (gap resolution) or the damaged unit is confirmed back at the Lab.
export async function planInValidation(
  orderRef: string,
  lines: { sku: string | null; product: string; sent: number; received: number; damaged: number }[],
): Promise<ReceptionPlan> {
  const mode = receptionOdooMode();
  if (!odooConfigured()) return { mode, ok: false, error: 'Odoo not configured', steps: [] };
  try {
    const pickings = await odooExecute<any[]>('stock.picking', 'search_read',
      [[['origin', '=', orderRef], ['location_id', '=', TRANSIT_LOCATION_ID], ['state', 'not in', ['done', 'cancel']]]],
      { fields: ['id', 'name', 'state'] });
    if (!pickings.length) return { mode, ok: false, error: `No open shop IN for ${orderRef}`, steps: [] };
    const steps: PlannedStep[] = [];
    for (const p of pickings) {
      const moves = await odooExecute<any[]>('stock.move', 'search_read',
        [[['picking_id', '=', p.id], ['state', 'not in', ['done', 'cancel']]]],
        { fields: ['id', 'product_id', 'product_uom_qty'] });
      const pids = Array.from(new Set(moves.map(m => m.product_id?.[0]).filter(Boolean))) as number[];
      const prods = pids.length ? await odooExecute<any[]>('product.product', 'read', [pids], { fields: ['default_code'] }) : [];
      const skuById: Record<number, string> = {};
      for (const pr of prods) skuById[pr.id] = pr.default_code || '';
      const remaining = new Map<string, number>();
      for (const l of lines) if (l.sku) {
        const good = Math.max(0, Math.min(l.received - l.damaged, l.sent));
        remaining.set(l.sku, (remaining.get(l.sku) ?? 0) + good);
      }
      for (const m of moves) {
        const sku = skuById[m.product_id?.[0]] ?? '';
        const demand = Number(m.product_uom_qty ?? 0);
        const left = remaining.get(sku) ?? 0;
        const qty = Math.min(left, demand);
        remaining.set(sku, left - qty);
        steps.push({ op: 'set_move_qty', pickingName: p.name, moveId: m.id, sku, product: m.product_id?.[1] ?? sku, demand, qty });
      }
      steps.push({ op: 'validate_no_backorder', pickingName: p.name, pickingId: p.id });
    }
    return { mode, ok: true, steps };
  } catch (e: any) {
    return { mode, ok: false, error: e?.message ?? String(e), steps: [] };
  }
}

// ── 2. Resolve one gap once the Lab has picked the cause ────────────────────────────────────
export type GapKind = 'missing' | 'extra' | 'damaged';
export type LabCause = 'found_at_lab' | 'damaged_returned' | 'lost_transport' | 'shop_miscount' | 'lab_sent_extra';

const LAB = 'LAB/Stock';
const TRANSIT = 'Transit';

export function planGapResolution(
  gap: { kind: GapKind; qty: number; sku: string | null; product: string; shop: string; sourceType?: string | null },
  cause: LabCause | 'returned_to_lab',
): ReceptionPlan {
  const mode = receptionOdooMode();
  const base = { sku: gap.sku, product: gap.product, qty: gap.qty };
  // Sales orders (Moon Flower, Axel 2026-10-14): no transit / shop IN — the delivery goes straight
  // from LAB/Stock to the customer and a draft invoice is created at validation, so every fix
  // is a return / extra delivery plus the matching change on the draft invoice.
  if (gap.sourceType === 'sales_order') {
    const CUSTOMER = 'Customer';
    const inv = (sign: string): PlannedStep => ({ op: 'note', text: `Draft invoice: ${sign}${gap.qty} ${gap.sku || gap.product}` });
    let so: PlannedStep[];
    switch (cause) {
      case 'found_at_lab': so = [{ op: 'move', ...base, from: CUSTOMER, to: LAB }, inv('−')]; break;
      case 'damaged_returned':
      case 'returned_to_lab':
      case 'lost_transport':
        so = [{ op: 'move', ...base, from: CUSTOMER, to: LAB }, { op: 'scrap', ...base, location: LAB, reason: 'Hỏng / mất khi giao (lỗi Lab)' }, inv('−')]; break;
      case 'lab_sent_extra': so = [{ op: 'move', ...base, from: LAB, to: CUSTOMER }, inv('+')]; break;
      default: so = [{ op: 'note', text: 'No Odoo action: the shop recounts the line' }];
    }
    return { mode, ok: true, steps: so };
  }
  const shopStock = `${gap.shop}/Stock`;
  let steps: PlannedStep[];
  switch (cause) {
    case 'found_at_lab':
      steps = [{ op: 'move', ...base, from: TRANSIT, to: LAB }];
      break;
    case 'damaged_returned': // the missing units came back broken: waits for the physical return
      steps = [{ op: 'note', text: 'Waits for the return to be confirmed in Stock reception (LỖI LAB)' }];
      break;
    case 'returned_to_lab': // return confirmed at the Lab → Lab loss
      steps = [
        { op: 'move', ...base, from: TRANSIT, to: LAB },
        { op: 'scrap', ...base, location: LAB, reason: 'Hỏng khi giao (lỗi Lab)' },
      ];
      break;
    case 'lost_transport':
      steps = [{ op: 'scrap', ...base, location: TRANSIT, reason: 'Mất khi vận chuyển' }];
      break;
    case 'lab_sent_extra':
      steps = [{ op: 'move', ...base, from: LAB, to: shopStock }];
      break;
    case 'shop_miscount':
      steps = [{ op: 'note', text: 'No Odoo action: the shop recounts the line' }];
      break;
  }
  return { mode, ok: true, steps };
}

// Live execution is intentionally absent from this preview build.
export async function executeReceptionPlan(plan: ReceptionPlan): Promise<ReceptionPlan> {
  if (plan.mode !== 'live') return plan; // simulated: the plan IS the result
  return { ...plan, ok: false, error: 'Live Odoo execution is not enabled in this build' };
}

// ── 3. LIVE: validate the shop IN (Axel, 2026-10-14) ───────────────────────────────────────
// "au moins que toutes les réceptions conformes se valident automatiquement. Si dans une
// réception il y a une nécessité de check du Lab alors la validation se fera du côté des
// assistantes dans la lab app." Called automatically when a shop finishes a conforming
// reception, and by the Lab's button otherwise. Writes ONLY on the production deployment
// (a Vercel preview shares the same Odoo) — RECEPTION_IN_AUTO=0 is the kill switch.
// Reuses writeQuantitiesAndValidatePicking (odoo-delivery-validate.ts): quantity per move,
// demand lowered to match when short so Odoo can't spin a backorder, then button_validate.
// Never guesses: anything unusual is SKIPPED with a reason and left to a human.
export function inValidationLive(): boolean {
  return process.env.VERCEL_ENV === 'production' && process.env.RECEPTION_IN_AUTO !== '0';
}

export type InValidationResult = {
  ok: boolean; live: boolean; skipped?: string; error?: string;
  pickingId?: number; pickingName?: string; alreadyDone?: boolean; plan: PlannedWrite[];
};

export async function validateShopIn(
  orderRef: string,
  lines: { sku: string | null; sent: number; received: number; damaged: number }[],
  opts: { dryRun?: boolean } = {},
): Promise<InValidationResult> {
  const live = inValidationLive() && !opts.dryRun;
  const plan: PlannedWrite[] = [];
  const skip = (skipped: string, extra: Partial<InValidationResult> = {}): InValidationResult => ({ ok: false, live, skipped, plan, ...extra });
  if (!odooConfigured() || !odooWriteConfigured()) return skip('odoo_not_configured');
  try {
    const pickings = await odooExecute<any[]>('stock.picking', 'search_read',
      [[['origin', '=', orderRef], ['location_id', '=', TRANSIT_LOCATION_ID], ['state', '!=', 'cancel']]],
      { fields: ['id', 'name', 'state'] });
    const open = pickings.filter(p => p.state !== 'done');
    if (!open.length) {
      return pickings.length ? { ok: true, live, alreadyDone: true, pickingName: pickings[0].name, plan } : skip('no_shop_in');
    }
    if (open.length > 1) return skip('several_shop_in');
    const picking = open[0];

    // The Lab's OUT must be validated first, otherwise the transit holds nothing to receive.
    const outs = await odooExecute<any[]>('stock.picking', 'search_read',
      [[['origin', '=', orderRef], ['location_dest_id', '=', TRANSIT_LOCATION_ID], ['state', '!=', 'cancel']]],
      { fields: ['id', 'state'] });
    if (!outs.length || outs.some(o => o.state !== 'done')) return skip('lab_out_not_validated', { pickingName: picking.name });
    // What the Lab's OUT REALLY moved into transit, per product (done quantity, not the demand):
    // an assistant may raise a line at the delivery check (REP/02103 BYK 2 → 3), Odoo then keeps
    // demand 2 / done 3 on the OUT and the IN still asks for 2 (2026-10-22).
    const outMoves = await odooExecute<any[]>('stock.move', 'search_read',
      [[['picking_id', 'in', outs.map(o => o.id)], ['state', '=', 'done']]],
      { fields: ['product_id', 'quantity'] });
    const outDoneByPid = new Map<number, number>();
    for (const m of outMoves) {
      const pid = m.product_id?.[0];
      if (pid) outDoneByPid.set(pid, (outDoneByPid.get(pid) ?? 0) + Number(m.quantity));
    }

    const moves = await odooExecute<any[]>('stock.move', 'search_read',
      [[['picking_id', '=', picking.id], ['state', 'not in', ['done', 'cancel']]]],
      { fields: ['id', 'product_id', 'product_uom_qty'] });
    const pids = Array.from(new Set(moves.map(m => m.product_id?.[0]).filter(Boolean))) as number[];
    const prods = pids.length ? await odooExecute<any[]>('product.product', 'read', [pids], { fields: ['default_code'] }) : [];
    const skuById: Record<number, string> = {};
    for (const pr of prods) skuById[pr.id] = pr.default_code || '';

    const good = new Map<string, number>();
    for (const l of lines) {
      if (!l.sku) continue;
      const g = Math.max(0, Math.min(l.received - l.damaged, l.sent));
      good.set(l.sku, (good.get(l.sku) ?? 0) + g);
    }
    const movesBySku = new Map<string, any[]>();
    for (const m of moves) {
      const sku = skuById[m.product_id?.[0]] ?? '';
      if (!sku || !good.has(sku)) return skip(`unmatched_product:${sku || m.product_id?.[1]}`, { pickingName: picking.name });
      movesBySku.set(sku, [...(movesBySku.get(sku) ?? []), m]);
    }
    for (const [sku, qty] of Array.from(good.entries())) {
      if (qty > 0 && !movesBySku.has(sku)) return skip(`missing_move:${sku}`, { pickingName: picking.name });
    }
    for (const [sku, ms] of Array.from(movesBySku.entries())) {
      const qty = good.get(sku) ?? 0;
      // Never receive more than the Lab's OUT really moved into transit (2026-10-20, REP/02079:
      // check edited 1 → 3 after the OUT was pushed at 1; the IN took 3 and transit went −2).
      // Cap = done quantity of the Lab's OUT (not the IN demand, which ignores upward adjustments).
      const outDone = outDoneByPid.get(ms[0].product_id?.[0]) ?? 0;
      if (qty > outDone) return skip(`over_lab_out:${sku}`, { pickingName: picking.name });
      if (ms.length === 1) {
        // qty may exceed the IN demand when the Lab raised the line: writing quantity > demand lets
        // Odoo validate the extra (no backorder, demand untouched).
        plan.push({ sku, moveId: ms[0].id, note: null, expectedQty: Number(ms[0].product_uom_qty), deliverQty: qty });
        continue;
      }
      const demandSum = ms.reduce((t, m) => t + Number(m.product_uom_qty), 0);
      if (qty !== demandSum) return skip(`ambiguous_split:${sku}`, { pickingName: picking.name });
      for (const m of ms) plan.push({ sku, moveId: m.id, note: null, expectedQty: Number(m.product_uom_qty), deliverQty: Number(m.product_uom_qty) });
    }
    if (!live) return { ok: true, live, pickingId: picking.id, pickingName: picking.name, plan };
    const res = await writeQuantitiesAndValidatePicking(picking.id, plan);
    if (!res.ok) return { ok: false, live, error: res.error, pickingId: picking.id, pickingName: picking.name, plan };
    return { ok: true, live, pickingId: picking.id, pickingName: picking.name, plan };
  } catch (e: any) {
    return { ok: false, live, error: e?.message ?? String(e), plan };
  }
}

// ── 4. LIVE: sales orders (Moon Flower) — final "Envoyer à Odoo" (Axel, 2026-10-14) ──────────
// Double validation: the assistants settle every gap line by line in the app, then ONE click per
// order sends everything to Odoo at once:
//   1. one return (stock.return.picking, to_refund) of the delivery for every unit that is not at
//      the customer: found at the Lab, damaged (returned) or lost;
//   2. a LAB/Stock scrap for the damaged / lost units (Lab loss);
//   3. one extra delivery (LAB/Stock → customer, linked to the SO line) for units the Lab sent
//      too many;
//   4. the customer invoice goes back to DRAFT and its quantities are adjusted (no credit note,
//      Axel 2026-10-14). Never re-posted by us: accounting validates it again.
// Production only (inValidationLive); anything unexpected stops before writing.
export type SoGapLine = { sku: string; qty: number; action: 'return' | 'return_scrap' | 'extra' };
export type SoFinalizeResult = { ok: boolean; live: boolean; error?: string; done: string[] };

async function recordName(model: string, id: number | undefined): Promise<string> {
  if (!id) return '?';
  try { const [r] = await odooExecute<any[]>(model, 'read', [[id]], { fields: ['name'] }); return r?.name || String(id); } catch { return String(id); }
}

const NO_MAIL = { tracking_disable: true, mail_notrack: true, mail_create_nolog: true, mail_notify_force_send: false };

// Return (stock.return.picking) of a VALIDATED delivery — the only move Odoo nets out of the REP /
// SO "quantity sent" (checked live on REP/2026/01854: OUT 10 − return 5 → line sent 5, request Done).
// Returns go back to the delivery's source (LAB/Stock). toRefund only matters for sales orders.
async function returnFromDelivery(deliveryId: number, qtyByProduct: Map<number, number>, toRefund: boolean): Promise<{ ok: true; name: string } | { ok: false; error: string }> {
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
    cmds.push([1, rl.id, { quantity: q, to_refund: toRefund && q > 0 }]);
  }
  const short = Array.from(remaining.entries()).filter(([, q]) => q > 0);
  if (short.length) return { ok: false, error: `Return: product(s) ${short.map(([p]) => p).join(', ')} not on the delivery` };
  await odooExecuteWrite('stock.return.picking', 'write', [[wizId], { product_return_moves: cmds }], { context: NO_MAIL });
  let res: any;
  try { res = await odooExecuteWrite<any>('stock.return.picking', 'action_create_returns', [[wizId]], { context: NO_MAIL }); }
  catch { res = await odooExecuteWrite<any>('stock.return.picking', 'create_returns', [[wizId]], { context: NO_MAIL }); }
  const retId: number | undefined = res?.res_id;
  if (!retId) return { ok: false, error: `Return not created: ${JSON.stringify(res)}` };
  const rMoves = await odooExecuteWrite<any[]>('stock.move', 'search_read', [[['picking_id', '=', retId]]], { fields: ['id', 'product_uom_qty'] });
  // Return moves of a chained delivery come back 'waiting': set the quantity AND picked (checked live 15/10).
  for (const m of rMoves) await odooExecuteWrite('stock.move', 'write', [[m.id], { quantity: m.product_uom_qty, picked: true }], { context: NO_MAIL });
  const v = await odooExecuteWrite<any>('stock.picking', 'button_validate', [[retId]], { context: { skip_backorder: true, cancel_backorder: true, ...NO_MAIL } });
  const [ret] = await odooExecuteWrite<any[]>('stock.picking', 'read', [[retId]], { fields: ['name'] });
  if (v !== true) return { ok: false, error: `Return ${ret?.name ?? retId} created but not validated: ${JSON.stringify(v)}` };
  return { ok: true, name: ret?.name ?? String(retId) };
}

export async function finalizeSalesOrderGaps(
  orderRef: string, lines: SoGapLine[],
  opts: { reasonEn?: string; reasonVi?: string; byName?: string } = {},
): Promise<SoFinalizeResult> {
  const live = inValidationLive();
  const done: string[] = [];
  const docNames: string[] = []; // for the invoice note
  if (!odooWriteConfigured()) return { ok: false, live, error: 'Odoo write account not configured', done };
  if (!lines.length) return { ok: true, live, done: ['nothing to send'] };
  try {
    const sos = await odooExecute<any[]>('sale.order', 'search_read', [[['name', '=', orderRef]]], { fields: ['id', 'name', 'partner_id', 'picking_ids', 'order_line', 'invoice_ids'] });
    const so = sos[0];
    if (!so) return { ok: false, live, error: `${orderRef} not found in Odoo`, done };
    const pickings = so.picking_ids?.length ? await odooExecute<any[]>('stock.picking', 'read', [so.picking_ids], { fields: ['id', 'name', 'state', 'location_id', 'location_dest_id', 'picking_type_id'] }) : [];
    const delivery = pickings.find(p => p.state === 'done' && p.location_id?.[0] === LAB_STOCK_LOCATION_ID);
    if (!delivery) return { ok: false, live, error: 'No validated Lab delivery for this order (validate the delivery first)', done };

    const skus = Array.from(new Set(lines.map(l => l.sku)));
    const prods = await odooExecute<any[]>('product.product', 'search_read', [[['default_code', 'in', skus]]], { fields: ['id', 'default_code', 'uom_id'] });
    const prodBySku = new Map(prods.map(p => [p.default_code as string, p]));
    for (const s of skus) if (!prodBySku.has(s)) return { ok: false, live, error: `Product ${s} not found in Odoo`, done };

    const toReturn = new Map<number, number>(); // product id → qty
    const toScrap = new Map<number, number>();
    const extra = new Map<number, number>();
    for (const l of lines) {
      const pid = prodBySku.get(l.sku)!.id;
      if (l.action === 'extra') extra.set(pid, (extra.get(pid) ?? 0) + l.qty);
      else {
        toReturn.set(pid, (toReturn.get(pid) ?? 0) + l.qty);
        if (l.action === 'return_scrap') toScrap.set(pid, (toScrap.get(pid) ?? 0) + l.qty);
      }
    }

    // Check before writing: every returned product must be on the delivery with enough qty.
    const dMoves = await odooExecute<any[]>('stock.move', 'search_read', [[['picking_id', '=', delivery.id], ['state', '=', 'done']]], { fields: ['id', 'product_id', 'quantity', 'sale_line_id'] });
    for (const [pid, q] of Array.from(toReturn.entries())) {
      const deliv = dMoves.filter(m => m.product_id?.[0] === pid).reduce((t, m) => t + Number(m.quantity), 0);
      if (deliv < q) return { ok: false, live, error: `Return ${q} > delivered ${deliv} for product ${pid}`, done };
    }
    const soLinesFull = so.order_line?.length ? await odooExecute<any[]>('sale.order.line', 'read', [so.order_line], { fields: ['id', 'product_id', 'price_unit', 'discount', 'tax_id'] }) : [];
    const soLines = soLinesFull;
    for (const pid of Array.from(extra.keys())) if (!soLines.some(l => l.product_id?.[0] === pid)) return { ok: false, live, error: `Extra product ${pid} is not on the order`, done };

    // Axel, 2026-10-23: an invoice that already carries its e-invoice VAT number is NEVER changed.
    //  • Moon (our shop, invoiced as a customer): missing / damaged → Moon pays (stock only, the
    //    return is not "to refund"); extra → a small separate sale.
    //  • other customers: stock as usual, invoice untouched, note "cần hoá đơn điều chỉnh".
    const invIds0: number[] = so.invoice_ids ?? [];
    const invs0 = invIds0.length ? await odooExecute<any[]>('account.move', 'read', [invIds0], { fields: ['id', 'name', 'state', 'move_type', 'l10n_vn_e_invoice_number'] }) : [];
    const inv0 = invs0.filter(i => i.move_type === 'out_invoice' && i.state !== 'cancel').sort((a, b) => b.id - a.id)[0];
    const vatNo = inv0 && /vat/i.test(String(inv0.l10n_vn_e_invoice_number || '')) ? String(inv0.l10n_vn_e_invoice_number).trim() : null;
    const isMoon = /moon\s*flower/i.test(String(so.partner_id?.[1] ?? ''));

    if (!live) return { ok: true, live, done: [`return ${toReturn.size} product(s)`, `scrap ${toScrap.size}`, `extra ${extra.size}`, vatNo ? `invoice has ${vatNo} — not touched` : 'invoice back to draft, quantities adjusted'] };

    // 1. Return
    if (toReturn.size) {
      const r = await returnFromDelivery(delivery.id, toReturn, !(vatNo && isMoon));
      if (!r.ok) return { ok: false, live, error: r.error, done };
      done.push(`return ${r.name}`);
      docNames.push(`return / trả hàng ${r.name}`);
    }
    // 2. Scrap (Lab loss)
    if (toScrap.size) {
      const { createScrapAtLocation } = await import('@/lib/odoo-scrap');
      for (const [pid, q] of Array.from(toScrap.entries())) {
        const p = prods.find(x => x.id === pid);
        const r = await createScrapAtLocation(LAB_STOCK_LOCATION_ID, { productId: pid, uomId: p.uom_id?.[0], qty: q, reasonTagIds: [], origin: `${orderRef} — hỏng/mất khi giao (lỗi Lab)` });
        if (!r.ok) return { ok: false, live, error: `Scrap failed: ${r.error}`, done };
        const scrapName = await recordName('stock.scrap', r.scrapId);
        done.push(`scrap ${scrapName} · ${p.default_code} ×${q}`);
        docNames.push(`scrap ${scrapName}`);
      }
    }
    // 3. Extra delivery — after VAT: a small separate sale per product instead.
    if (extra.size && vatNo) {
      for (const [pid, q] of Array.from(extra.entries())) {
        const p = prods.find(x => x.id === pid);
        const r = await createExtraSalesOrder(orderRef, { id: pid, default_code: p.default_code }, q, new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date()));
        done.push(...r.done);
        if (!r.ok) return { ok: false, live, error: r.error, done };
      }
      extra.clear();
    }
    if (extra.size) {
      const pickId = await odooExecuteWrite<number>('stock.picking', 'create', [{
        picking_type_id: delivery.picking_type_id?.[0], location_id: LAB_STOCK_LOCATION_ID, location_dest_id: delivery.location_dest_id?.[0],
        partner_id: so.partner_id?.[0], origin: so.name,
        move_ids: Array.from(extra.entries()).map(([pid, q]) => {
          const p = prods.find(x => x.id === pid);
          const sl = soLines.find(l => l.product_id?.[0] === pid);
          return [0, 0, { name: p.default_code, product_id: pid, product_uom: p.uom_id?.[0], product_uom_qty: q, sale_line_id: sl.id, location_id: LAB_STOCK_LOCATION_ID, location_dest_id: delivery.location_dest_id?.[0] }];
        }),
      }], { context: NO_MAIL });
      await odooExecuteWrite('stock.picking', 'action_confirm', [[pickId]], { context: NO_MAIL });
      const eMoves = await odooExecuteWrite<any[]>('stock.move', 'search_read', [[['picking_id', '=', pickId]]], { fields: ['id', 'product_uom_qty'] });
      for (const m of eMoves) await odooExecuteWrite('stock.move', 'write', [[m.id], { quantity: m.product_uom_qty }], { context: NO_MAIL });
      const v = await odooExecuteWrite<any>('stock.picking', 'button_validate', [[pickId]], { context: { skip_backorder: true, cancel_backorder: true, ...NO_MAIL } });
      if (v !== true) return { ok: false, live, error: `Extra delivery created (id ${pickId}) but not validated: ${JSON.stringify(v)}`, done };
      const extraName = await recordName('stock.picking', pickId);
      done.push(`extra delivery ${extraName}`);
      docNames.push(`extra delivery / giao thêm ${extraName}`);
    }
    // 4. Invoice (Axel 2026-10-14: "pas d'avoir, faut passer la facture en draft et ajuster").
    // The existing customer invoice goes back to draft and its lines follow the quantities:
    // − returned / lost / damaged, + extra. Left in DRAFT: accounting re-posts it.
    if (vatNo && inv0) {
      const lost = Array.from(toReturn.entries()).map(([pid, q]) => `${prods.find(x => x.id === pid)?.default_code ?? pid} ×${q}`).join(', ');
      const body = isMoon
        ? `App Lab: hoá đơn đã xuất ${vatNo} nên KHÔNG sửa hoá đơn. ${lost ? `Hàng thiếu/hỏng (${lost}) chỉ xử lý tồn kho — Moon vẫn trả tiền (quy định của Axel 23/10/2026). ` : ''}${docNames.length ? 'Chứng từ: ' + docNames.join(', ') + '.' : ''}`
        : `App Lab: hoá đơn đã xuất ${vatNo} nên KHÔNG sửa hoá đơn. Chênh lệch khi nhận hàng${lost ? ` (${lost})` : ''} đã xử lý tồn kho — kế toán xem có cần hoá đơn điều chỉnh không. ${docNames.length ? 'Chứng từ: ' + docNames.join(', ') + '.' : ''}`;
      try { await odooExecuteWrite('account.move', 'message_post', [[inv0.id]], { body, message_type: 'comment', subtype_xmlid: 'mail.mt_note' }); } catch { done.push('invoice note NOT posted'); }
      done.push(`invoice ${inv0.name} has ${vatNo} — not changed${isMoon ? ' (Moon pays)' : ' (accounting: hoá đơn điều chỉnh?)'}`);
      return { ok: true, live, done };
    }
    const inv = inv0;
    if (!inv) { done.push('no invoice yet — nothing to adjust'); return { ok: true, live, done }; }
    if (inv.state === 'posted') {
      await odooExecuteWrite('account.move', 'button_draft', [[inv.id]], { context: NO_MAIL });
      done.push(`invoice ${inv.name} → draft`);
    }
    const iLines = await odooExecute<any[]>('account.move.line', 'search_read',
      [[['move_id', '=', inv.id], ['display_type', '=', 'product']]], { fields: ['id', 'product_id', 'quantity'] });
    const delta = new Map<number, number>();
    for (const [pid, q] of Array.from(toReturn.entries())) delta.set(pid, (delta.get(pid) ?? 0) - q);
    for (const [pid, q] of Array.from(extra.entries())) delta.set(pid, (delta.get(pid) ?? 0) + q);
    const cmds: any[] = [];
    const changes: { code: string; name?: string; from: number; to: number }[] = [];
    for (const [pid, d] of Array.from(delta.entries())) {
      if (!d) continue;
      const code = prods.find(x => x.id === pid)?.default_code ?? pid;
      const il = iLines.find(l => l.product_id?.[0] === pid);
      if (il) {
        const q = Math.max(0, Number(il.quantity) + d);
        cmds.push([1, il.id, { quantity: q }]);
        done.push(`invoice ${code}: ${il.quantity} → ${q}`);
        changes.push({ code: String(code), name: String(il.product_id?.[1] ?? '').replace(/^\[[^\]]*\]\s*/, ''), from: Number(il.quantity), to: q });
      } else if (d > 0) {
        const sl = soLinesFull.find(l => l.product_id?.[0] === pid);
        cmds.push([0, 0, { product_id: pid, quantity: d, price_unit: sl?.price_unit ?? 0, discount: sl?.discount ?? 0, tax_ids: [[6, 0, sl?.tax_id ?? []]], sale_line_ids: sl ? [[6, 0, [sl.id]]] : [] }]);
        done.push(`invoice ${code}: +${d} (new line)`);
        changes.push({ code: String(code), from: 0, to: d });
      } else done.push(`invoice ${code}: no line to lower`);
    }
    if (cmds.length) {
      await odooExecuteWrite('account.move', 'write', [[inv.id], { invoice_line_ids: cmds }], { context: NO_MAIL });
      const acts = new Set(lines.map(l => l.action));
      const why: [string, string][] = [];
      if (acts.has('return_scrap')) why.push(['damaged on arrival, Lab loss', 'hỏng khi nhận hàng, lỗi Lab']);
      if (acts.has('return')) why.push(['not received by the shop', 'shop không nhận được']);
      if (acts.has('extra')) why.push(['Lab sent more than ordered', 'Lab gửi dư']);
      const { postInvoiceNote } = await import('@/lib/odoo-invoice-note');
      const noted = await postInvoiceNote({
        invoiceId: inv.id, orderRef, byName: opts.byName, changes, docs: docNames,
        reasonEn: opts.reasonEn ?? (why.map(w => w[0]).join('; ') || 'reception gap'),
        reasonVi: opts.reasonVi ?? (why.map(w => w[1]).join('; ') || 'chênh lệch khi nhận hàng'),
      });
      if (!noted) done.push('invoice note NOT posted (Odoo error)');
    }
    done.push(`invoice ${inv.name} left in DRAFT — accounting re-posts it`);
    return { ok: true, live, done };
  } catch (e: any) {
    return { ok: false, live, error: e?.message ?? String(e), done };
  }
}

// ── 5. LIVE: replenishments (REP) — same "Gửi Odoo" button per order (Axel, 2026-10-14) ──────
// Prerequisite: the shop IN is validated at the GOOD quantity (done here if still open), so the
// missing / damaged units are still sitting in the transit location. Then, per settled line:
//   transit_to_lab        (found at the Lab)           → internal transfer transit → LAB/Stock
//   transit_to_lab_scrap  (damaged, photo / returned)  → transit → LAB/Stock, then LAB scrap
//   scrap_transit         (lost in transport)          → scrap from transit
//   lab_to_shop           (Lab sent too many)          → internal transfer LAB/Stock → shop stock
// One grouped transfer per direction, LAB "Transferts internes" type (id looked up, fallback 7).
export type RepGapLine = { sku: string; qty: number; action: 'transit_to_lab' | 'transit_to_lab_scrap' | 'scrap_transit' | 'lab_to_shop' };

async function internalTransfer(
  typeId: number, from: number, to: number, origin: string,
  items: { pid: number; uom: number; code: string; qty: number }[],
): Promise<{ ok: true; name: string } | { ok: false; error: string }> {
  const pickId = await odooExecuteWrite<number>('stock.picking', 'create', [{
    picking_type_id: typeId, location_id: from, location_dest_id: to, origin,
    move_ids: items.map(i => [0, 0, { name: i.code, product_id: i.pid, product_uom: i.uom, product_uom_qty: i.qty, location_id: from, location_dest_id: to }]),
  }], { context: NO_MAIL });
  await odooExecuteWrite('stock.picking', 'action_confirm', [[pickId]], { context: NO_MAIL });
  const ms = await odooExecuteWrite<any[]>('stock.move', 'search_read', [[['picking_id', '=', pickId]]], { fields: ['id', 'product_uom_qty'] });
  for (const m of ms) await odooExecuteWrite('stock.move', 'write', [[m.id], { quantity: m.product_uom_qty }], { context: NO_MAIL });
  const v = await odooExecuteWrite<any>('stock.picking', 'button_validate', [[pickId]], { context: { skip_backorder: true, cancel_backorder: true, ...NO_MAIL } });
  const [p] = await odooExecuteWrite<any[]>('stock.picking', 'read', [[pickId]], { fields: ['name'] });
  if (v !== true) return { ok: false, error: `Transfer ${p?.name ?? pickId} created but not validated: ${JSON.stringify(v)}` };
  return { ok: true, name: p?.name ?? String(pickId) };
}

export async function finalizeReplenishmentGaps(
  orderRef: string, lines: RepGapLine[],
  receptionLines: { sku: string | null; sent: number; received: number; damaged: number }[],
): Promise<SoFinalizeResult> {
  const live = inValidationLive();
  const done: string[] = [];
  if (!odooWriteConfigured()) return { ok: false, live, error: 'Odoo write account not configured', done };
  if (!lines.length) return { ok: true, live, done: ['nothing to send'] };
  try {
    // 1. Shop IN at the good quantity (no-op if already validated).
    const vin = await validateShopIn(orderRef, receptionLines, { dryRun: !live });
    if (!vin.ok && !vin.alreadyDone) return { ok: false, live, error: `Shop IN: ${vin.skipped ?? vin.error}`, done };
    const ins = await odooExecute<any[]>('stock.picking', 'search_read',
      [[['origin', '=', orderRef], ['location_id', '=', TRANSIT_LOCATION_ID], ['state', '!=', 'cancel']]], { fields: ['id', 'name', 'state', 'location_dest_id'] });
    const shopIn = ins[0];
    if (!shopIn) return { ok: false, live, error: 'No shop IN found', done };
    done.push(vin.alreadyDone ? `IN ${shopIn.name} already validated` : `IN ${shopIn.name} validated at good qty`);
    const shopStock: number = shopIn.location_dest_id?.[0];

    const skus = Array.from(new Set(lines.map(l => l.sku)));
    const prods = await odooExecute<any[]>('product.product', 'search_read', [[['default_code', 'in', skus]]], { fields: ['id', 'default_code', 'uom_id'] });
    const prodBySku = new Map(prods.map(p => [p.default_code as string, p]));
    for (const s of skus) if (!prodBySku.has(s)) return { ok: false, live, error: `Product ${s} not found in Odoo`, done };
    const agg = (acts: RepGapLine['action'][]) => {
      const m = new Map<string, number>();
      for (const l of lines) if (acts.includes(l.action)) m.set(l.sku, (m.get(l.sku) ?? 0) + l.qty);
      return Array.from(m.entries()).filter(([, q]) => q > 0).map(([sku, qty]) => {
        const p = prodBySku.get(sku)!; return { pid: p.id as number, uom: p.uom_id?.[0] as number, code: sku, qty };
      });
    };
    // Axel 2026-10-15: everything that comes back from the transit is a RETURN of the validated
    // LAB/OUT (not a free internal transfer), so the REP's "sent" drops and the request can close.
    // Lost in transport = returned + scrapped at LAB too, for the same reason.
    const backToLab = agg(['transit_to_lab', 'transit_to_lab_scrap', 'scrap_transit']);
    const scrapLab = agg(['transit_to_lab_scrap', 'scrap_transit']);
    const toShop = agg(['lab_to_shop']);
    if (!live) return { ok: true, live, done: [...done,
      ...backToLab.map(i => `return of LAB/OUT ${i.code} ×${i.qty}`), ...scrapLab.map(i => `scrap LAB ${i.code} ×${i.qty}`),
      ...toShop.map(i => `LAB → shop ${i.code} ×${i.qty}`)] };

    const types = await odooExecute<any[]>('stock.picking.type', 'search_read', [[['code', '=', 'internal'], ['default_location_src_id', '=', LAB_STOCK_LOCATION_ID]]], { fields: ['id'], limit: 1 });
    const typeId: number = types[0]?.id ?? 7;
    const { createScrapAtLocation } = await import('@/lib/odoo-scrap');
    if (backToLab.length) {
      const outs = await odooExecute<any[]>('stock.picking', 'search_read',
        [[['origin', '=', orderRef], ['location_id', '=', LAB_STOCK_LOCATION_ID], ['location_dest_id', '=', TRANSIT_LOCATION_ID], ['state', '=', 'done']]], { fields: ['id', 'name'] });
      if (outs.length !== 1) return { ok: false, live, error: outs.length ? 'Several validated LAB/OUT for this order — return by hand' : 'No validated LAB/OUT for this order', done };
      // The units must still be in transit (nothing else moved them), otherwise stop before writing.
      const quants = await odooExecute<any[]>('stock.quant', 'search_read', [[['location_id', '=', TRANSIT_LOCATION_ID], ['product_id', 'in', backToLab.map(i => i.pid)]]], { fields: ['product_id', 'quantity'] });
      for (const i of backToLab) {
        const inTransit = quants.filter(q => q.product_id?.[0] === i.pid).reduce((t, q) => t + Number(q.quantity), 0);
        if (inTransit < i.qty) return { ok: false, live, error: `${i.code}: only ${inTransit} in transit, ${i.qty} to return — check Odoo`, done };
      }
      const r = await returnFromDelivery(outs[0].id, new Map(backToLab.map(i => [i.pid, i.qty])), false);
      if (!r.ok) return { ok: false, live, error: r.error, done };
      done.push(`return ${r.name} (of ${outs[0].name})`);
    }
    for (const i of scrapLab) {
      const r = await createScrapAtLocation(LAB_STOCK_LOCATION_ID, { productId: i.pid, uomId: i.uom, qty: i.qty, reasonTagIds: [], origin: `${orderRef} — hỏng khi giao (lỗi Lab)` });
      if (!r.ok) return { ok: false, live, error: `Scrap failed: ${r.error}`, done };
      done.push(`scrap ${await recordName('stock.scrap', r.scrapId)} · ${i.code} ×${i.qty}`);
    }
    if (toShop.length) {
      if (!shopStock) return { ok: false, live, error: 'Shop stock location unknown', done };
      const r = await internalTransfer(typeId, LAB_STOCK_LOCATION_ID, shopStock, `${orderRef} — Lab gửi dư`, toShop);
      if (!r.ok) return { ok: false, live, error: r.error, done };
      done.push(`LAB → shop ${r.name}`);
    }
    return { ok: true, live, done };
  } catch (e: any) {
    return { ok: false, live, error: e?.message ?? String(e), done };
  }
}

// ── 6. Off-slip products (Axel, 2026-10-16) ────────────────────────────────────────────────────
// A shop received units that were on NO delivery slip. The shop keeps them; Odoo must show them
// in its stock AND in the shop's order documents, because Axel analyses deliveries by exporting
// the REPs (quantity sent vs received) — a loose internal transfer would never show there.
//   1. When they were a customer's sales order delivered to the wrong place, that customer is not
//      charged for them: return on that order's delivery (back to LAB/Stock) + the invoice back to
//      draft with the quantity lowered (finalizeSalesOrderGaps, same as the Moon Flower gaps).
//   2. Then the receiving shop gets them through its own kind of document:
//      - REP shop  → a NEW adjustment REP, fully automatic: create → submit → approve → validate
//        the LAB/OUT → validate the shop IN → quantity received → mark as done. Its `notes` start
//        with ADJUST_REP_MARKER so the app never imports it (no production card, no Delivery check,
//        no shop reception): odoo-sync / odoo-order-lock / checks filter it out.
//      - SO shop (Moon Flower) → a new line on the SO it was received with (allowed on a confirmed
//        SO), its delivery validated, and the line added to the invoice if one exists (left draft).

async function validateWholePicking(pickingId: number): Promise<{ ok: true } | { ok: false; error: string }> {
  const moves = await odooExecuteWrite<any[]>('stock.move', 'search_read', [[['picking_id', '=', pickingId], ['state', 'not in', ['done', 'cancel']]]], { fields: ['id', 'product_uom_qty'] });
  if (!moves.length) return { ok: false, error: `picking ${pickingId} has no open move` };
  const plan: PlannedWrite[] = moves.map(m => ({ sku: String(m.id), moveId: m.id, note: null, expectedQty: Number(m.product_uom_qty), deliverQty: Number(m.product_uom_qty) }));
  return writeQuantitiesAndValidatePicking(pickingId, plan);
}

async function createAdjustmentRep(input: {
  whCode: string; deliveryDate: string; note: string; items: { pid: number; code: string; qty: number }[];
}): Promise<{ ok: boolean; name?: string; error?: string; done: string[] }> {
  const done: string[] = [];
  const { labLocalToOdooUtc } = await import('@/lib/odoo');
  const whs = await odooExecuteWrite<any[]>('stock.warehouse', 'search_read', [[['code', 'in', [input.whCode, 'LAB']]]], { fields: ['id', 'code'] });
  const dest = whs.find(w => w.code === input.whCode), src = whs.find(w => w.code === 'LAB');
  if (!dest || !src) return { ok: false, error: `Warehouse ${!dest ? input.whCode : 'LAB'} not found in Odoo`, done };
  const reqId = await odooExecuteWrite<number>('stock.replenishment.request', 'create', [{
    warehouse_id: dest.id, source_warehouse_id: src.id,
    delivery_date: labLocalToOdooUtc(input.deliveryDate, '09:00'),
    notes: `${ADJUST_REP_MARKER} ${input.note}`,
  }], { context: NO_MAIL });
  for (const i of input.items) {
    await odooExecuteWrite('stock.replenishment.request.line', 'create', [{ request_id: reqId, product_id: i.pid, quantity_requested: i.qty }], { context: NO_MAIL });
  }
  const readReq = async () => (await odooExecuteWrite<any[]>('stock.replenishment.request', 'read', [[reqId]], { fields: ['name', 'state', 'delivery_picking_ids', 'receipt_picking_ids', 'line_ids'] }))[0];
  let req = await readReq();
  const name: string = req?.name ?? `REP id ${reqId}`;
  done.push(`${name} created (adjustment)`);
  try {
    await odooExecuteWrite('stock.replenishment.request', 'action_submit', [[reqId]], { context: NO_MAIL });
    await odooExecuteWrite('stock.replenishment.request', 'action_approve', [[reqId]], { context: NO_MAIL });
    req = await readReq();
    const outIds: number[] = req.delivery_picking_ids ?? [];
    if (outIds.length !== 1) return { ok: false, name, error: `${name}: ${outIds.length} delivery picking(s) after approval — finish by hand`, done };
    const out = await validateWholePicking(outIds[0]);
    if (!out.ok) return { ok: false, name, error: `${name} LAB/OUT: ${out.error}`, done };
    done.push(`${name}: LAB/OUT ${await recordName('stock.picking', outIds[0])} validated`);

    const ins = await odooExecuteWrite<any[]>('stock.picking', 'search_read',
      [[['origin', '=', name], ['location_id', '=', TRANSIT_LOCATION_ID], ['state', 'not in', ['done', 'cancel']]]], { fields: ['id', 'name'] });
    if (ins.length !== 1) return { ok: false, name, error: `${name}: ${ins.length} shop IN found — finish by hand`, done };
    const inn = await validateWholePicking(ins[0].id);
    if (!inn.ok) return { ok: false, name, error: `${name} shop IN: ${inn.error}`, done };
    done.push(`${name}: shop IN ${ins[0].name} validated`);

    const lines = await odooExecuteWrite<any[]>('stock.replenishment.request.line', 'read', [req.line_ids ?? []], { fields: ['id', 'product_id'] });
    for (const l of lines) {
      const it = input.items.find(i => i.pid === l.product_id?.[0]);
      if (it) await odooExecuteWrite('stock.replenishment.request.line', 'write', [[l.id], { quantity_received: it.qty }], { context: NO_MAIL });
    }
    req = await readReq();
    if (req.state !== 'done') {
      await odooExecuteWrite('stock.replenishment.request', 'action_mark_done', [[reqId]], { context: NO_MAIL });
      req = await readReq();
    }
    if (req.state !== 'done') return { ok: false, name, error: `${name}: still "${req.state}" after mark as done — close it by hand`, done };
    done.push(`${name}: done`);
    return { ok: true, name, done };
  } catch (e: any) {
    return { ok: false, name, error: `${name}: ${e?.message ?? String(e)}`, done };
  }
}

async function addLineToSalesOrder(soRef: string, p: { id: number; default_code: string }, qty: number): Promise<{ ok: boolean; error?: string; done: string[] }> {
  const done: string[] = [];
  const [so] = await odooExecuteWrite<any[]>('sale.order', 'search_read', [[['name', '=', soRef]]], { fields: ['id', 'name', 'state', 'invoice_ids', 'locked'] });
  if (!so) return { ok: false, error: `${soRef} not found in Odoo`, done };
  if (so.state !== 'sale') return { ok: false, error: `${soRef} is "${so.state}", not a confirmed order — settle by hand`, done };
  // 2026-10-23: a fully invoiced order is LOCKED in Odoo ("đơn đã rời trạng thái báo giá") —
  // unlock just for the new line, lock it back right after.
  if (so.locked) await odooExecuteWrite('sale.order', 'action_unlock', [[so.id]], { context: NO_MAIL });
  let lineId: number;
  try {
    lineId = await odooExecuteWrite<number>('sale.order.line', 'create', [{ order_id: so.id, product_id: p.id, product_uom_qty: qty }], { context: NO_MAIL });
  } finally {
    if (so.locked) await odooExecuteWrite('sale.order', 'action_lock', [[so.id]], { context: NO_MAIL }).catch(() => {});
  }
  done.push(`${soRef}: + line ${p.default_code} ×${qty}`);
  try {
    // A confirmed SO launches its procurement for the new line (a delivery move). Validate it,
    // but only when the picking holds nothing else — never ship other lines by accident.
    const moves = await odooExecuteWrite<any[]>('stock.move', 'search_read', [[['sale_line_id', '=', lineId], ['state', 'not in', ['done', 'cancel']]]], { fields: ['id', 'picking_id'] });
    const pickId: number | undefined = moves[0]?.picking_id?.[0];
    if (!pickId) return { ok: false, error: `${soRef}: no delivery created for the new line — validate by hand`, done };
    const others = await odooExecuteWrite<any[]>('stock.move', 'search_read', [[['picking_id', '=', pickId], ['state', 'not in', ['done', 'cancel']], ['sale_line_id', '!=', lineId]]], { fields: ['id'] });
    if (others.length) return { ok: false, error: `${soRef}: the new line joined a delivery with other open lines — validate by hand`, done };
    const v = await validateWholePicking(pickId);
    if (!v.ok) return { ok: false, error: `${soRef} delivery: ${v.error}`, done };
    done.push(`${soRef}: delivery ${await recordName('stock.picking', pickId)} validated`);

    const invs = so.invoice_ids?.length ? await odooExecuteWrite<any[]>('account.move', 'read', [so.invoice_ids], { fields: ['id', 'name', 'state', 'move_type'] }) : [];
    const inv = invs.filter(i => i.move_type === 'out_invoice' && i.state !== 'cancel').sort((a, b) => b.id - a.id)[0];
    if (!inv) { done.push('no invoice yet — the line will be invoiced with the order'); return { ok: true, done }; }
    if (inv.state === 'posted') { await odooExecuteWrite('account.move', 'button_draft', [[inv.id]], { context: NO_MAIL }); done.push(`invoice ${inv.name} → draft`); }
    const [sl] = await odooExecuteWrite<any[]>('sale.order.line', 'read', [[lineId]], { fields: ['price_unit', 'discount', 'tax_id'] });
    await odooExecuteWrite('account.move', 'write', [[inv.id], { invoice_line_ids: [[0, 0, {
      product_id: p.id, quantity: qty, price_unit: sl?.price_unit ?? 0, discount: sl?.discount ?? 0,
      tax_ids: [[6, 0, sl?.tax_id ?? []]], sale_line_ids: [[6, 0, [lineId]]],
    }]] }], { context: NO_MAIL });
    const { postInvoiceNote } = await import('@/lib/odoo-invoice-note');
    const noted = await postInvoiceNote({
      invoiceId: inv.id, orderRef: soRef, changes: [{ code: p.default_code, from: 0, to: qty }],
      docs: [`delivery / giao hàng ${await recordName('stock.picking', pickId)}`],
      reasonEn: 'received without a delivery slip, kept by the shop', reasonVi: 'nhận hàng không có phiếu, shop giữ lại',
    });
    if (!noted) done.push('invoice note NOT posted (Odoo error)');
    done.push(`invoice ${inv.name}: + ${p.default_code} ×${qty}, left in DRAFT — accounting re-posts it`);
    return { ok: true, done };
  } catch (e: any) {
    return { ok: false, error: `${soRef}: ${e?.message ?? String(e)}`, done };
  }
}

// Axel, 2026-10-23: units a partner shop (Moon) kept off-slip.
//  • the order's invoice has NO e-invoice VAT number yet → add the line straight onto that invoice
//    (same price / discount / taxes as Moon's last sale of the product), back to draft if posted,
//    + a Lab → customer delivery "<SO> ngoài phiếu". One invoice, right before the VAT.
//  • a VAT number is already there → never touch that invoice: small new order (own invoice).
async function addOffslipToPartnerInvoice(soRef: string, p: { id: number; default_code: string }, qty: number, deliveryDate: string): Promise<{ ok: boolean; error?: string; done: string[] }> {
  const done: string[] = [];
  const [so] = await odooExecuteWrite<any[]>('sale.order', 'search_read', [[['name', '=', soRef]]], { fields: ['id', 'name', 'partner_id', 'partner_shipping_id', 'warehouse_id', 'invoice_ids'] });
  if (!so) return { ok: false, error: `${soRef} not found in Odoo`, done };
  const invs = so.invoice_ids?.length ? await odooExecuteWrite<any[]>('account.move', 'read', [so.invoice_ids], { fields: ['id', 'name', 'state', 'move_type', 'l10n_vn_e_invoice_number'] }) : [];
  const inv = invs.filter(i => i.move_type === 'out_invoice' && i.state !== 'cancel').sort((a, b) => b.id - a.id)[0];
  const hasVat = !!inv && /vat/i.test(String(inv.l10n_vn_e_invoice_number || ''));
  if (!inv || hasVat) {
    done.push(!inv ? `${soRef}: no invoice yet → small new order` : `${inv.name} already has e-invoice ${String(inv.l10n_vn_e_invoice_number).trim()} → not touched, small new order`);
    const r = await createExtraSalesOrder(soRef, p, qty, deliveryDate);
    return { ok: r.ok, error: r.error, done: [...done, ...r.done] };
  }
  // Price: Moon's latest sale line of this product (pricelist price, discount, taxes).
  const [ref] = await odooExecuteWrite<any[]>('sale.order.line', 'search_read', [[['order_id.partner_id', '=', so.partner_id[0]], ['product_id', '=', p.id], ['price_unit', '>', 0]]],
    { fields: ['price_unit', 'discount', 'tax_id'], order: 'id desc', limit: 1 });
  let price = ref?.price_unit, discount = ref?.discount ?? 0, taxes: number[] = ref?.tax_id ?? [];
  if (price == null) {
    const [prod] = await odooExecuteWrite<any[]>('product.product', 'read', [[p.id]], { fields: ['list_price', 'taxes_id'] });
    price = prod?.list_price ?? 0; discount = 50; taxes = prod?.taxes_id ?? [];
  }
  // 1. Stock: Lab → customer delivery.
  const [wh] = await odooExecuteWrite<any[]>('stock.warehouse', 'read', [[so.warehouse_id[0]]], { fields: ['out_type_id', 'lot_stock_id'] });
  const [prodU] = await odooExecuteWrite<any[]>('product.product', 'read', [[p.id]], { fields: ['uom_id'] });
  const custLoc = (await odooExecuteWrite<any[]>('stock.location', 'search_read', [[['usage', '=', 'customer']]], { fields: ['id'], limit: 1, order: 'id asc' }))[0]?.id;
  const origin = `${soRef} ngoài phiếu`;
  const pickId = await odooExecuteWrite<number>('stock.picking', 'create', [{
    picking_type_id: wh.out_type_id[0], partner_id: (so.partner_shipping_id ?? so.partner_id)[0], location_id: wh.lot_stock_id[0], location_dest_id: custLoc, origin,
    move_ids: [[0, 0, { name: p.default_code, product_id: p.id, product_uom: prodU.uom_id[0], product_uom_qty: qty, location_id: wh.lot_stock_id[0], location_dest_id: custLoc }]],
  }], { context: NO_MAIL });
  await odooExecuteWrite('stock.picking', 'action_confirm', [[pickId]], { context: NO_MAIL });
  const v = await validateWholePicking(pickId);
  if (!v.ok) return { ok: false, error: `delivery ${await recordName('stock.picking', pickId)}: ${v.error}`, done };
  done.push(`delivery ${await recordName('stock.picking', pickId)} (${origin}) validated`);
  // 2. Invoice: back to draft if posted, + the line (analytic copied from an existing line).
  if (inv.state === 'posted') { await odooExecuteWrite('account.move', 'button_draft', [[inv.id]], { context: NO_MAIL }); done.push(`invoice ${inv.name} → draft`); }
  const [anyLine] = await odooExecuteWrite<any[]>('account.move.line', 'search_read', [[['move_id', '=', inv.id], ['display_type', '=', 'product']]], { fields: ['analytic_distribution'], limit: 1 });
  await odooExecuteWrite('account.move', 'write', [[inv.id], { invoice_line_ids: [[0, 0, {
    product_id: p.id, quantity: qty, price_unit: price, discount, tax_ids: [[6, 0, taxes]],
    ...(anyLine?.analytic_distribution ? { analytic_distribution: anyLine.analytic_distribution } : {}),
  }]] }], { context: NO_MAIL });
  try {
    await odooExecuteWrite('account.move', 'message_post', [[inv.id]], { body: `App Lab: thêm ${p.default_code} ×${qty} — hàng giao thêm ngoài phiếu cùng ${soRef} (${deliveryDate}), shop giữ lại, Lab gửi thừa. Phiếu xuất ${await recordName('stock.picking', pickId)}. Dòng này không nằm trong đơn ${soRef}. Hoá đơn để nháp — kiểm tra rồi xuất VAT.`, message_type: 'comment', subtype_xmlid: 'mail.mt_note' });
  } catch { done.push('invoice note NOT posted'); }
  done.push(`invoice ${inv.name}: + ${p.default_code} ×${qty} (${price} −${discount}%), left in DRAFT — xuất VAT after checking`);
  return { ok: true, done };
}

// 2026-10-23: Odoo refuses new lines on a confirmed order ("đơn đã rời trạng thái báo giá"),
// even unlocked. So units kept off-slip by a partner shop (Moon) go on a SMALL NEW order for the
// same customer, from the same warehouse: confirmed, delivery validated, invoice left in DRAFT.
// No commitment_date, so the production sync never imports it.
async function createExtraSalesOrder(soRef: string, p: { id: number; default_code: string }, qty: number, deliveryDate: string): Promise<{ ok: boolean; error?: string; done: string[] }> {
  const done: string[] = [];
  const [so] = await odooExecuteWrite<any[]>('sale.order', 'search_read', [[['name', '=', soRef]]], { fields: ['id', 'name', 'partner_id', 'partner_shipping_id', 'partner_invoice_id', 'pricelist_id', 'warehouse_id'] });
  if (!so) return { ok: false, error: `${soRef} not found in Odoo`, done };
  const ref = `${soRef} — ngoài phiếu`;
  const newId = await odooExecuteWrite<number>('sale.order', 'create', [{
    partner_id: so.partner_id[0], partner_shipping_id: so.partner_shipping_id?.[0], partner_invoice_id: so.partner_invoice_id?.[0],
    pricelist_id: so.pricelist_id?.[0], warehouse_id: so.warehouse_id?.[0], client_order_ref: ref, origin: ref,
    note: `Hàng giao thêm ngoài phiếu cùng ${soRef} (${deliveryDate}), shop giữ lại — tạo bởi app Lab.`,
    order_line: [[0, 0, { product_id: p.id, product_uom_qty: qty }]],
  }], { context: NO_MAIL });
  await odooExecuteWrite('sale.order', 'action_confirm', [[newId]], { context: NO_MAIL });
  const [nso] = await odooExecuteWrite<any[]>('sale.order', 'read', [[newId]], { fields: ['name', 'picking_ids'] });
  done.push(`${nso.name} created for ${p.default_code} ×${qty} (${ref})`);
  const picks = nso.picking_ids?.length ? await odooExecuteWrite<any[]>('stock.picking', 'read', [nso.picking_ids], { fields: ['id', 'name', 'state'] }) : [];
  const pick = picks.find(x => x.state !== 'cancel' && x.state !== 'done');
  if (!pick) return { ok: false, error: `${nso.name}: no delivery created — validate by hand`, done };
  const v = await validateWholePicking(pick.id);
  if (!v.ok) return { ok: false, error: `${nso.name} delivery: ${v.error}`, done };
  done.push(`${nso.name}: delivery ${pick.name} validated`);
  try {
    const wiz = await odooExecuteWrite<number>('sale.advance.payment.inv', 'create', [{ advance_payment_method: 'delivered', sale_order_ids: [[6, 0, [newId]]] }], { context: { active_ids: [newId], active_model: 'sale.order', ...NO_MAIL } });
    await odooExecuteWrite('sale.advance.payment.inv', 'create_invoices', [[wiz]], { context: { active_ids: [newId], active_model: 'sale.order', ...NO_MAIL } });
    const [after] = await odooExecuteWrite<any[]>('sale.order', 'read', [[newId]], { fields: ['invoice_ids'] });
    if (after?.invoice_ids?.length) {
      await odooExecuteWrite('account.move', 'write', [after.invoice_ids, { invoice_date: deliveryDate, delivery_date: deliveryDate }], { context: NO_MAIL }).catch(() => {});
      done.push(`${nso.name}: invoice created in DRAFT — accounting posts it`);
    } else done.push(`${nso.name}: no invoice created — invoice by hand`);
  } catch (e: any) {
    done.push(`${nso.name}: invoice NOT created (${e?.message ?? e}) — invoice by hand`);
  }
  return { ok: true, done };
}

export async function finalizeOffSlip(input: {
  shopName: string; sku: string; qty: number; sourceSoRef: string | null; origin: string;
  deliveryDate: string; receivingOrderRef: string | null;
}): Promise<SoFinalizeResult> {
  const live = inValidationLive();
  const done: string[] = [];
  if (!odooWriteConfigured()) return { ok: false, live, error: 'Odoo write account not configured', done };
  try {
    const { SHOP_CONFIG } = await import('@/lib/shops');
    const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
    const cfgKey = Object.keys(SHOP_CONFIG).find(k => norm(k) === norm(input.shopName));
    const cfg = cfgKey ? SHOP_CONFIG[cfgKey] : undefined;
    const repWh = cfg?.docType === 'replenishment' ? cfg.warehouseCode : undefined;
    const recvSo = !repWh && input.receivingOrderRef && !input.receivingOrderRef.startsWith('REP') ? input.receivingOrderRef : null;
    if (!repWh && !recvSo) return { ok: false, live, error: `${input.shopName}: no REP warehouse and no sales order to attach — settle by hand`, done };
    const prods = await odooExecuteWrite<any[]>('product.product', 'search_read', [[['default_code', '=', input.sku]]], { fields: ['id', 'default_code', 'uom_id'] });
    const p = prods[0];
    if (!p) return { ok: false, live, error: `Product ${input.sku} not found in Odoo`, done };

    // 1. Customer order: not charged for these units (return + invoice draft, lowered).
    if (input.sourceSoRef) {
      const r = await finalizeSalesOrderGaps(input.sourceSoRef, [{ sku: input.sku, qty: input.qty, action: 'return' }], {
        reasonEn: `delivered to ${input.shopName} by mistake, the shop keeps them`,
        reasonVi: `giao nhầm cho ${input.shopName}, shop giữ lại`,
      });
      done.push(...r.done.map(d => `${input.sourceSoRef}: ${d}`));
      if (!r.ok) return { ok: false, live, error: `${input.sourceSoRef}: ${r.error}`, done };
    }
    // 2. The shop keeps them, through its own order document.
    if (!live) {
      done.push(repWh
        ? `new adjustment REP → ${repWh}: ${input.sku} ×${input.qty} (OUT + IN validated, marked done)`
        : `${recvSo}: Lab → customer delivery ${input.sku} ×${input.qty}; line added to its invoice if no VAT yet, else a small new order`);
      return { ok: true, live, done };
    }
    const r = repWh
      ? await createAdjustmentRep({ whCode: repWh, deliveryDate: input.deliveryDate, note: input.origin, items: [{ pid: p.id, code: input.sku, qty: input.qty }] })
      : await addOffslipToPartnerInvoice(recvSo!, p, input.qty, input.deliveryDate);
    done.push(...r.done);
    if (!r.ok) return { ok: false, live, error: r.error, done };
    return { ok: true, live, done };
  } catch (e: any) {
    return { ok: false, live, error: e?.message ?? String(e), done };
  }
}
