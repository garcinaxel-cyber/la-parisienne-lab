import { odooExecute, odooExecuteWrite, odooWriteConfigured, labDateOf, labLocalToOdooUtc, LAB_TZ } from '@/lib/odoo';
import { SHOP_CONFIG } from '@/lib/shops';

// Phase 3 of the shop portal plan (Axel, 2026-09-03): a shop manager places a real stock
// replenishment (REP) order directly from the portal, PIN-gated (verifyManagerPinAction /
// resolveManager in src/app/shop/actions.ts check the PIN server-side before this is ever
// called — this module trusts its caller and does no auth itself). Deliberately its OWN
// module, separate from odoo-shop-order-sync.ts — Axel: "je ne veux pas que tu considere cette
// commande comme les commandes exceptionnel manuels". That module claims/writes lab_manual_cakes
// rows and leaves the Odoo document in draft for a human to validate later; this one touches no
// lab_manual_cakes row at all, and ALWAYS auto-confirms at creation (see below) so the order
// reaches the chefs' production queue immediately, exactly like any other confirmed order —
// "l'app lira la commande pour les chefs comme le process actuel".

function tmo<T>(p: Promise<T>, ms: number, l: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, r) => setTimeout(() => r(new Error('timeout ' + l)), ms))]);
}

// Suppresses Odoo's automatic chatter/email notifications on these writes — same context object
// odoo-delivery-validate.ts already uses for its own state-changing calls.
const NO_MAIL_CONTEXT = { tracking_disable: true, mail_notrack: true, mail_create_nolog: true, mail_notify_force_send: false };

export interface ManagerOrderLine {
  sku: string;
  name: string; // display name only, for the audit snapshot — never sent to Odoo as a line label
  qty: number;
  note?: string;
}

export interface ManagerOrderResult {
  ok: boolean;
  orderRef?: string;
  deliveryDate?: string; // 'YYYY-MM-DD', lab-local
  error?: string;
}

// Lab-local calendar date `daysAhead` days from today (today+1 = tomorrow), computed via
// UTC date-math on the lab-local calendar date rather than a raw +24h offset so it can never
// land on the wrong side of a timezone boundary (VN = UTC+7, no DST).
function labDateOffset(daysAhead: number): string {
  const todayLocal = labDateOf(new Date().toISOString())!;
  const d = new Date(todayLocal + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + daysAhead);
  return d.toISOString().split('T')[0];
}

// Tomorrow's lab-local calendar date — the EARLIEST a manager may ever pick. Same-day delivery
// stays permanently out of scope for this feature (Axel, 2026-09-03, reconfirmed same day:
// "aucune commande le jour meme") — same "same-day stays exceptional, never auto-handled"
// posture as odoo-order-lock.ts's lockTomorrowOrders.
export function tomorrowLabDate(): string {
  return labDateOffset(1);
}

// How far ahead a manager may pick a delivery date. A safety backstop against a fat-fingered
// date (a stray digit landing years out) — NOT a business rule; Axel only ruled out a TIME
// cutoff for J+2-and-beyond, not a date range cap. Raise this if 90 days turns out too tight.
const MAX_DELIVERY_DAYS_AHEAD = 90;

// Managers may only place an order for TOMORROW (J+1) before 14h00 lab-local — Axel,
// 2026-09-03: "avant 14h le jour j, aucune commande le jour meme" reinforces the next-day floor
// above with a hard ordering-window cutoff for that specific date, so the lab gets the
// afternoon to plan tomorrow's production against everything ordered on time. Axel's follow-up
// the same day is explicit this cutoff does NOT extend to J+2 and beyond — "laisser la
// possibilite de commander les Jour J+2 et plus, y a pas de limite d'horaire pour ca" — ordering
// further ahead is allowed at any hour. Deliberately separate from odoo-order-lock.ts's
// 16h/23h59 job, which LOCKS already-entered assistant orders — this gate instead blocks a
// manager from CREATING a brand-new confirmed order for tomorrow specifically, once past the
// deadline.
const ORDER_CUTOFF_HOUR = 14;

