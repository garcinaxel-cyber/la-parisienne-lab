'use server';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { createClient, getSafeSession } from '@/lib/supabase-server';
import { ensureDeliveryOrderChecklist, type CheckLine, type DeliveryOrderHeader } from '@/lib/delivery-check';
import {
  getScrapReasonTags, resolveProductsBySku, resolveShopWarehouseLocation, createShopScrap,
} from '@/lib/odoo-scrap';
import { prefillReplenishmentReceivedQty } from '@/lib/odoo-shop-receipt-sync';

// Shop portal data layer — two entry points into the same underlying reads/writes:
//  - the shop's OWN session (role='shop', shop_name resolved from lab_profiles).
//  - staff (admin/lab_manager/assistant) accessing any shop by name from the dashboard
//    (Axel, 2026-08-19: "je veux pouvoir accéder à leur interface... via le dashboard"; then
//    2026-08-25: "je veux exactement comme les QR code des chefs" — one click into the real,
//    fully-interactive interface for testing, not just a read-only mirror). Writes made this way
//    still go through the exact same tables/Odoo calls as a real shop confirmation — there's no
//    separate "test" data path — so ShopView shows a clear banner in this mode and the person
//    still types their own name into the same "Xác nhận bởi" field, same as a real shop user.
// Cross-cutting reads use the service-role key (same precedent as /order/[token] and the
// earlier /boutique/[token] iteration) but ONLY after the caller's session+role has been
// verified server-side first — never trust a client-supplied shop name for the shop's own
// actions; staff actions verify the caller is staff before trusting the shopName argument.

function service() {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return null;
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } },
  );
}

async function requireShopSession(): Promise<{ shopName: string } | { error: string }> {
  const supabase = createClient();
  const { data: { session } } = await getSafeSession(supabase);
  if (!session) return { error: 'Not authenticated' };
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
  if (profile?.role !== 'shop') return { error: 'Forbidden' };
  const { data: labProfile } = await supabase.from('lab_profiles').select('shop_name').eq('id', session.user.id).maybeSingle();
  if (!labProfile?.shop_name) return { error: 'Shop not configured' };
  return { shopName: labProfile.shop_name };
}

async function requireStaffSession(): Promise<{ ok: true } | { error: string }> {
  const supabase = createClient();
  const { data: { session } } = await getSafeSession(supabase);
  if (!session) return { error: 'Not authenticated' };
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
  if (!['admin', 'lab_manager', 'assistant'].includes(profile?.role ?? '')) return { error: 'Forbidden' };
  return { ok: true };
}

// Accepts either the shop's own session, OR a staff session testing AS a specific shop (Axel,
// 2026-08-25: one-click access from admin, same convenience as the station QR codes — except
// stations work by the tablet staying logged into a real per-team account, there's no token
// trick to copy; shops use ONE shared account per shop, so the equivalent here is letting staff
// act through their own already-authenticated admin session instead of switching accounts).
// explicitShopName is only trusted when the caller is staff (role check happens first) — a shop
// user's own shopName always comes from their OWN lab_profiles row, never from client input.
async function requireShopOrStaffSession(explicitShopName?: string): Promise<{ shopName: string; isStaffTest: boolean } | { error: string }> {
  const supabase = createClient();
  const { data: { session } } = await getSafeSession(supabase);
  if (!session) return { error: 'Not authenticated' };
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
  if (profile?.role === 'shop') {
    const { data: labProfile } = await supabase.from('lab_profiles').select('shop_name').eq('id', session.user.id).maybeSingle();
    if (!labProfile?.shop_name) return { error: 'Shop not configured' };
    return { shopName: labProfile.shop_name, isStaffTest: false };
  }
  if (['admin', 'lab_manager', 'assistant'].includes(profile?.role ?? '')) {
    if (!explicitShopName) return { error: 'Shop name required' };
    return { shopName: explicitShopName, isStaffTest: true };
  }
  return { error: 'Forbidden' };
}

// Same either/or check as above, for actions that aren't shop-scoped (e.g. the reason list).
async function requireShopOrStaff(): Promise<{ ok: true } | { error: string }> {
  const supabase = createClient();
  const { data: { session } } = await getSafeSession(supabase);
  if (!session) return { error: 'Not authenticated' };
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
  if (profile?.role === 'shop' || ['admin', 'lab_manager', 'assistant'].includes(profile?.role ?? '')) return { ok: true };
  return { error: 'Forbidden' };
}

// shop_name is stored inconsistently across sync sources — found live 2026-08-19 while
// testing Moon Flower (stored "MOON FLOWER", all caps) and confirmed via SQL that
// lab_order_packaging_lines additionally carries raw unprocessed forms for some shops
// ("La Paris - Bà Triệu", "La Paris - Timecity warehouse") that odoo-sync.ts's own
// ` - warehouse` suffix strip doesn't catch (different dash position). A plain ilike exact
// match isn't enough, so every read here normalizes both sides the same way before comparing
// instead of filtering in the SQL query itself.
function normalizeShopName(s: string | null | undefined): string {
  return (s ?? '')
    .toLowerCase()
    .replace(/\s*warehouse\s*$/, '')
    .replace(/^la paris\s*-\s*/, 'la paris ')
    .replace(/\s+/g, ' ')
    .trim();
}

function labTodayTomorrow(): [string, string] {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' });
  const now = new Date();
  const today = fmt.format(now);
  const tomorrow = fmt.format(new Date(now.getTime() + 24 * 3600 * 1000));
  return [today, tomorrow];
}

export type ShopDeliveryOrder = {
  header: Pick<DeliveryOrderHeader, 'id' | 'order_ref' | 'delivery_date' | 'shop_name'>;
  lines: (CheckLine & { receipt: { qty_received: number | null; status: string; note: string | null; confirmed_by_name: string; confirmed_at: string } | null; image_url: string | null })[];
};

