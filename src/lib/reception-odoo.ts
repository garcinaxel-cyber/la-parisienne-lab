// Shop reception gaps → Odoo (Axel, 2026-10-13). PREVIEW: plans only, never writes.
//
// "pour le moment je veux pas que ça impacte l'opérationnel": every function here READS Odoo
// (to build a concrete plan with real picking / move ids) and returns what it WOULD do. The live
// path is gated twice — RECEPTION_ODOO_LIVE=1 AND VERCEL_ENV=production — and even then is not
// implemented yet: it only gets coded and tested once Axel has validated the flow on the preview.
//
// Odoo flow reminder: REP → LAB/OUT (LAB/Stock 8 → transit 13) → SHOP/IN (transit 13 → shop).
// The SHOP/IN picking is found by origin = REP ref and source location = transit.
import { odooConfigured, odooExecute, odooWriteConfigured } from '@/lib/odoo';
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
