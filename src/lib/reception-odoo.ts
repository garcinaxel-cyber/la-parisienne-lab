// Shop reception gaps → Odoo (Axel, 2026-10-13). PREVIEW: plans only, never writes.
//
// "pour le moment je veux pas que ça impacte l'opérationnel": every function here READS Odoo
// (to build a concrete plan with real picking / move ids) and returns what it WOULD do. The live
// path is gated twice — RECEPTION_ODOO_LIVE=1 AND VERCEL_ENV=production — and even then is not
// implemented yet: it only gets coded and tested once Axel has validated the flow on the preview.
//
// Odoo flow reminder: REP → LAB/OUT (LAB/Stock 8 → transit 13) → SHOP/IN (transit 13 → shop).
// The SHOP/IN picking is found by origin = REP ref and source location = transit.
import { odooConfigured, odooExecute, odooExecuteWrite, odooWriteConfigured } from '@/lib/odoo';
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
      if (ms.length === 1) {
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

export async function finalizeSalesOrderGaps(orderRef: string, lines: SoGapLine[]): Promise<SoFinalizeResult> {
  const live = inValidationLive();
  const done: string[] = [];
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

    if (!live) return { ok: true, live, done: [`return ${toReturn.size} product(s)`, `scrap ${toScrap.size}`, `extra ${extra.size}`, 'invoice back to draft, quantities adjusted'] };

    // 1. Return
    if (toReturn.size) {
      const r = await returnFromDelivery(delivery.id, toReturn, true);
      if (!r.ok) return { ok: false, live, error: r.error, done };
      done.push(`return ${r.name}`);
    }
    // 2. Scrap (Lab loss)
    if (toScrap.size) {
      const { createScrapAtLocation } = await import('@/lib/odoo-scrap');
      for (const [pid, q] of Array.from(toScrap.entries())) {
        const p = prods.find(x => x.id === pid);
        const r = await createScrapAtLocation(LAB_STOCK_LOCATION_ID, { productId: pid, uomId: p.uom_id?.[0], qty: q, reasonTagIds: [], origin: `${orderRef} — hỏng/mất khi giao (lỗi Lab)` });
        if (!r.ok) return { ok: false, live, error: `Scrap failed: ${r.error}`, done };
        done.push(`scrap ${await recordName('stock.scrap', r.scrapId)} · ${p.default_code} ×${q}`);
      }
    }
    // 3. Extra delivery
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
      done.push(`extra delivery ${await recordName('stock.picking', pickId)}`);
    }
    // 4. Invoice (Axel 2026-10-14: "pas d'avoir, faut passer la facture en draft et ajuster").
    // The existing customer invoice goes back to draft and its lines follow the quantities:
    // − returned / lost / damaged, + extra. Left in DRAFT: accounting re-posts it.
    const invIds: number[] = so.invoice_ids ?? [];
    const invs = invIds.length ? await odooExecute<any[]>('account.move', 'read', [invIds], { fields: ['id', 'name', 'state', 'move_type'] }) : [];
    const inv = invs.filter(i => i.move_type === 'out_invoice' && i.state !== 'cancel').sort((a, b) => b.id - a.id)[0];
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
    for (const [pid, d] of Array.from(delta.entries())) {
      if (!d) continue;
      const code = prods.find(x => x.id === pid)?.default_code ?? pid;
      const il = iLines.find(l => l.product_id?.[0] === pid);
      if (il) {
        const q = Math.max(0, Number(il.quantity) + d);
        cmds.push([1, il.id, { quantity: q }]);
        done.push(`invoice ${code}: ${il.quantity} → ${q}`);
      } else if (d > 0) {
        const sl = soLinesFull.find(l => l.product_id?.[0] === pid);
        cmds.push([0, 0, { product_id: pid, quantity: d, price_unit: sl?.price_unit ?? 0, discount: sl?.discount ?? 0, tax_ids: [[6, 0, sl?.tax_id ?? []]], sale_line_ids: sl ? [[6, 0, [sl.id]]] : [] }]);
        done.push(`invoice ${code}: +${d} (new line)`);
      } else done.push(`invoice ${code}: no line to lower`);
    }
    if (cmds.length) await odooExecuteWrite('account.move', 'write', [[inv.id], { invoice_line_ids: cmds }], { context: NO_MAIL });
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