async function fetchDeliveries(shopName: string): Promise<ShopDeliveryOrder[]> {
  const supabase = service();
  if (!supabase) return [];
  const [today, tomorrow] = labTodayTomorrow();

  // Same source-of-truth as the main delivery-check index page (lab_order_lines +
  // lab_order_packaging_lines), not lab_delivery_orders directly — an order no assistant has
  // opened yet still needs to show up, with its checklist materialized on the fly via the same
  // idempotent helper the assistants' own pages use.
  // No shop_name filter in the query itself — only 2 dates' worth of rows across every shop,
  // cheap to fetch, then filtered with normalizeShopName() below (see its comment for why).
  const target = normalizeShopName(shopName);
  const { data: orderLines } = await supabase.from('lab_order_lines')
    .select('order_ref, delivery_date, shop_name').in('delivery_date', [today, tomorrow]).gt('qty', 0);
  const { data: packagingLines } = await supabase.from('lab_order_packaging_lines')
    .select('order_ref, delivery_date, shop_name').in('delivery_date', [today, tomorrow]);

  const pairs = new Map<string, { date: string; orderRef: string }>();
  for (const l of [...(orderLines ?? []), ...(packagingLines ?? [])]) {
    if (normalizeShopName(l.shop_name) !== target) continue;
    pairs.set(`${l.delivery_date}||${l.order_ref}`, { date: l.delivery_date, orderRef: l.order_ref });
  }

  const orders: ShopDeliveryOrder[] = [];
  for (const { date, orderRef } of Array.from(pairs.values())) {
    const { header, lines } = await ensureDeliveryOrderChecklist(supabase as any, date, orderRef);
    const lineIds = lines.map(l => l.id);
    const { data: receipts } = lineIds.length
      ? await supabase.from('lab_shop_receipt_lines')
          .select('check_line_id, qty_received, status, note, confirmed_by_name, confirmed_at').in('check_line_id', lineIds)
      : { data: [] as any[] };
    const receiptByLine: Record<string, any> = {};
    for (const r of receipts ?? []) receiptByLine[r.check_line_id] = r;
    orders.push({
      header: { id: header.id, order_ref: header.order_ref, delivery_date: header.delivery_date, shop_name: header.shop_name },
      lines: lines.map(l => ({ ...l, receipt: receiptByLine[l.id] ?? null, image_url: null as string | null })),
    });
  }

  // Product photos — helps the shop visually confirm they're checking the right item (Axel,
  // 2026-08-25: "rajoute la photo des produits pour qu'ils check facilement"). Best-effort only:
  // a missing/unmatched image never blocks anything, the line just renders without a thumbnail.
  // Looked up by SKU against lab_fiche_variants, but that table's own image_url is null for most
  // products in practice (verified 2026-08-25 — first version of this only checked the variant
  // and came back with zero photos) — the real image almost always lives on the FICHE
  // (lab_fiche_meta.image_url), same fallback order /api/lab/products-search already uses
  // (dv?.image_url ?? f.image_url). Purely additive reads, no change to
  // ensureDeliveryOrderChecklist / lab_delivery_check_lines.
  const allSkus = Array.from(new Set(orders.flatMap(o => o.lines.map(l => l.sku).filter(Boolean)))) as string[];
  if (allSkus.length) {
    const { data: variantRows } = await supabase.from('lab_fiche_variants')
      .select('sku, image_url, fiche_id').in('sku', allSkus);
    const imageBySku: Record<string, string> = {};
    const ficheIdBySku: Record<string, string> = {};
    for (const v of variantRows ?? []) {
      if (v.sku && v.image_url && !imageBySku[v.sku]) imageBySku[v.sku] = v.image_url;
      if (v.sku && v.fiche_id && !ficheIdBySku[v.sku]) ficheIdBySku[v.sku] = v.fiche_id;
    }
    const missingFicheIds = Array.from(new Set(
      allSkus.filter(sku => !imageBySku[sku] && ficheIdBySku[sku]).map(sku => ficheIdBySku[sku]),
    ));
    if (missingFicheIds.length) {
      const { data: ficheRows } = await supabase.from('lab_fiche_meta')
        .select('id, image_url').in('id', missingFicheIds);
      const imageByFiche: Record<string, string> = {};
      for (const f of ficheRows ?? []) if (f.image_url) imageByFiche[f.id] = f.image_url;
      for (const sku of allSkus) {
        if (!imageBySku[sku] && ficheIdBySku[sku] && imageByFiche[ficheIdBySku[sku]]) {
          imageBySku[sku] = imageByFiche[ficheIdBySku[sku]];
        }
      }
    }
    for (const o of orders) for (const l of o.lines) if (l.sku && imageBySku[l.sku]) l.image_url = imageBySku[l.sku];
  }

  orders.sort((a, b) => a.header.delivery_date.localeCompare(b.header.delivery_date) || a.header.order_ref.localeCompare(b.header.order_ref));
  return orders;
}

export type ShopCake = {
  id: string; name: string; qty: number; deliveryDate: string; readyTime: string | null;
  status: 'pending' | 'confirmed' | 'cancelled'; matchedRef: string | null; cancelReason: string | null;
  customerName: string | null; customerPhone: string | null; deliveryAddress: string | null; note: string | null;
};

