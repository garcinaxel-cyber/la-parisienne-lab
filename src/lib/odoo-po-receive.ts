// Purchase-order receiving (Axel, 2026-10-26) — read the open supplier receipts of the Lab live from
// Odoo, and validate one with the quantities counted in the app. Server-only.
//
// Validate, in this order (each step read back, nothing guessed):
//   1. "Supplier has no more" lines: PO line product_qty and the move demand lowered to what arrived
//      (Odoo does not shrink a receipt move by itself when the PO quantity goes down).
//   2. quantity written on every move, then button_validate with skip_backorder: whatever is still
//      short ("comes later", "supplier mistake", "wrong product") is left on a backorder by Odoo.
//   3. Service lines of the PO (shipping cost, manual received quantity) marked received with the
//      first delivery so they reach the bill.
//   4. ONE bill per PO (Axel): none → created from the PO; one draft → its quantities aligned to the
//      received quantities (minus what posted bills already cover); posted only → untouched, the gap
//      is reported. The app never posts a bill.
//   5. Notes on the receipt and on the PO (VI + EN), wrong product / supplier mistake spelled out.
import { odooExecute, odooExecuteWrite, odooConfigured, odooWriteConfigured } from '@/lib/odoo';

export const LAB_RECEIPT_TYPE_ID = 1; // "Lab: Réceptions" → LAB/Stock
const NO_MAIL = { tracking_disable: true, mail_notrack: true, mail_create_nolog: true, mail_notify_force_send: false };
const OPEN_DAYS = 30; // Axel, 2026-10-26: only POs confirmed in the last 30 days

export type ShortReason = 'later' | 'supplier_error' | 'no_more' | 'wrong_product';
export const SHORT_REASONS: Record<ShortReason, { vi: string; en: string; emoji: string }> = {
  later: { vi: 'Phần còn lại giao sau', en: 'The rest comes later', emoji: '🚚' },
  supplier_error: { vi: 'Nhà cung cấp giao sai / thiếu', en: 'Supplier mistake', emoji: '❌' },
  no_more: { vi: 'Nhà cung cấp hết hàng', en: 'Supplier has no more', emoji: '🚫' },
  wrong_product: { vi: 'Giao nhầm sản phẩm', en: 'Wrong product delivered', emoji: '🔄' },
};

export type OpenReceipt = {
  pickingId: number; pickingName: string; poId: number; poName: string; vendor: string | null;
  scheduled: string | null; isBackorder: boolean; lines: number; approvedAt: string | null;
};
export type ReceiptLine = {
  moveId: number; productId: number; poLineId: number | null; name: string; uom: string;
  expected: number;        // still to receive on this receipt (move demand)
  ordered: number;         // PO line quantity
  receivedBefore: number;  // already received on earlier deliveries
};
export type ReceiptDetail = { pickingId: number; pickingName: string; state: string; poId: number; poName: string; vendor: string | null; lines: ReceiptLine[] };

const m2oName = (v: any) => (Array.isArray(v) ? String(v[1]) : null);
const m2oId = (v: any) => (Array.isArray(v) ? Number(v[0]) : null);
const r3 = (n: number) => Math.round(n * 1000) / 1000;

export async function listOpenReceipts(): Promise<OpenReceipt[]> {
  if (!odooConfigured()) return [];
  const since = new Date(Date.now() - OPEN_DAYS * 86400000).toISOString().slice(0, 19).replace('T', ' ');
  const picks = await odooExecute<any[]>('stock.picking', 'search_read',
    [[['picking_type_id', '=', LAB_RECEIPT_TYPE_ID], ['state', 'in', ['assigned', 'confirmed', 'waiting']], ['purchase_id', '!=', false],
      ['purchase_id.state', '=', 'purchase'], ['purchase_id.date_approve', '>=', since]]],
    { fields: ['id', 'name', 'scheduled_date', 'partner_id', 'purchase_id', 'backorder_id', 'move_ids'], order: 'scheduled_date asc', limit: 300 });
  const poIds = Array.from(new Set(picks.map(p => m2oId(p.purchase_id)).filter(Boolean))) as number[];
  const pos = poIds.length ? await odooExecute<any[]>('purchase.order', 'read', [poIds], { fields: ['name', 'date_approve', 'partner_id'] }) : [];
  const poById = new Map(pos.map(p => [p.id, p]));
  return picks.map(p => {
    const po: any = poById.get(m2oId(p.purchase_id) ?? -1);
    return {
      pickingId: p.id, pickingName: p.name, poId: m2oId(p.purchase_id)!, poName: po?.name ?? m2oName(p.purchase_id) ?? '',
      vendor: m2oName(p.partner_id) ?? m2oName(po?.partner_id), scheduled: p.scheduled_date || null,
      isBackorder: !!p.backorder_id, lines: (p.move_ids ?? []).length, approvedAt: po?.date_approve ?? null,
    };
  });
}