export function isManagerOrderWindowOpenForTomorrow(): boolean {
  const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: LAB_TZ, hour: '2-digit', hour12: false });
  const hourPart = fmt.formatToParts(new Date()).find(p => p.type === 'hour')?.value ?? '00';
  const hour = hourPart === '24' ? 0 : Number(hourPart);
  return hour < ORDER_CUTOFF_HOUR;
}

// Validates a manager-picked delivery date server-side — never trust the client's
// <input type="date"> min attribute alone. Must be a real 'YYYY-MM-DD' at or after tomorrow,
// within the sanity backstop above, and if it's specifically tomorrow, still within 14h00.
function validateDeliveryDate(date: string): { ok: true } | { ok: false; error: string } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, error: 'Ngày giao không hợp lệ' };
  const min = tomorrowLabDate();
  const max = labDateOffset(MAX_DELIVERY_DAYS_AHEAD);
  if (date < min) return { ok: false, error: 'Không thể đặt giao cho hôm nay hoặc ngày đã qua — chọn từ ngày mai trở đi' };
  if (date > max) return { ok: false, error: `Ngày giao quá xa (tối đa ${MAX_DELIVERY_DAYS_AHEAD} ngày) — vui lòng liên hệ quản lý` };
  if (date === min && !isManagerOrderWindowOpenForTomorrow()) {
    return { ok: false, error: `Đã hết giờ đặt hàng cho ngày mai (chỉ nhận trước ${ORDER_CUTOFF_HOUR}h00) — vui lòng chọn từ ngày kia trở đi hoặc quay lại vào sáng mai` };
  }
  return { ok: true };
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

async function resolveProducts(skus: string[]): Promise<Record<string, { id: number }>> {
  if (!skus.length) return {};
  const rows = await tmo(odooExecute<any[]>('product.product', 'search_read',
    [[['default_code', 'in', skus]]], { fields: ['id', 'default_code'], limit: 2000 }), 20000, 'products');
  const out: Record<string, { id: number }> = {};
  for (const p of rows) if (p.default_code) out[p.default_code] = { id: p.id };
  return out;
}