async function fetchCakes(shopName: string): Promise<ShopCake[]> {
  const supabase = service();
  if (!supabase) return [];
  const target = normalizeShopName(shopName);
  const since = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
  const { data } = await supabase.from('lab_manual_cakes')
    .select('id, product_name_vi, qty, delivery_date, ready_time, matched_order_ref, cancelled_at, cancel_reason, customer_name, customer_phone, delivery_address, notes, message, shop_name')
    .gte('delivery_date', since)
    .order('delivery_date', { ascending: true }).limit(500);

  return (data ?? []).filter((c: any) => normalizeShopName(c.shop_name) === target).slice(0, 50).map((c: any) => {
    const realRef = c.matched_order_ref && c.matched_order_ref !== '__pending_create__' ? c.matched_order_ref : null;
    const note = [c.notes, c.message].filter(Boolean).join(' — ') || null;
    return {
      id: c.id, name: c.product_name_vi, qty: c.qty, deliveryDate: c.delivery_date, readyTime: c.ready_time ?? null,
      status: c.cancelled_at ? 'cancelled' : realRef ? 'confirmed' : 'pending',
      matchedRef: realRef, cancelReason: c.cancel_reason ?? null,
      customerName: c.customer_name ?? null, customerPhone: c.customer_phone ?? null,
      deliveryAddress: c.delivery_address ?? null, note,
    };
  });
}

// ── Shop's own session ──────────────────────────────────────────────────────
export async function getMyShopDeliveriesAction(): Promise<{ shopName?: string; orders?: ShopDeliveryOrder[]; today?: string; tomorrow?: string; error?: string }> {
  const auth = await requireShopSession();
  if ('error' in auth) return { error: auth.error };
  const [today, tomorrow] = labTodayTomorrow();
  return { shopName: auth.shopName, orders: await fetchDeliveries(auth.shopName), today, tomorrow };
}

export async function getMyShopCakesAction(): Promise<{ cakes?: ShopCake[]; error?: string }> {
  const auth = await requireShopSession();
  if ('error' in auth) return { error: auth.error };
  return { cakes: await fetchCakes(auth.shopName) };
}

export async function confirmReceiptAction(input: {
  checkLineId: string; deliveryOrderId: string; qtyReceived: number | null; status: 'ok' | 'issue'; note: string | null; confirmedByName: string;
  shopName?: string; // only used (and only trusted) when the caller is staff testing as this shop
}): Promise<{ ok?: boolean; error?: string }> {
  const auth = await requireShopOrStaffSession(input.shopName);
  if ('error' in auth) return { error: auth.error };
  const supabase = service();
  if (!supabase) return { error: 'Server not configured' };

  const name = (input.confirmedByName ?? '').trim().slice(0, 80);
  if (!name) return { error: 'Name required' };

  // Defense in depth: re-verify this check line really belongs to an order for THIS shop
  // before writing — never trust the client-supplied deliveryOrderId pairing blindly.
  const { data: header } = await supabase.from('lab_delivery_orders')
    .select('id, shop_name, order_ref, source_type').eq('id', input.deliveryOrderId).maybeSingle();
  // Normalized compare — same shop_name inconsistency as fetchDeliveries above.
  if (!header || normalizeShopName(header.shop_name) !== normalizeShopName(auth.shopName)) return { error: 'Order not found for this shop' };
  const { data: line } = await supabase.from('lab_delivery_check_lines')
    .select('id').eq('id', input.checkLineId).eq('delivery_order_id', input.deliveryOrderId).maybeSingle();
  if (!line) return { error: 'Line not found' };

  const { error } = await supabase.from('lab_shop_receipt_lines').upsert({
    check_line_id: input.checkLineId, delivery_order_id: input.deliveryOrderId, shop_name: auth.shopName,
    qty_received: input.qtyReceived, status: input.status, note: input.note ? input.note.slice(0, 300) : null,
    confirmed_by_name: name, confirmed_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }, { onConflict: 'check_line_id' });
  if (error) return { error: error.message };

  // Axel, 2026-08-27: once the shop has confirmed EVERY line of a REPLENISHMENT order's receipt
  // check, prefill Odoo's own quantity_received per line (see odoo-shop-receipt-sync.ts) — never
  // for sales_order (Moon Flower), which has no equivalent field. Re-checked (and re-pushed,
  // harmlessly idempotent) on every subsequent confirm call too, so a shop correcting a qty after
  // "finishing" still reaches Odoo. Best-effort only: never blocks or surfaces an error back to
  // the shop's own confirm click — a push failure here just means someone checks Odoo manually.
  if (header.source_type === 'replenishment') {
    void prefillReceivedQtyIfComplete(supabase, input.deliveryOrderId, header.order_ref);
  }

  return { ok: true };
}

async function prefillReceivedQtyIfComplete(
  supabase: ReturnType<typeof service>, deliveryOrderId: string, orderRef: string,
): Promise<void> {
  try {
    if (!supabase) return;
    const { data: checkLines } = await supabase.from('lab_delivery_check_lines')
      .select('id, sku').eq('delivery_order_id', deliveryOrderId);
    if (!checkLines?.length) return;
    const lineIds = checkLines.map(l => l.id);
    const { data: receipts } = await supabase.from('lab_shop_receipt_lines')
      .select('check_line_id, qty_received').in('check_line_id', lineIds);
    const receiptByLine = new Map((receipts ?? []).map(r => [r.check_line_id, r.qty_received as number | null]));
    // Every check line must have a receipt row before this order counts as "finished" —
    // an in-progress order (some lines not yet touched by the shop) is never pushed.
    if (!checkLines.every(l => receiptByLine.has(l.id))) return;

    const toPush = checkLines
      .filter(l => l.sku && receiptByLine.get(l.id) != null)
      .map(l => ({ sku: l.sku as string, qtyReceived: receiptByLine.get(l.id) as number }));
    if (!toPush.length) return;
    await prefillReplenishmentReceivedQty(orderRef, toPush);
  } catch (e) {
    console.error(`prefillReceivedQtyIfComplete failed for ${orderRef}:`, e);
  }
}