export async function getReceipt(pickingId: number): Promise<ReceiptDetail | null> {
  const [p] = await odooExecute<any[]>('stock.picking', 'read', [[pickingId]],
    { fields: ['id', 'name', 'state', 'picking_type_id', 'purchase_id', 'partner_id'] });
  if (!p || m2oId(p.picking_type_id) !== LAB_RECEIPT_TYPE_ID || !p.purchase_id) return null;
  const moves = await odooExecute<any[]>('stock.move', 'search_read',
    [[['picking_id', '=', pickingId], ['state', 'not in', ['done', 'cancel']]]],
    { fields: ['id', 'product_id', 'product_uom_qty', 'product_uom', 'purchase_line_id'], context: { lang: 'vi_VN' } });
  const plIds = Array.from(new Set(moves.map(m => m2oId(m.purchase_line_id)).filter(Boolean))) as number[];
  const pls = plIds.length ? await odooExecute<any[]>('purchase.order.line', 'read', [plIds], { fields: ['product_qty', 'qty_received'] }) : [];
  const plById = new Map(pls.map(l => [l.id, l]));
  return {
    pickingId: p.id, pickingName: p.name, state: p.state, poId: m2oId(p.purchase_id)!, poName: m2oName(p.purchase_id) ?? '',
    vendor: m2oName(p.partner_id),
    lines: moves.map(m => {
      const pl: any = plById.get(m2oId(m.purchase_line_id) ?? -1);
      return {
        moveId: m.id, productId: m2oId(m.product_id)!, poLineId: m2oId(m.purchase_line_id), name: m2oName(m.product_id) ?? '',
        uom: m2oName(m.product_uom) ?? '', expected: Number(m.product_uom_qty) || 0,
        ordered: Number(pl?.product_qty ?? m.product_uom_qty) || 0, receivedBefore: Number(pl?.qty_received ?? 0) || 0,
      };
    }),
  };
}

export type ValidateLine = { moveId: number; qty: number; reason?: ShortReason | null; note?: string | null };
export type ValidateResult = {
  ok: boolean; error?: string; alreadyDone?: boolean;
  pickingName?: string; backorderName?: string | null; poId?: number; poName?: string; vendor?: string | null;
  lowered: { name: string; from: number; to: number }[];
  bill: { id: number | null; action: 'created' | 'aligned' | 'posted_untouched' | 'none'; gaps?: string[] };
  received: { productId: number; poLineId: number | null; name: string; uom: string; expected: number; received: number; reason: ShortReason | null; note: string | null }[];
  log: string[];
};

function noteHtml(by: string, at: string, lines: ValidateResult['received'], backorder: string | null) {
  const row = (l: ValidateResult['received'][number]) => {
    const r = l.reason ? ` — ${SHORT_REASONS[l.reason].vi} / ${SHORT_REASONS[l.reason].en}${l.note ? ` (${l.note})` : ''}` : '';
    return `<li>${l.name}: ${l.received} / ${l.expected} ${l.uom}${r}</li>`;
  };
  return `<p>Nhận hàng qua lab-app / Received via lab-app — ${by}, ${at}</p><ul>${lines.map(row).join('')}</ul>`
    + (backorder ? `<p>Phần còn lại / Still expected: ${backorder}</p>` : '');
}

