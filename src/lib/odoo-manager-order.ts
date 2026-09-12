import { odooExecute, odooExecuteWrite, odooWriteConfigured, labDateOf, labLocalToOdooUtc, LAB_TZ } from '@/lib/odoo';
import { SHOP_CONFIG } from '@/lib/shops';
import { resolvePartnerId, resolveSoLineUomField } from '@/lib/odoo-shop-order-sync';
import { resolveEventShopConfig } from '@/lib/event-shops';

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
  deliveryTime?: string; // 'HH:MM', lab-local
  error?: string;
}

const DEFAULT_DELIVERY_TIME = '09:00';

// Manager-picked delivery time — anything that isn't a real 'HH:MM' falls back to the same
// 09:00 default labLocalToOdooUtc itself already defaults to, so a stray/empty value never
// breaks the Odoo write, it just loses the manager's specific-time intent for that one order.
function cleanDeliveryTime(time: string | undefined): string {
  return time && /^\d{2}:\d{2}$/.test(time) ? time : DEFAULT_DELIVERY_TIME;
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
// within the sanity backstop above.
//
// The 14h00 cutoff for a tomorrow delivery is NO LONGER a hard block (Axel, 2026-09-08:
// "je voudrais que tu laisse la possibilite de commander apres 2 pm ... mais je veux un bon
// texte en rouge leur disant qu'ils ne respectent pas le process"). A manager can still submit
// after 14h00 with their PIN — the client shows a prominent red warning instead of refusing the
// order (see ShopView.tsx's orderTomorrowOpen banner). isManagerOrderWindowOpenForTomorrow()
// stays exported purely for that UI warning and for nudging the date picker's default away from
// tomorrow once it's past cutoff; it no longer gates anything here.
function validateDeliveryDate(date: string, _skipWindowCheck = false): { ok: true } | { ok: false; error: string } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, error: 'Ngày giao không hợp lệ' };
  const min = tomorrowLabDate();
  const max = labDateOffset(MAX_DELIVERY_DAYS_AHEAD);
  if (date < min) return { ok: false, error: 'Không thể đặt giao cho hôm nay hoặc ngày đã qua — chọn từ ngày mai trở đi' };
  if (date > max) return { ok: false, error: `Ngày giao quá xa (tối đa ${MAX_DELIVERY_DAYS_AHEAD} ngày) — vui lòng liên hệ quản lý` };
  return { ok: true };
}

const warehouseCache = new Map<string, { id: number; name: string } | null>();
async function resolveWarehouseId(code: string): Promise<{ id: number; name: string } | null> {
  if (warehouseCache.has(code)) return warehouseCache.get(code)!;
  // '=ilike' (not '=') so an event shop's code — typed by Axel directly in Odoo, any case —
  // still resolves against the uppercased code stored in lab_event_shops.
  const rows = await tmo(odooExecute<any[]>('stock.warehouse', 'search_read',
    [[['code', '=ilike', code]]], { fields: ['id', 'name'], limit: 1 }), 15000, 'warehouse');
  const w = rows[0] ? { id: rows[0].id, name: rows[0].name } : null;
  warehouseCache.set(code, w);
  return w;
}