// ── Staff preview (read-only, any shop by name) ─────────────────────────────
export async function getShopDeliveriesForStaffAction(shopName: string): Promise<{ orders?: ShopDeliveryOrder[]; today?: string; tomorrow?: string; error?: string }> {
  const auth = await requireStaffSession();
  if ('error' in auth) return { error: auth.error };
  const [today, tomorrow] = labTodayTomorrow();
  return { orders: await fetchDeliveries(shopName), today, tomorrow };
}

export async function getShopCakesForStaffAction(shopName: string): Promise<{ cakes?: ShopCake[]; error?: string }> {
  const auth = await requireStaffSession();
  if ('error' in auth) return { error: auth.error };
  return { cakes: await fetchCakes(shopName) };
}

// getMyShopLossesAction's staff-driven counterpart — same query, just scoped to an
// explicit/staff-supplied shopName instead of the caller's own lab_profiles row.
export async function getShopLossesForStaffAction(shopName: string): Promise<{ losses?: ShopLoss[]; error?: string }> {
  const auth = await requireStaffSession();
  if ('error' in auth) return { error: auth.error };
  const supabase = service();
  if (!supabase) return { error: 'Server not configured' };
  const { data, error } = await supabase.from('lab_shop_losses')
    .select('id, sku, product_name, qty, reason_tag_name, note, odoo_scrap_id, odoo_sync_error, reported_by_name, reported_at')
    .eq('shop_name', shopName)
    .order('reported_at', { ascending: false })
    .limit(50);
  if (error) return { error: error.message };
  return {
    losses: (data ?? []).map(r => ({
      id: r.id, sku: r.sku, productName: r.product_name, qty: Number(r.qty),
      reasonTagName: r.reason_tag_name, note: r.note, odooScrapId: r.odoo_scrap_id, odooSyncError: r.odoo_sync_error,
      reportedByName: r.reported_by_name, reportedAt: r.reported_at,
    })),
  };
}

// ── Pertes (daily product loss / scrap) ─────────────────────────────────────
// Axel, 2026-08-21: chaque boutique doit pouvoir enregistrer ses pertes de produits tous les
// jours avec une raison — reads/writes local (lab_shop_losses, v48) same pattern as the receipt
// confirmation above (defense-in-depth re-verification, service-role writes, requireShopSession
// gate). The Odoo side (stock.scrap) is best-effort: a shop's loss report is never lost locally
// just because the Odoo sync failed — the failure is recorded (odoo_sync_error) so an admin can
// follow up, never silently swallowed and never blocking the local report.
//
// Moon Flower has no Odoo warehouse mapping (external client, not a La Paris warehouse — see
// odoo-scrap.ts) — resolveShopWarehouseLocation() returns null for it, so createShopScrap()
// fails gracefully with a clear message rather than ever falling back to LAB's own location.

export type ShopLossReason = { id: number; name: string };

// Axel, 2026-08-25: "reduit le nombre de raison stp : casse, perime" — the picker used to list
// every stock.scrap.reason.tag from Odoo; now trimmed down to just the "broken" and "expired"
// family of reasons. Matched by keyword (diacritics-insensitive) against whatever the tags are
// actually named in Odoo, NOT hardcoded ids — the write path still needs a real Odoo tag id, and
// this way it keeps working even if the exact wording differs from what's guessed here. Safety
// net: if nothing matches (tags renamed, or named entirely differently), falls back to the full
// list instead of silently leaving the shop with an empty picker.
function normalizeReasonName(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}
const BROKEN_REASON_KEYWORDS = ['vo', 'hong', 'gay', 'be ', 'nut', 'casse', 'broken', 'damage'];
const EXPIRED_REASON_KEYWORDS = ['het han', 'han su dung', 'perime', 'expired', 'expiry', 'qua han', 'het date'];
// Axel, 2026-08-29: manager asked to add "Test" and "out of date" as reasons. Both already exist
// as real Odoo tags -- confirmed live via stock.scrap.reason.tag: id 9 "test" and id 6 "hết date"
// ("out of date", diacritics stripped by normalizeReasonName below to "het date" -- added above,
// doesn't match the existing "het han"/"qua han" expired phrasing so it fell through unseen).
// "test" alone was invisible too since it matches neither the broken nor expired family. "làm
// hàng thử" (id 3, "made trial product") is the same family as "test" -- included here too.
const TEST_REASON_KEYWORDS = ['test', 'hang thu'];
function reduceLossReasons(all: ShopLossReason[]): ShopLossReason[] {
  const filtered = all.filter(r => {
    const n = normalizeReasonName(r.name);
    return BROKEN_REASON_KEYWORDS.some(k => n.includes(k)) || EXPIRED_REASON_KEYWORDS.some(k => n.includes(k)) || TEST_REASON_KEYWORDS.some(k => n.includes(k));
  });
  return filtered.length > 0 ? filtered : all;
}

export async function getShopLossReasonsAction(): Promise<{ reasons?: ShopLossReason[]; error?: string }> {
  const auth = await requireShopOrStaff();
  if ('error' in auth) return { error: auth.error };
  try {
    return { reasons: reduceLossReasons(await getScrapReasonTags()) };
  } catch (e: any) {
    return { error: e?.message ?? 'Odoo unavailable' };
  }
}

export type ShopLoss = {
  id: string; sku: string | null; productName: string; qty: number;
  reasonTagName: string; note: string | null; odooScrapId: number | null; odooSyncError: string | null;
  reportedByName: string; reportedAt: string;
};