export async function validateReceipt(pickingId: number, input: ValidateLine[], by: string): Promise<ValidateResult> {
  const res: ValidateResult = { ok: false, lowered: [], bill: { id: null, action: 'none' }, received: [], log: [] };
  if (!odooWriteConfigured()) return { ...res, error: 'Compte Odoo en écriture non configuré' };
  const detail = await getReceipt(pickingId);
  if (!detail) return { ...res, error: 'Réception introuvable' };
  res.pickingName = detail.pickingName; res.poId = detail.poId; res.poName = detail.poName; res.vendor = detail.vendor;
  // Read back right before writing: someone may have validated it in Odoo meanwhile.
  if (detail.state === 'done') return { ...res, ok: true, alreadyDone: true };
  if (!['assigned', 'confirmed', 'waiting'].includes(detail.state)) return { ...res, error: `Réception à l'état ${detail.state}` };
  const byMove = new Map(input.map(l => [l.moveId, l]));
  if (detail.lines.some(l => !byMove.has(l.moveId))) return { ...res, error: 'La réception a changé dans Odoo — rouvrir la commande' };

  for (const l of detail.lines) {
    const i = byMove.get(l.moveId)!;
    const qty = r3(Math.max(0, Number(i.qty) || 0));
    const short = qty < l.expected - 1e-9;
    if (short && !i.reason) return { ...res, error: `${l.name}: raison manquante` };
    res.received.push({ productId: l.productId, poLineId: l.poLineId, name: l.name, uom: l.uom, expected: l.expected, received: qty,
      reason: short ? (i.reason as ShortReason) : null, note: short ? (String(i.note ?? '').trim().slice(0, 200) || null) : null });
  }

  // 1. Supplier has no more: lower the PO line and the move demand to what arrived.
  for (const r of res.received) {
    if (r.reason !== 'no_more' || !r.poLineId) continue;
    const l = detail.lines.find(x => x.poLineId === r.poLineId && x.productId === r.productId)!;
    const newPoQty = r3(l.receivedBefore + r.received);
    await odooExecuteWrite('purchase.order.line', 'write', [[r.poLineId], { product_qty: newPoQty }], { context: NO_MAIL });
    await odooExecuteWrite('stock.move', 'write', [[l.moveId], { product_uom_qty: r.received }], { context: NO_MAIL });
    res.lowered.push({ name: r.name, from: l.ordered, to: newPoQty });
    res.log.push(`PO line ${r.poLineId}: ${l.ordered} → ${newPoQty}`);
  }

  // 2. Quantities, then validate; Odoo keeps the rest on a backorder (skip_backorder, no cancel).
  for (const l of detail.lines) {
    const r = res.received.find(x => x.productId === l.productId && x.poLineId === l.poLineId)!;
    await odooExecuteWrite('stock.move', 'write', [[l.moveId], { quantity: r.received, picked: true }], { context: NO_MAIL });
  }
  const anyReceived = res.received.some(r => r.received > 0);
  if (anyReceived) {
    const v = await odooExecuteWrite<any>('stock.picking', 'button_validate', [[pickingId]],
      { context: { skip_backorder: true, button_validate_picking_ids: [pickingId], ...NO_MAIL } });
    if (v !== true) return { ...res, error: `Odoo a renvoyé une réponse inattendue à la validation : ${JSON.stringify(v).slice(0, 300)} — vérifier la réception dans Odoo` };
    const [after] = await odooExecuteWrite<any[]>('stock.picking', 'read', [[pickingId]], { fields: ['state'] });
    if (after?.state !== 'done') return { ...res, error: `Réception non validée (état ${after?.state}) — vérifier dans Odoo` };
    const bo = await odooExecuteWrite<any[]>('stock.picking', 'search_read', [[['backorder_id', '=', pickingId], ['state', '!=', 'cancel']]], { fields: ['name'], limit: 1 });
    res.backorderName = bo[0]?.name ?? null;
  } else {
    res.backorderName = null; // nothing arrived: the receipt simply stays open
  }

  const po = (await odooExecuteWrite<any[]>('purchase.order', 'read', [[detail.poId]], { fields: ['order_line', 'invoice_ids', 'name'] }))[0];
  const poLines = po?.order_line?.length ? await odooExecuteWrite<any[]>('purchase.order.line', 'read', [po.order_line],
    { fields: ['product_id', 'name', 'product_qty', 'product_uom', 'qty_received', 'qty_received_method', 'price_unit', 'taxes_id', 'analytic_distribution', 'display_type'] }) : [];

  // 3. Service lines (shipping) with a manual received quantity: received with the first delivery.
  if (anyReceived) {
    for (const pl of poLines) {
      if (pl.display_type || pl.qty_received_method !== 'manual') continue;
      if (Number(pl.qty_received) < Number(pl.product_qty)) {
        await odooExecuteWrite('purchase.order.line', 'write', [[pl.id], { qty_received: pl.product_qty }], { context: NO_MAIL });
        pl.qty_received = pl.product_qty;
        res.log.push(`service line ${pl.id} received`);
      }
    }
  }

  // 4. One bill per PO.
  if (anyReceived) {
    const bills = po?.invoice_ids?.length ? await odooExecuteWrite<any[]>('account.move', 'read', [po.invoice_ids], { fields: ['id', 'state', 'move_type', 'name'] }) : [];
    const live = bills.filter(b => b.move_type === 'in_invoice' && b.state !== 'cancel');
    const drafts = live.filter(b => b.state === 'draft');
    const posted = live.filter(b => b.state === 'posted');
    // quantity already covered by posted bills, per PO line
    const postedQty = new Map<number, number>();
    if (posted.length) {
      const pml = await odooExecuteWrite<any[]>('account.move.line', 'search_read',
        [[['move_id', 'in', posted.map(b => b.id)], ['purchase_line_id', '!=', false], ['display_type', '=', 'product']]], { fields: ['purchase_line_id', 'quantity'] });
      for (const l of pml) { const k = m2oId(l.purchase_line_id)!; postedQty.set(k, (postedQty.get(k) ?? 0) + Number(l.quantity)); }
    }
    const want = (pl: any) => r3(Number(pl.qty_received) - (postedQty.get(pl.id) ?? 0));
    if (!live.length) {
      await odooExecuteWrite('purchase.order', 'action_create_invoice', [[detail.poId]], { context: NO_MAIL });
      const [po2] = await odooExecuteWrite<any[]>('purchase.order', 'read', [[detail.poId]], { fields: ['invoice_ids'] });
      res.bill = { id: (po2?.invoice_ids ?? []).slice(-1)[0] ?? null, action: 'created' };
    } else if (drafts.length) {
      const bill = drafts[0];
      const bl = await odooExecuteWrite<any[]>('account.move.line', 'search_read',
        [[['move_id', '=', bill.id], ['display_type', '=', 'product']]], { fields: ['id', 'purchase_line_id', 'quantity'] });
      const ops: any[] = [];
      for (const pl of poLines) {
        if (pl.display_type) continue;
        const target = Math.max(0, want(pl));
        const line = bl.find(x => m2oId(x.purchase_line_id) === pl.id);
        if (line) {
          if (Math.abs(Number(line.quantity) - target) > 1e-6) ops.push([1, line.id, { quantity: target }]);
        } else if (target > 0) {
          ops.push([0, 0, { purchase_line_id: pl.id, product_id: m2oId(pl.product_id), name: pl.name, quantity: target,
            price_unit: pl.price_unit, product_uom_id: m2oId(pl.product_uom), tax_ids: [[6, 0, pl.taxes_id ?? []]],
            ...(pl.analytic_distribution ? { analytic_distribution: pl.analytic_distribution } : {}) }]);
        }
      }
      if (ops.length) await odooExecuteWrite('account.move', 'write', [[bill.id], { invoice_line_ids: ops }], { context: NO_MAIL });
      res.bill = { id: bill.id, action: 'aligned', gaps: drafts.length > 1 ? [`${drafts.length} brouillons sur la commande — seul le premier est aligné`] : undefined };
    } else {
      const gaps: string[] = [];
      for (const pl of poLines) {
        if (pl.display_type) continue;
        const diff = r3(Number(pl.qty_received) - (postedQty.get(pl.id) ?? 0));
        if (Math.abs(diff) > 1e-6) gaps.push(`${m2oName(pl.product_id) ?? pl.name}: reçu ${pl.qty_received}, facturé ${postedQty.get(pl.id) ?? 0}`);
      }
      res.bill = { id: posted[0]?.id ?? null, action: 'posted_untouched', gaps };
    }
  }

  // 5. Notes (VI + EN) on the receipt and on the PO.
  const at = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false });
  const body = noteHtml(by, at, res.received, res.backorderName ?? null);
  try { await odooExecuteWrite('stock.picking', 'message_post', [[pickingId]], { body, message_type: 'comment', subtype_xmlid: 'mail.mt_note' }); } catch (e: any) { res.log.push(`note picking: ${e?.message ?? e}`); }
  try { await odooExecuteWrite('purchase.order', 'message_post', [[detail.poId]], { body, message_type: 'comment', subtype_xmlid: 'mail.mt_note' }); } catch (e: any) { res.log.push(`note PO: ${e?.message ?? e}`); }

  res.ok = true;
  return res;
}