// Creates ONE stock.replenishment.request for shopName's own warehouse, sourced from LAB,
// delivery = tomorrow (lab-local), then IMMEDIATELY confirms it — action_submit (draft ->
// submitted) then action_approve (submitted -> approved), the exact same two-step transition
// odoo-order-lock.ts's lockTomorrowOrders already runs daily in production for regular orders
// hitting the 16h deadline. Landing on 'approved' here (rather than leaving it in 'draft' the
// way the exceptional-orders flow deliberately does) is what makes this "confirmed like any
// other order" — odoo-sync.ts already picks up draft/submitted/approved either way, but only
// approved reflects a document nobody still needs to validate by hand.
//
// On a failure that happens WHILE the document is still in 'draft' (product resolution done,
// but before action_submit succeeds — e.g. a line create fails), the document is unlinked
// (best-effort) so a half-built draft is never left behind — same rollback pattern as
// odoo-shop-order-sync.ts's createOdooOrderForSelection. But once action_submit has actually
// gone through, the document is no longer a throwaway draft — it represents real stock demand,
// and Odoo may refuse to unlink it anyway. So on any failure AFTER that point (action_approve
// itself failing, or the final name-read failing after approval), this does NOT attempt to
// delete it — it re-reads the document's current state and folds its ref + state into the error
// message instead, so the failure is never silently reported as "nothing happened" while a real,
// possibly-approved order sits in Odoo unlinked from anything the manager or the app knows about.
export async function createManagerReplenishment(
  shopName: string,
  lines: ManagerOrderLine[],
  deliveryDate: string,
): Promise<ManagerOrderResult> {
  const dateCheck = validateDeliveryDate(deliveryDate);
  if (!dateCheck.ok) return { ok: false, error: dateCheck.error };
  if (!odooWriteConfigured()) return { ok: false, error: 'Compte Odoo en écriture non configuré' };
  const validLines = lines.filter(l => l.sku && l.qty > 0);
  if (!validLines.length) return { ok: false, error: 'Aucune ligne valide dans la commande' };

  const map = SHOP_CONFIG[shopName];
  if (!map || map.docType !== 'replenishment' || !map.warehouseCode) {
    return { ok: false, error: `Boutique "${shopName}" non configurée pour les commandes de réapprovisionnement` };
  }

  const wh = await resolveWarehouseId(map.warehouseCode);
  if (!wh) return { ok: false, error: `Entrepôt Odoo "${map.warehouseCode}" introuvable` };
  const sourceWh = await resolveWarehouseId('LAB');
  if (!sourceWh) return { ok: false, error: 'Entrepôt source Odoo "LAB" introuvable' };

  const skus = Array.from(new Set(validLines.map(l => l.sku)));
  let products: Record<string, { id: number }>;
  try {
    products = await resolveProducts(skus);
  } catch (e: any) {
    return { ok: false, error: `Recherche produit Odoo échouée : ${String(e?.message ?? e)}` };
  }
  const missing = skus.filter(s => !products[s]);
  if (missing.length) return { ok: false, error: `Produit(s) introuvable(s) dans Odoo : ${missing.join(', ')}` };

  let reqId: number | undefined;
  let submitted = false; // true once action_submit has actually gone through — see doc comment above
  try {
    reqId = await tmo(odooExecuteWrite<number>('stock.replenishment.request', 'create', [{
      warehouse_id: wh.id,
      source_warehouse_id: sourceWh.id,
      delivery_date: labLocalToOdooUtc(deliveryDate),
    }], { context: NO_MAIL_CONTEXT }), 25000, 'create replenishment');

    for (const l of validLines) {
      const p = products[l.sku];
      const note = l.note?.trim();
      await tmo(odooExecuteWrite('stock.replenishment.request.line', 'create', [{
        request_id: reqId,
        product_id: p.id,
        quantity_requested: l.qty,
        ...(note ? { note } : {}),
      }], { context: NO_MAIL_CONTEXT }), 20000, 'create replenishment line');
    }

    // Confirm immediately — see the function doc comment above for why this differs from the
    // exceptional-orders flow, which deliberately leaves the document in draft.
    await tmo(odooExecuteWrite('stock.replenishment.request', 'action_submit', [[reqId]], { context: NO_MAIL_CONTEXT }), 20000, 'submit replenishment');
    submitted = true;
    await tmo(odooExecuteWrite('stock.replenishment.request', 'action_approve', [[reqId]], { context: NO_MAIL_CONTEXT }), 20000, 'approve replenishment');

    const [req] = await tmo(odooExecuteWrite<any[]>('stock.replenishment.request', 'read', [[reqId]], { fields: ['name'] }), 15000, 'read replenishment');
    const orderRef = req?.name;
    if (!orderRef) return { ok: false, error: `Commande créée et confirmée dans Odoo (id ${reqId}) mais référence introuvable — vérifier manuellement dans Odoo` };

    return { ok: true, orderRef, deliveryDate };
  } catch (e: any) {
    const baseError = String(e?.message ?? e);
    if (reqId && !submitted) {
      // Still safely a draft (or line creation failed before submit was even attempted) — clean up.
      try { await odooExecuteWrite('stock.replenishment.request', 'unlink', [[reqId]]); } catch { /* best-effort */ }
      return { ok: false, error: baseError };
    }
    if (reqId && submitted) {
      // Already submitted (maybe approved) in Odoo — never delete real stock demand. Surface
      // its current ref/state so this never looks like "nothing happened" when something did.
      try {
        const [cur] = await tmo(odooExecute<any[]>('stock.replenishment.request', 'read', [[reqId]], { fields: ['name', 'state'] }), 15000, 'read state after failure');
        return { ok: false, error: `Erreur après confirmation partielle de ${cur?.name ?? `id ${reqId}`} (état actuel : ${cur?.state ?? 'inconnu'}) — la commande existe peut-être déjà dans Odoo, vérifier avant de recommencer. Détail : ${baseError}` };
      } catch {
        return { ok: false, error: `Erreur après confirmation partielle de la commande id ${reqId} dans Odoo — vérifier manuellement avant de recommencer. Détail : ${baseError}` };
      }
    }
    return { ok: false, error: baseError };
  }
}