export async function getMyShopLossesAction(): Promise<{ losses?: ShopLoss[]; error?: string }> {
  const auth = await requireShopSession();
  if ('error' in auth) return { error: auth.error };
  const supabase = service();
  if (!supabase) return { error: 'Server not configured' };
  const { data, error } = await supabase.from('lab_shop_losses')
    .select('id, sku, product_name, qty, reason_tag_name, note, odoo_scrap_id, odoo_sync_error, reported_by_name, reported_at')
    .eq('shop_name', auth.shopName)
    .order('reported_at', { ascending: false })
    .limit(50);
  if (error) return { error: error.message };
  return {
    losses: (data ?? []).map(r => ({
      id: r.id, sku: r.sku, productName: r.product_name, qty: Number(r.qty),
      reasonTagName: r.reason_tag_name, note: r.note, odooScrapId: r.odoo_scrap_id, odooSyncError: r.odoo_sync_error,
      reportedByName: r.reported_by_name, reportedAt: r.reported_at,
    })),
  };
}

export async function recordShopLossAction(input: {
  sku: string | null; productName: string; qty: number;
  reasonTagId: number; reasonTagName: string; note: string | null; reportedByName: string;
  shopName?: string; // only used (and only trusted) when the caller is staff testing as this shop
}): Promise<{ ok?: boolean; odooSynced?: boolean; odooError?: string; error?: string }> {
  const auth = await requireShopOrStaffSession(input.shopName);
  if ('error' in auth) return { error: auth.error };
  const supabase = service();
  if (!supabase) return { error: 'Server not configured' };

  const name = (input.reportedByName ?? '').trim().slice(0, 80);
  if (!name) return { error: 'Name required' };
  const productName = (input.productName ?? '').trim().slice(0, 200);
  if (!productName) return { error: 'Product required' };
  const qty = Number(input.qty);
  if (!(qty > 0)) return { error: 'Quantity must be > 0' };
  if (!input.reasonTagId || !input.reasonTagName) return { error: 'Reason required' };

  // Best-effort Odoo sync — never blocks or discards the local report.
  let odooScrapId: number | null = null;
  let odooSyncError: string | null = null;
  try {
    if (input.sku) {
      const products = await resolveProductsBySku([input.sku]);
      const product = products[input.sku];
      if (!product) {
        odooSyncError = `SKU "${input.sku}" introuvable sur Odoo`;
      } else {
        const result = await createShopScrap({
          shopName: auth.shopName,
          productId: product.id,
          uomId: product.uom_id,
          qty,
          reasonTagIds: [input.reasonTagId],
          origin: `Shop loss ${auth.shopName} ${new Date().toISOString().slice(0, 10)}`,
        });
        if (result.ok) odooScrapId = result.scrapId ?? null;
        else odooSyncError = result.error ?? 'Odoo sync failed';
      }
    } else {
      odooSyncError = 'Pas de SKU — non synchronisé sur Odoo';
    }
  } catch (e: any) {
    odooSyncError = e?.message ?? 'Odoo sync failed';
  }

  const { error } = await supabase.from('lab_shop_losses').insert({
    shop_name: auth.shopName, sku: input.sku, product_name: productName, qty,
    reason_tag_id: input.reasonTagId, reason_tag_name: input.reasonTagName,
    note: input.note ? input.note.slice(0, 300) : null,
    odoo_scrap_id: odooScrapId, odoo_sync_error: odooSyncError,
    reported_by_name: name, reported_at: new Date().toISOString(),
  });
  if (error) return { error: error.message };
  return { ok: true, odooSynced: !!odooScrapId, odooError: odooSyncError ?? undefined };
}

// ── Staff roster (per-shop list of names, so staff pick instead of typing) ──────────────
// Axel, 2026-08-27: "un petit bouton pour configurer les noms des staff pour qu'ils
// selectionnent direct leur nom : possibilité d'éditer". One shared list per shop, used
// wherever a name is currently typed freehand (delivery confirm + loss reports) — same
// dual shop-or-staff-session pattern as everything else in this file.
export type ShopStaffName = { id: string; name: string };

async function fetchStaffNames(shopName: string): Promise<ShopStaffName[]> {
  const supabase = service();
  if (!supabase) return [];
  const { data } = await supabase.from('lab_shop_staff_names').select('id, name').eq('shop_name', shopName).order('name');
  return (data ?? []).map(r => ({ id: r.id, name: r.name }));
}

export async function getShopStaffNamesAction(shopName?: string): Promise<{ names?: ShopStaffName[]; error?: string }> {
  const auth = await requireShopOrStaffSession(shopName);
  if ('error' in auth) return { error: auth.error };
  return { names: await fetchStaffNames(auth.shopName) };
}

export async function addShopStaffNameAction(name: string, shopName?: string): Promise<{ staffName?: ShopStaffName; error?: string }> {
  const auth = await requireShopOrStaffSession(shopName);
  if ('error' in auth) return { error: auth.error };
  const clean = name.trim().slice(0, 80);
  if (!clean) return { error: 'Name required' };
  const supabase = service();
  if (!supabase) return { error: 'Server not configured' };
  const { data, error } = await supabase.from('lab_shop_staff_names')
    .insert({ shop_name: auth.shopName, name: clean })
    .select('id, name').single();
  if (error) {
    if (/duplicate|unique/i.test(error.message)) return { error: 'Tên này đã có trong danh sách' };
    return { error: error.message };
  }
  return { staffName: { id: data.id, name: data.name } };
}

export async function renameShopStaffNameAction(id: string, newName: string, shopName?: string): Promise<{ ok?: boolean; error?: string }> {
  const auth = await requireShopOrStaffSession(shopName);
  if ('error' in auth) return { error: auth.error };
  const clean = newName.trim().slice(0, 80);
  if (!clean) return { error: 'Name required' };
  const supabase = service();
  if (!supabase) return { error: 'Server not configured' };
  // Defense in depth: only ever touch a row that actually belongs to this shop.
  const { data: row } = await supabase.from('lab_shop_staff_names').select('id').eq('id', id).eq('shop_name', auth.shopName).maybeSingle();
  if (!row) return { error: 'Not found' };
  const { error } = await supabase.from('lab_shop_staff_names').update({ name: clean }).eq('id', id);
  if (error) return { error: /duplicate|unique/i.test(error.message) ? 'Tên này đã có trong danh sách' : error.message };
  return { ok: true };
}