async function resolveProducts(skus: string[]): Promise<{ products: Record<string, { id: number; uom_id: number }>; archivedSkus: Set<string> }> {
  if (!skus.length) return { products: {}, archivedSkus: new Set() };
  const rows = await tmo(odooExecute<any[]>('product.product', 'search_read',
    [[['default_code', 'in', skus]]], { fields: ['id', 'default_code', 'uom_id'], limit: 2000 }), 20000, 'products');
  const products: Record<string, { id: number; uom_id: number }> = {};
  for (const p of rows) if (p.default_code) products[p.default_code] = { id: p.id, uom_id: Array.isArray(p.uom_id) ? p.uom_id[0] : p.uom_id };

  // Anything still missing might genuinely not exist in Odoo, OR be archived (inactive) — the
  // search above implicitly filters active=True (Odoo ORM default), so an archived SKU looks
  // identical to a nonexistent one there. A second, active_test:false lookup restricted to just
  // the still-missing SKUs tells the two cases apart, so the shop sees "sản phẩm đã ngừng kinh
  // doanh" (discontinued) instead of the misleading "không tìm thấy" (not found) — Axel,
  // 2026-09-09: the archived-SKU order failure was showing shop staff a non-Vietnamese message.
  const stillMissing = skus.filter(s => !products[s]);
  const archivedSkus = new Set<string>();
  if (stillMissing.length) {
    const archivedRows = await tmo(odooExecute<any[]>('product.product', 'search_read',
      [[['default_code', 'in', stillMissing]]], { fields: ['default_code'], limit: 2000, context: { active_test: false } }), 20000, 'archived products');
    for (const p of archivedRows) if (p.default_code) archivedSkus.add(p.default_code);
  }
  return { products, archivedSkus };
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
  deliveryTime?: string,
  skipWindowCheck = false,
): Promise<ManagerOrderResult> {
  const dateCheck = validateDeliveryDate(deliveryDate, skipWindowCheck);
  if (!dateCheck.ok) return { ok: false, error: dateCheck.error };
  const time = cleanDeliveryTime(deliveryTime);
  if (!odooWriteConfigured()) return { ok: false, error: 'Compte Odoo en écriture non configuré' };
  const validLines = lines.filter(l => l.sku && l.qty > 0);
  if (!validLines.length) return { ok: false, error: 'Aucune ligne valide dans la commande' };

  // Event shops (Axel, 2026-09-12) aren't in the static SHOP_CONFIG — resolved dynamically
  // against lab_event_shops instead, same docType:'replenishment' shape as a real La Paris shop.
  const map = SHOP_CONFIG[shopName] ?? await resolveEventShopConfig(shopName);
  if (!map || !map.portalAccount) {
    return { ok: false, error: `Boutique "${shopName}" non configurée pour les commandes` };
  }

  const skus = Array.from(new Set(validLines.map(l => l.sku)));
  let products: Record<string, { id: number; uom_id: number }>;
  let archivedSkus: Set<string>;
  try {
    const resolved = await resolveProducts(skus);
    products = resolved.products;
    archivedSkus = resolved.archivedSkus;
  } catch (e: any) {
    console.error('[odoo-manager-order] product resolution failed:', e?.message ?? e);
    return { ok: false, error: 'Không thể tạo đơn hàng trên Odoo. Vui lòng thử lại hoặc liên hệ quản lý.' };
  }
  const missing = skus.filter(s => !products[s]);
  if (missing.length) {
    // Two Vietnamese phrasings (Axel, 2026-09-09), depending on WHY a SKU didn't resolve — an
    // archived product reads very differently to shop staff than one that's simply mistyped or
    // never existed on Odoo.
    const archived = missing.filter(s => archivedSkus.has(s));
    const notFound = missing.filter(s => !archivedSkus.has(s));
    const parts: string[] = [];
    if (archived.length) parts.push(`Sản phẩm đã ngừng kinh doanh trên Odoo: ${archived.join(', ')}`);
    if (notFound.length) parts.push(`Không tìm thấy sản phẩm trên Odoo: ${notFound.join(', ')}`);
    return { ok: false, error: parts.join(' · ') };
  }

  // Quotation-type partner (Moon Flower — Axel, 2026-09-07: "pour Moon Flower ça doit créer une
  // SO et non une REP"): one sale.order for the partner. Left in DRAFT on purpose (Axel,
  // 2026-09-08: shop orders should not auto-validate in Odoo) — odoo-order-lock.ts's 16h/23:59
  // cron (lockTomorrowOrders) is what calls action_confirm, the same transition it already
  // applies to any other draft/sent SO due tomorrow.
  // Line notes go into the sale.order.line description (the standard per-line text field on SO).
  if (map.docType === 'quotation') {
    if (!map.partnerName) return { ok: false, error: `Partenaire Odoo non configuré pour "${shopName}"` };
    const partnerId = await resolvePartnerId(map.partnerName);
    if (!partnerId) return { ok: false, error: `Partenaire Odoo "${map.partnerName}" introuvable` };
    const uomField = await resolveSoLineUomField();
    let soId: number | undefined;
    try {
      soId = await tmo(odooExecuteWrite<number>('sale.order', 'create', [{
        partner_id: partnerId,
        commitment_date: labLocalToOdooUtc(deliveryDate, time),
      }], { context: NO_MAIL_CONTEXT }), 25000, 'create sale.order');
      for (const l of validLines) {
        const p = products[l.sku];
        const note = l.note?.trim();
        await tmo(odooExecuteWrite('sale.order.line', 'create', [{
          order_id: soId, product_id: p.id, product_uom_qty: l.qty,
          ...(uomField ? { [uomField]: p.uom_id } : {}),
          name: note ? `${l.name || l.sku}\n${note}` : (l.name || l.sku),
        }], { context: NO_MAIL_CONTEXT }), 20000, 'create sale.order.line');
      }
      // Deliberately NOT calling action_confirm here — left in draft, confirmed later by
      // odoo-order-lock.ts's 16h/23:59 cron (Axel, 2026-09-08).
      const [so] = await tmo(odooExecuteWrite<any[]>('sale.order', 'read', [[soId]], { fields: ['name'] }), 15000, 'read sale.order');
      if (!so?.name) return { ok: false, error: `Commande créée dans Odoo (id ${soId}, brouillon) mais référence introuvable — vérifier manuellement dans Odoo` };
      return { ok: true, orderRef: so.name, deliveryDate, deliveryTime: time };
    } catch (e: any) {
      const baseError = String(e?.message ?? e);
      console.error('[odoo-manager-order] sale.order creation failed:', baseError);
      if (soId) {
        // Still a draft (creation always leaves it there now) — clean up on any failure.
        try { await odooExecuteWrite('sale.order', 'unlink', [[soId]]); } catch { /* best-effort */ }
      }
      // Never surface the raw Odoo/JS exception to shop staff (Axel, 2026-09-09) — baseError is
      // still logged above for ops to diagnose.
      return { ok: false, error: 'Không thể tạo đơn hàng trên Odoo. Vui lòng thử lại hoặc liên hệ quản lý.' };
    }
  }

  if (map.docType !== 'replenishment' || !map.warehouseCode) {
    return { ok: false, error: `Boutique "${shopName}" non configurée pour les commandes de réapprovisionnement` };
  }
  const wh = await resolveWarehouseId(map.warehouseCode);
  if (!wh) return { ok: false, error: `Entrepôt Odoo "${map.warehouseCode}" introuvable` };
  const sourceWh = await resolveWarehouseId('LAB');
  if (!sourceWh) return { ok: false, error: 'Entrepôt source Odoo "LAB" introuvable' };

  let reqId: number | undefined;
  try {
    reqId = await tmo(odooExecuteWrite<number>('stock.replenishment.request', 'create', [{
      warehouse_id: wh.id,
      source_warehouse_id: sourceWh.id,
      delivery_date: labLocalToOdooUtc(deliveryDate, time),
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

    // Deliberately NOT calling action_submit/action_approve here — left in draft, confirmed
    // later by odoo-order-lock.ts's 16h/23:59 cron (Axel, 2026-09-08), same as the SO branch above.
    const [req] = await tmo(odooExecuteWrite<any[]>('stock.replenishment.request', 'read', [[reqId]], { fields: ['name'] }), 15000, 'read replenishment');
    const orderRef = req?.name;
    if (!orderRef) return { ok: false, error: `Commande créée dans Odoo (id ${reqId}, brouillon) mais référence introuvable — vérifier manuellement dans Odoo` };

    return { ok: true, orderRef, deliveryDate, deliveryTime: time };
  } catch (e: any) {
    const baseError = String(e?.message ?? e);
    console.error('[odoo-manager-order] stock.replenishment.request creation failed:', baseError);
    if (reqId) {
      // Still a draft (creation always leaves it there now) — clean up on any failure.
      try { await odooExecuteWrite('stock.replenishment.request', 'unlink', [[reqId]]); } catch { /* best-effort */ }
    }
    // Never surface the raw Odoo/JS exception to shop staff (Axel, 2026-09-09) — baseError is
    // still logged above for ops to diagnose.
    return { ok: false, error: 'Không thể tạo đơn hàng trên Odoo. Vui lòng thử lại hoặc liên hệ quản lý.' };
  }
}