export async function removeShopStaffNameAction(id: string, shopName?: string): Promise<{ ok?: boolean; error?: string }> {
  const auth = await requireShopOrStaffSession(shopName);
  if ('error' in auth) return { error: auth.error };
  const supabase = service();
  if (!supabase) return { error: 'Server not configured' };
  const { data: row } = await supabase.from('lab_shop_staff_names').select('id').eq('id', id).eq('shop_name', auth.shopName).maybeSingle();
  if (!row) return { error: 'Not found' };
  const { error } = await supabase.from('lab_shop_staff_names').delete().eq('id', id);
  if (error) return { error: error.message };
  return { ok: true };
}

// Used by the UI to decide whether to even show a warning about Odoo sync before the shop's
// warehouse has been checked — cheap, cached lookup, read-only.
export async function checkShopHasOdooWarehouseAction(): Promise<{ hasWarehouse?: boolean; error?: string }> {
  const auth = await requireShopSession();
  if ('error' in auth) return { error: auth.error };
  const loc = await resolveShopWarehouseLocation(auth.shopName);
  return { hasWarehouse: !!loc };
}

export type ShopLossDailyRecapProduct = { productName: string; qty: number };
export type ShopLossDailyRecap = { date: string; totalQty: number; reportCount: number; products: ShopLossDailyRecapProduct[] };

// Axel, 2026-08-29: "je veux que dans l'onglet des shops on voit dans un tableau le recap des
// pertes par jour, on garde que 7j glissant de data" — daily total (not per-line) over a
// rolling 7-day window, grouped by Vietnam calendar day (not UTC) for consistency with every
// other date bucket in this app (see labTodayTomorrow above). Display-only window — reads from
// the same lab_shop_losses rows kept indefinitely, nothing here deletes old data.
// Axel, 2026-08-29 (follow-up): "je veux que dans ce tableau il y ait le detail des produits par
// jours" — each day now also carries a per-product qty breakdown (summed across that day's
// reports), not just the daily total.
function vnLossDateStr(iso: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}

async function fetchDailyLossRecap(shopName: string): Promise<ShopLossDailyRecap[]> {
  const supabase = service();
  if (!supabase) return [];
  const since = new Date(Date.now() - 7 * 86400000).toISOString();
  const { data } = await supabase.from('lab_shop_losses')
    .select('qty, reported_at, product_name')
    .eq('shop_name', shopName)
    .gte('reported_at', since);
  const byDate = new Map<string, { totalQty: number; reportCount: number; productsByName: Map<string, number> }>();
  for (const r of data ?? []) {
    const d = vnLossDateStr(r.reported_at);
    const cur = byDate.get(d) ?? { totalQty: 0, reportCount: 0, productsByName: new Map<string, number>() };
    cur.totalQty += Number(r.qty);
    cur.reportCount += 1;
    cur.productsByName.set(r.product_name, (cur.productsByName.get(r.product_name) ?? 0) + Number(r.qty));
    byDate.set(d, cur);
  }
  return Array.from(byDate.entries())
    .map(([date, v]) => ({
      date, totalQty: v.totalQty, reportCount: v.reportCount,
      products: Array.from(v.productsByName.entries())
        .map(([productName, qty]) => ({ productName, qty }))
        .sort((a, b) => b.qty - a.qty),
    }))
    .sort((a, b) => b.date.localeCompare(a.date));
}

export async function getMyShopLossesDailyRecapAction(): Promise<{ recap?: ShopLossDailyRecap[]; error?: string }> {
  const auth = await requireShopSession();
  if ('error' in auth) return { error: auth.error };
  return { recap: await fetchDailyLossRecap(auth.shopName) };
}

export async function getShopLossesDailyRecapForStaffAction(shopName: string): Promise<{ recap?: ShopLossDailyRecap[]; error?: string }> {
  const auth = await requireStaffSession();
  if ('error' in auth) return { error: auth.error };
  return { recap: await fetchDailyLossRecap(shopName) };
}

// ── Daily stock count ("Kiểm kho") ──────────────────────────────────────────
// Axel, 2026-09-03: shops count their own stock every day, in-app only — no Odoo write for now
// ("je veux pas encore que ça se comptabilise sur Odoo, c'est pour leur info perso"; the table
// shape already matches odoo-inventory.ts's InventoryCountInput so a future push is additive).
// The checklist is NOT prefilled with quantities — only WHICH products appear on it is prefilled,
// from that shop's own order history over a rolling 2-week window ("je pense qu'il faut pas que
// le stock soit prerempli mais les produits qu'on met déjà dans la liste de comptabilisation on
// peut se baser sur ce qu'ils ont commandé avant... sur 2 semaines ça suffit"). A shop can add a
// product that isn't on that auto list — once added it's remembered for next time ("on le
// mémorise" — lab_shop_stock_count_items). Counts are editable multiple times the same day
// (Axel: "comptage modifiable") — upserted on (shop_name, sku, count_date).
//
// Axel, 2026-09-03 (follow-up): "je veux pax le packaging dans le comptage de stock et les
// produits je veux un comptage par category stp et je veux les photos des produits stp" —
// production SKUs only (packaging/matière removed entirely from this feature, both the
// order-history base list — already production-only, lab_order_lines — and the add-product
// search, which used to also offer lab_excluded_skus/Odoo packaging results), each line now
// carries its fiche category (for the UI to group by) and a product photo, resolved the same
// way the delivery-check thumbnails and the order/[token] catalog already do (variant image,
// falling back to the fiche's own image).
const STOCK_COUNT_WINDOW_DAYS = 14;

function vnDateStr(d: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

// Category + photo for a set of production SKUs — joined live from lab_fiche_variants/
// lab_fiche_meta (never stored on the count rows themselves, so a fiche's category/photo edit
// is picked up immediately on next load).
const STOCK_COUNT_FALLBACK_CATEGORY = 'Khác';

async function resolveFicheMetaBySku(skus: string[]): Promise<Record<string, { category: string; imageUrl: string | null }>> {
  const out: Record<string, { category: string; imageUrl: string | null }> = {};
  const supabase = service();
  if (!supabase || !skus.length) return out;
  const { data: vars } = await supabase.from('lab_fiche_variants').select('sku, fiche_id, image_url').in('sku', skus);
  const ficheIds = Array.from(new Set((vars ?? []).map((v: any) => v.fiche_id).filter(Boolean)));
  const { data: fiches } = ficheIds.length
    ? await supabase.from('lab_fiche_meta').select('id, category, image_url').in('id', ficheIds)
    : { data: [] as any[] };
  const ficheById: Record<string, any> = {};
  for (const f of fiches ?? []) ficheById[f.id] = f;
  for (const v of vars ?? []) {
    if (!v.sku) continue;
    const f = ficheById[v.fiche_id];
    out[v.sku] = { category: f?.category || STOCK_COUNT_FALLBACK_CATEGORY, imageUrl: v.image_url ?? f?.image_url ?? null };
  }
  return out;
}

// Which SKUs belong on this shop's checklist, and their display name — derived live from order
// history + manually-added extras, never stored itself (only the counted quantities are).
// Production only (see 2026-09-03 follow-up above) — lab_order_lines is already production-only
// demand, so the extras (lab_shop_stock_count_items) are the only place a packaging SKU could
// have slipped in before this change; addStockCountItemAction now rejects non-production SKUs
// going forward, but any already added are still hidden here as a defensive backstop.
async function stockCountBaseNames(shopName: string): Promise<Map<string, { name: string; isExtra: boolean }>> {
  const supabase = service();
  const out = new Map<string, { name: string; isExtra: boolean }>();
  if (!supabase) return out;
  const target = normalizeShopName(shopName);
  const since = new Date(Date.now() - STOCK_COUNT_WINDOW_DAYS * 86400000).toISOString().slice(0, 10);

  // Same broad-fetch-then-normalize pattern as fetchDeliveries/fetchCakes above — shop_name is
  // stored inconsistently across sync sources (see normalizeShopName's comment).
  const { data: orderLines } = await supabase.from('lab_order_lines')
    .select('product_sku, product_name_vi, shop_name').gte('delivery_date', since).gt('qty', 0).limit(10000);
  for (const l of orderLines ?? []) {
    if (!l.product_sku || normalizeShopName(l.shop_name) !== target) continue;
    if (!out.has(l.product_sku)) out.set(l.product_sku, { name: l.product_name_vi || l.product_sku, isExtra: false });
  }

  const { data: extras } = await supabase.from('lab_shop_stock_count_items').select('sku, product_name').eq('shop_name', shopName);
  const extraSkus = (extras ?? []).map((e: any) => e.sku).filter(Boolean);
  const productionExtraSkus = new Set(
    extraSkus.length ? Object.keys(await resolveFicheMetaBySku(extraSkus)) : [],
  );
  for (const e of extras ?? []) {
    if (!productionExtraSkus.has(e.sku)) continue; // drop any pre-existing packaging extra
    out.set(e.sku, { name: e.product_name, isExtra: true });
  }

  return out;
}

export type ShopStockCountLine = {
  sku: string; name: string; qty: number | null; isExtra: boolean; category: string; imageUrl: string | null;
};

async function fetchStockCountList(shopName: string): Promise<ShopStockCountLine[]> {
  const supabase = service();
  if (!supabase) return [];
  const baseNames = await stockCountBaseNames(shopName);
  const ficheMeta = await resolveFicheMetaBySku(Array.from(baseNames.keys()));

  const today = vnDateStr();
  const { data: counts } = await supabase.from('lab_shop_stock_counts')
    .select('sku, qty').eq('shop_name', shopName).eq('count_date', today);
  const qtyBySku = new Map<string, number>();
  for (const c of counts ?? []) qtyBySku.set(c.sku, Number(c.qty));

  return Array.from(baseNames.entries())
    .map(([sku, v]) => ({
      sku, name: v.name, isExtra: v.isExtra, qty: qtyBySku.has(sku) ? qtyBySku.get(sku)! : null,
      category: ficheMeta[sku]?.category ?? STOCK_COUNT_FALLBACK_CATEGORY, imageUrl: ficheMeta[sku]?.imageUrl ?? null,
    }))
    // Grouped by category in the UI — sort server-side the same way so the client can just walk
    // the array in order.
    .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
}

export async function getMyStockCountListAction(): Promise<{ shopName?: string; date?: string; lines?: ShopStockCountLine[]; error?: string }> {
  const auth = await requireShopSession();
  if ('error' in auth) return { error: auth.error };
  return { shopName: auth.shopName, date: vnDateStr(), lines: await fetchStockCountList(auth.shopName) };
}

export async function getStockCountListForStaffAction(shopName: string): Promise<{ date?: string; lines?: ShopStockCountLine[]; error?: string }> {
  const auth = await requireStaffSession();
  if ('error' in auth) return { error: auth.error };
  return { date: vnDateStr(), lines: await fetchStockCountList(shopName) };
}

export async function saveStockCountAction(input: {
  entries: { sku: string; qty: number }[];
  updatedByName: string;
  shopName?: string; // only used (and only trusted) when the caller is staff testing as this shop
}): Promise<{ ok?: boolean; saved?: number; error?: string }> {
  const auth = await requireShopOrStaffSession(input.shopName);
  if ('error' in auth) return { error: auth.error };
  const supabase = service();
  if (!supabase) return { error: 'Server not configured' };

  const name = (input.updatedByName ?? '').trim().slice(0, 80);
  if (!name) return { error: 'Name required' };
  if (!Array.isArray(input.entries) || !input.entries.length) return { error: 'No data' };

  // Re-derive names/eligibility server-side rather than trusting the client's pairing — an
  // entry for a SKU that isn't (or is no longer) on this shop's list is silently dropped.
  const baseNames = await stockCountBaseNames(auth.shopName);
  const today = vnDateStr();
  const rows = input.entries
    .filter(e => e.sku && baseNames.has(e.sku) && Number.isFinite(e.qty) && Number(e.qty) >= 0)
    .map(e => ({
      shop_name: auth.shopName, sku: e.sku, product_name: baseNames.get(e.sku)!.name,
      count_date: today, qty: Number(e.qty), updated_by_name: name, updated_at: new Date().toISOString(),
    }));
  if (!rows.length) return { error: 'No valid data' };

  const { error } = await supabase.from('lab_shop_stock_counts').upsert(rows, { onConflict: 'shop_name,sku,count_date' });
  if (error) return { error: error.message };
  return { ok: true, saved: rows.length };
}

export type ShopStockSearchProduct = { sku: string; name: string; category: string; imageUrl: string | null };

// "Add a product" search for the stock-count checklist — production catalog only (same source
// as the order/[token] flow). Packaging/matière SKUs were removed from this feature entirely
// (Axel, 2026-09-03: "je veux pax le packaging dans le comptage de stock").
export async function searchStockCountProductsAction(query: string, shopName?: string): Promise<{ products?: ShopStockSearchProduct[]; error?: string }> {
  const auth = await requireShopOrStaffSession(shopName);
  if ('error' in auth) return { error: auth.error };
  const supabase = service();
  if (!supabase) return { error: 'Server not configured' };
  const q = (query ?? '').trim().toLowerCase().slice(0, 60);

  const { data: fiches } = await supabase.from('lab_fiche_meta').select('id, name_vi, category, image_url').eq('is_active', true);
  const ficheById: Record<string, any> = {};
  for (const f of fiches ?? []) ficheById[f.id] = f;
  const ficheIds = (fiches ?? []).map(f => f.id);
  const { data: vars } = ficheIds.length
    ? await supabase.from('lab_fiche_variants').select('fiche_id, sku, label, image_url').in('fiche_id', ficheIds)
    : { data: [] as any[] };
  const skus = Array.from(new Set((vars ?? []).map((v: any) => v.sku).filter(Boolean)));
  const { data: nameRows } = skus.length
    ? await supabase.from('lab_order_lines').select('product_sku, product_name_vi').in('product_sku', skus).limit(5000)
    : { data: [] as any[] };
  const nameBySku: Record<string, string> = {};
  for (const r of nameRows ?? []) if (r.product_sku && r.product_name_vi && !nameBySku[r.product_sku]) nameBySku[r.product_sku] = r.product_name_vi;

  const production: ShopStockSearchProduct[] = (vars ?? []).flatMap((v: any) => {
    const f = ficheById[v.fiche_id];
    if (!f || !v.sku) return [];
    const label = v.label && v.label !== 'Standard' ? v.label : '';
    const name = nameBySku[v.sku] || (f.name_vi ? (label ? `${f.name_vi} · ${label}` : f.name_vi) : v.sku);
    return [{ sku: v.sku as string, name, category: f.category || STOCK_COUNT_FALLBACK_CATEGORY, imageUrl: v.image_url ?? f.image_url ?? null }];
  });

  const filtered = (q ? production.filter(p => (p.name + ' ' + p.sku).toLowerCase().includes(q)) : production)
    .sort((a, b) => a.name.localeCompare(b.name)).slice(0, 30);
  return { products: filtered };
}

export async function addStockCountItemAction(input: {
  sku: string; name: string; addedByName: string; shopName?: string;
}): Promise<{ item?: ShopStockCountLine; error?: string }> {
  const auth = await requireShopOrStaffSession(input.shopName);
  if ('error' in auth) return { error: auth.error };
  const sku = (input.sku ?? '').trim().slice(0, 60);
  const name = (input.name ?? '').trim().slice(0, 200);
  const addedBy = (input.addedByName ?? '').trim().slice(0, 80);
  if (!sku || !name) return { error: 'Product required' };
  if (!addedBy) return { error: 'Name required' };
  const supabase = service();
  if (!supabase) return { error: 'Server not configured' };

  // Defense in depth: only a real production SKU can be added — packaging/matière is out of
  // this feature entirely now (2026-09-03), so this rejects a stale/tampered client call the
  // same way the search endpoint above no longer offers packaging as a candidate.
  const ficheMeta = await resolveFicheMetaBySku([sku]);
  const meta = ficheMeta[sku];
  if (!meta) return { error: 'SKU không có trong danh mục sản xuất' };

  const { error } = await supabase.from('lab_shop_stock_count_items')
    .upsert({ shop_name: auth.shopName, sku, product_name: name, added_by_name: addedBy, added_at: new Date().toISOString() }, { onConflict: 'shop_name,sku' });
  if (error) return { error: error.message };
  return { item: { sku, name, qty: null, isExtra: true, category: meta.category, imageUrl: meta.imageUrl } };
}
