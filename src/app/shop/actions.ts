'use server';
import { createHash } from 'crypto';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { createClient, getSafeSession } from '@/lib/supabase-server';
import { ensureDeliveryOrderChecklist, type CheckLine, type DeliveryOrderHeader } from '@/lib/delivery-check';
import {
  getScrapReasonTags, resolveProductsBySku, resolveShopWarehouseLocation, createShopScrap,
} from '@/lib/odoo-scrap';
import { prefillReplenishmentReceivedQty } from '@/lib/odoo-shop-receipt-sync';
import { odooConfigured, odooExecute } from '@/lib/odoo';
import { createManagerReplenishment, tomorrowLabDate, isManagerOrderWindowOpenForTomorrow } from '@/lib/odoo-manager-order';
import { sendShopPush, sendAdminPush, type PushPayload, awaitPush } from '@/lib/push-notify';
import { createInterShopTransfer, receiveInterShopTransfer, cancelInterShopTransfer, transferWarehouseCode, transferEligible, transferRefCode, isVirtualTransferShop } from '@/lib/odoo-shop-transfer';
import { SHOP_NAMES_ALL } from '@/lib/shops';

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

// "Staff preview" read-only twins (below) are also how a shop_manager's own login reads these
// tabs when acting on one of THEIR shops (Axel, 2026-09-10) — never a real shop's own session,
// that always goes through the "My..." action instead (requireShopSession). A manager's
// explicitShopName is checked against their own lab_shop_managers.shops, same as the write path
// in requireShopOrStaffSession above; admin/lab_manager/assistant keep unrestricted access.
async function requireStaffOrManagerSession(explicitShopName?: string): Promise<{ ok: true } | { error: string }> {
  const supabase = createClient();
  const { data: { session } } = await getSafeSession(supabase);
  if (!session) return { error: 'Not authenticated' };
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
  if (['admin', 'lab_manager', 'assistant'].includes(profile?.role ?? '')) return { ok: true };
  if (profile?.role === 'shop_manager') {
    if (!explicitShopName) return { error: 'Shop name required' };
    const manager = await resolveShopManagerByUserId(session.user.id);
    if (!manager || !manager.shops.includes(explicitShopName)) return { error: 'Forbidden' };
    return { ok: true };
  }
  return { error: 'Forbidden' };
}

// Shop Manager (Axel, 2026-09-10): an individual login (role='shop_manager') linked to an
// existing lab_shop_managers row via user_id — the SAME row used for the shared-shop-login PIN
// unlock (resolveManager below), just also reachable without typing that PIN first. Looked up
// with the service-role client since this runs right after the session/role check, same posture
// as every other cross-cutting read in this file.
async function resolveShopManagerByUserId(userId: string): Promise<ShopManager & { shops: string[] } | null> {
  const supabase = service();
  if (!supabase) return null;
  const { data } = await supabase.from('lab_shop_managers')
    .select('id, name, color, shops').eq('user_id', userId).eq('active', true).maybeSingle();
  if (!data) return null;
  return { id: data.id, name: data.name, color: data.color, shops: Array.isArray(data.shops) ? data.shops : [] };
}

// Accepts either the shop's own session, a staff session testing AS a specific shop (Axel,
// 2026-08-25: one-click access from admin, same convenience as the station QR codes — except
// stations work by the tablet staying logged into a real per-team account, there's no token
// trick to copy; shops use ONE shared account per shop, so the equivalent here is letting staff
// act through their own already-authenticated admin session instead of switching accounts), OR
// (2026-09-10) a shop_manager's own individual login acting on one of THEIR authorized shops.
// explicitShopName is only ever trusted after the role check — a shop user's own shopName always
// comes from their OWN lab_profiles row, never from client input; a manager's explicitShopName
// is re-checked against their own lab_shop_managers.shops, never trusted blindly either.
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
  if (profile?.role === 'shop_manager') {
    if (!explicitShopName) return { error: 'Shop name required' };
    const manager = await resolveShopManagerByUserId(session.user.id);
    if (!manager || !manager.shops.includes(explicitShopName)) return { error: 'Forbidden' };
    // Not a "staff test" — this really is the manager operating this shop, same as the shop's
    // own login (no testing banner), just identified via their own account instead of the
    // shop's shared one.
    return { shopName: explicitShopName, isStaffTest: false };
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
  if (profile?.role === 'shop' || profile?.role === 'shop_manager' || ['admin', 'lab_manager', 'assistant'].includes(profile?.role ?? '')) return { ok: true };
  return { error: 'Forbidden' };
}

// The manager's own shop list + name/color (Axel, 2026-09-10) — used by /shop-manager to build
// the shop-switcher and "Shops" tab without asking the caller to already know an explicit shop
// name (unlike every action above, which is scoped to one shop at a time).
export async function getMyManagerProfileAction(): Promise<{ manager?: { name: string; color: string; shops: string[] }; error?: string }> {
  const supabase = createClient();
  const { data: { session } } = await getSafeSession(supabase);
  if (!session) return { error: 'Not authenticated' };
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
  if (profile?.role !== 'shop_manager') return { error: 'Forbidden' };
  const manager = await resolveShopManagerByUserId(session.user.id);
  if (!manager) return { error: 'Manager not configured' };
  return { manager: { name: manager.name, color: manager.color, shops: manager.shops } };
}

// Team tab's read-only "Managers" list (Axel's mockup, 2026-09-10) — deliberately read-only:
// adding/editing a manager's PIN is a security-sensitive operation left to admin
// (/admin/shop-managers), not self-service like the staff roster below. Never returns pin_hash.
export type ShopManagerListEntry = { id: string; name: string; color: string; shopsCount: number; allFiveShops: boolean };

export async function getShopManagersForShopAction(shopName?: string): Promise<{ managers?: ShopManagerListEntry[]; error?: string }> {
  const auth = await requireShopOrStaffSession(shopName);
  if ('error' in auth) return { error: auth.error };
  const supabase = service();
  if (!supabase) return { error: 'Server not configured' };
  const { data } = await supabase.from('lab_shop_managers')
    .select('id, name, color, shops').eq('active', true).contains('shops', [auth.shopName]);
  return {
    managers: (data ?? []).map((m: any) => ({
      id: m.id, name: m.name, color: m.color,
      shopsCount: Array.isArray(m.shops) ? m.shops.length : 0,
      allFiveShops: Array.isArray(m.shops) && m.shops.length >= 5,
    })),
  };
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

  // Completion detection (phase 4, 2026-09-05: "notif ... lorsque la reception est faite"),
  // computed BEFORE this upsert for the same before/after transition reason as the stock-count
  // one above — never re-notify on a later correction to an already-fully-checked order.
  const { data: allCheckLines } = await supabase.from('lab_delivery_check_lines')
    .select('id').eq('delivery_order_id', input.deliveryOrderId);
  const totalLines = allCheckLines?.length ?? 0;
  const { data: existingReceipts } = await supabase.from('lab_shop_receipt_lines')
    .select('check_line_id').eq('delivery_order_id', input.deliveryOrderId);
  const receiptedIds = new Set((existingReceipts ?? []).map((r: any) => r.check_line_id as string));
  const wasComplete = totalLines > 0 && (allCheckLines ?? []).every((l: any) => receiptedIds.has(l.id));

  const { error } = await supabase.from('lab_shop_receipt_lines').upsert({
    check_line_id: input.checkLineId, delivery_order_id: input.deliveryOrderId, shop_name: auth.shopName,
    qty_received: input.qtyReceived, status: input.status, note: input.note ? input.note.slice(0, 300) : null,
    confirmed_by_name: name, confirmed_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }, { onConflict: 'check_line_id' });
  if (error) return { error: error.message };

  if (!wasComplete) {
    receiptedIds.add(input.checkLineId);
    const isCompleteNow = totalLines > 0 && (allCheckLines ?? []).every((l: any) => receiptedIds.has(l.id));
    if (isCompleteNow) {
      const viPayload: PushPayload = { title: auth.shopName, body: `🚚 Đã nhận đủ hàng — đơn #${header.order_ref} (${name})` };
      const enPayload: PushPayload = { title: auth.shopName, body: `🚚 Delivery fully received — order #${header.order_ref} (${name})` };
      await awaitPush(Promise.all([sendShopPush(supabase, auth.shopName, viPayload), sendAdminPush(supabase, viPayload, enPayload)]));
    }
  }

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
  const auth = await requireStaffOrManagerSession(shopName);
  if ('error' in auth) return { error: auth.error };
  const [today, tomorrow] = labTodayTomorrow();
  return { orders: await fetchDeliveries(shopName), today, tomorrow };
}

export async function getShopCakesForStaffAction(shopName: string): Promise<{ cakes?: ShopCake[]; error?: string }> {
  const auth = await requireStaffOrManagerSession(shopName);
  if ('error' in auth) return { error: auth.error };
  return { cakes: await fetchCakes(shopName) };
}

// getMyShopLossesAction's staff-driven counterpart — same query, just scoped to an
// explicit/staff-supplied shopName instead of the caller's own lab_profiles row.
export async function getShopLossesForStaffAction(shopName: string): Promise<{ losses?: ShopLoss[]; error?: string }> {
  const auth = await requireStaffOrManagerSession(shopName);
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

  // Notify the shop's manager + admin of every loss entry (Axel, 2026-09-07: "une notif
  // concernant les saisies des scraps"). The Odoo sync status is part of the message so an
  // unsynced entry (e.g. Moon Flower, no Odoo warehouse) is visible without opening the app.
  const syncTag = odooScrapId ? '' : (auth.shopName === 'Moon Flower' ? '' : ' ⚠ chưa đồng bộ Odoo');
  const syncTagEn = odooScrapId ? '' : (auth.shopName === 'Moon Flower' ? '' : ' ⚠ not synced to Odoo');
  const viPayload: PushPayload = { title: auth.shopName, body: `🗑 Hao hụt: ${productName} ×${qty} — ${input.reasonTagName ?? ''}${input.note ? ` · ${input.note.slice(0, 60)}` : ''} (${name})${syncTag}` };
  const enPayload: PushPayload = { title: auth.shopName, body: `🗑 Loss: ${productName} ×${qty} — ${input.reasonTagName ?? ''}${input.note ? ` · ${input.note.slice(0, 60)}` : ''} (${name})${syncTagEn}` };
  await awaitPush(Promise.all([sendShopPush(supabase, auth.shopName, viPayload), sendAdminPush(supabase, viPayload, enPayload)]));

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
  const auth = await requireStaffOrManagerSession(shopName);
  if ('error' in auth) return { error: auth.error };
  return { recap: await fetchDailyLossRecap(shopName) };
}

// ── Daily stock count ("Kiểm kho") ──────────────────────────────────────────
// Axel, 2026-09-03: shops count their own stock every day, in-app only — no Odoo write for now
// ("je veux pas encore que ça se comptabilise sur Odoo, c'est pour leur info perso"; the table
// shape already matches odoo-inventory.ts's InventoryCountInput so a future push is additive).
// The checklist is NOT prefilled with quantities — only WHICH products appear on it is prefilled.
// Counts are editable multiple times the same day (Axel: "comptage modifiable") — upserted on
// (shop_name, sku, count_date).
//
// Axel, 2026-09-03 (follow-up): "je veux pax le packaging dans le comptage de stock et les
// produits je veux un comptage par category stp et je veux les photos des produits stp" —
// production SKUs only (packaging/matière removed entirely from this feature), each line now
// carries its fiche category (for the UI to group by) and a product photo, resolved the same way
// the delivery-check thumbnails and the order/[token] catalog already do (variant image, falling
// back to the fiche's own image).
//
// Axel, 2026-09-03 (2nd follow-up): "il faut dans le storage toute la liste des produits finis
// sauf les birthday cakes ... et les bentos, ils ajouteront manuellement s'ils en ont" — the
// default checklist is no longer derived from a shop's own order history, it's the FULL active
// production catalog (same list for every shop), minus the Birthday cake and Bento cake
// categories — those two have far too many one-off SKUs (230+ birthday cakes alone) to check off
// every day, so they stay manual-add-only via the same "add a product" search below, which is
// unfiltered (any active production SKU, birthday cakes and bentos included). A shop can also
// still add any other product that isn't on the default list — once added it's remembered for
// next time ("on le mémorise" — lab_shop_stock_count_items).
function vnDateStr(d: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

const STOCK_COUNT_FALLBACK_CATEGORY = 'Khác';

// Category + photo for a set of production SKUs — joined live from lab_fiche_variants/
// lab_fiche_meta (never stored on the count rows themselves, so a fiche's category/photo edit is
// picked up immediately on next load). Used for extras that fall outside the default catalog
// below (e.g. a manually-added birthday cake).
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

export type ShopStockSearchProduct = { sku: string; name: string; category: string; imageUrl: string | null };

// Full active production catalog (every category) — the shared source for both the default
// checklist (filtered below) and the "add a product" search (unfiltered — birthday cakes and
// bentos are still findable there, they're just not auto-listed every day).
//
// excludeInactiveVariants (Axel, 2026-09-11): per-SKU active/inactive on lab_fiche_variants —
// hides a size archived on Odoo from shop/manager ORDERING while sibling sizes on the same
// recipe card stay orderable. Deliberately opt-in (default false): the stock-count checklist
// keeps counting an archived SKU's physical shelf stock until it's sold through, so it must
// still be findable there — only searchManagerOrderProductsAction (ordering) passes true.
async function fetchProductionCatalog(excludeInactiveVariants = false): Promise<ShopStockSearchProduct[]> {
  const supabase = service();
  if (!supabase) return [];
  const { data: fiches } = await supabase.from('lab_fiche_meta').select('id, name_vi, category, image_url').eq('is_active', true);
  const ficheById: Record<string, any> = {};
  for (const f of fiches ?? []) ficheById[f.id] = f;
  const ficheIds = (fiches ?? []).map(f => f.id);
  let variantsQuery = ficheIds.length
    ? supabase.from('lab_fiche_variants').select('fiche_id, sku, label, image_url').in('fiche_id', ficheIds)
    : null;
  if (variantsQuery && excludeInactiveVariants) variantsQuery = variantsQuery.eq('is_active', true);
  const { data: vars } = variantsQuery ? await variantsQuery : { data: [] as any[] };
  const skus = Array.from(new Set((vars ?? []).map((v: any) => v.sku).filter(Boolean)));
  const { data: nameRows } = skus.length
    ? await supabase.from('lab_order_lines').select('product_sku, product_name_vi').in('product_sku', skus).limit(5000)
    : { data: [] as any[] };
  const nameBySku: Record<string, string> = {};
  for (const r of nameRows ?? []) if (r.product_sku && r.product_name_vi && !nameBySku[r.product_sku]) nameBySku[r.product_sku] = r.product_name_vi;

  return (vars ?? []).flatMap((v: any) => {
    const f = ficheById[v.fiche_id];
    if (!f || !v.sku) return [];
    const label = v.label && v.label !== 'Standard' ? v.label : '';
    const name = nameBySku[v.sku] || (f.name_vi ? (label ? `${f.name_vi} · ${label}` : f.name_vi) : v.sku);
    return [{ sku: v.sku as string, name, category: f.category || STOCK_COUNT_FALLBACK_CATEGORY, imageUrl: v.image_url ?? f.image_url ?? null }];
  });
}

// Birthday cake / Bento cake / Drinks stay out of the default checklist — manual-add only (see
// 2nd follow-up note above; Drinks added 2026-09-03 3rd follow-up: "les drinks tu enleves").
// Matched case-insensitively/trimmed against lab_fiche_meta.category.
const STOCK_COUNT_EXCLUDED_CATEGORIES = new Set(['birthday cake', 'bento cake', 'drinks - lp']);

// Axel, 2026-09-03 (3rd follow-up): a handful of individual SKUs to drop from the default
// checklist regardless of category — display-only "fake cake" props (BGBM/BGBMC), discontinued
// or duplicate listings, and tiramisu minis. Also finger cakes (category Cake): keep only the 9
// "Chiếc" (whole/piece) SKUs whose code starts with B — the "Cốc" (cup, S-prefixed) and W-prefixed
// variants of the same 9 products are dropped. Same manual-add-only treatment as the excluded
// categories above (still findable/addable via search if a shop genuinely needs one).
const STOCK_COUNT_EXCLUDED_SKUS = new Set([
  // "il faut ... enleve ... WMCPRMN, SCWM6C, WBY70G, WMCCS2, WMMCDLMN"
  'WMCPRMN', 'SCWM6C', 'WBY70G', 'WMCCS2', 'WMMCDLMN',
  // "BBF tu enleves, BTT, BGBM, BGBMC"
  'BBF', 'BTT', 'BGBM', 'BGBMC',
  // "enleve les tiramisu mini" (lab_fiche_meta.category = 'Tiramisu', name containing "mini")
  'BTMVM', 'BTRMSMNCF', 'BTRMSMNHP', 'BTVQM',
  // "BBGBR"
  'BBGBR',
  // finger cake (category Cake) — non-"B-prefix" variants of the 9 kept products
  'S-BBCFCC', 'S-BBGFC', 'S-BBMCFC', 'S-BBMFB2', 'S-BBMFC', 'S-BBPCFB', 'S-BBPFC', 'S-BBSFC', 'S-BBSFC1',
  'WBCFC', 'WBGF', 'WBMF', 'WBMF1', 'WBPCF', 'WBSF', 'WBSF1', 'WMMCH', 'WMPF',
]);

async function stockCountCatalog(): Promise<Map<string, ShopStockSearchProduct>> {
  const all = await fetchProductionCatalog();
  const out = new Map<string, ShopStockSearchProduct>();
  for (const p of all) {
    if (STOCK_COUNT_EXCLUDED_CATEGORIES.has(p.category.trim().toLowerCase())) continue;
    if (STOCK_COUNT_EXCLUDED_SKUS.has(p.sku)) continue;
    out.set(p.sku, p);
  }
  return out;
}

type StockCountEntry = { name: string; category: string; imageUrl: string | null; isExtra: boolean };

// Which SKUs belong on this shop's checklist, and their display name/category/photo — the full
// catalog above (same for every shop) plus this shop's own manually-added extras.
async function stockCountEntries(shopName: string): Promise<Map<string, StockCountEntry>> {
  const out = new Map<string, StockCountEntry>();
  const catalog = await stockCountCatalog();
  catalog.forEach((p, sku) => out.set(sku, { name: p.name, category: p.category, imageUrl: p.imageUrl, isExtra: false }));

  const supabase = service();
  if (!supabase) return out;
  const { data: extras } = await supabase.from('lab_shop_stock_count_items').select('sku, product_name').eq('shop_name', shopName);
  const newExtraSkus = (extras ?? []).map((e: any) => e.sku).filter((sku: string) => sku && !out.has(sku));
  const extraMeta = newExtraSkus.length ? await resolveFicheMetaBySku(newExtraSkus) : {};
  for (const e of extras ?? []) {
    if (!e.sku || out.has(e.sku)) continue; // already in the default catalog, no extra row needed
    const meta = extraMeta[e.sku];
    if (!meta) continue; // stale/no-longer-valid production sku — defensive backstop
    out.set(e.sku, { name: e.product_name, category: meta.category, imageUrl: meta.imageUrl, isExtra: true });
  }
  return out;
}

export type ShopStockCountLine = {
  sku: string; name: string; qty: number | null; isExtra: boolean; category: string; imageUrl: string | null;
  priceB2c: number | null;
};

async function fetchStockCountList(shopName: string, date: string, sessionSeq: number): Promise<ShopStockCountLine[]> {
  const supabase = service();
  if (!supabase) return [];
  const entries = await stockCountEntries(shopName);

  const { data: counts } = await supabase.from('lab_shop_stock_counts')
    .select('sku, qty').eq('shop_name', shopName).eq('count_date', date).eq('session_seq', sessionSeq);
  const qtyBySku = new Map<string, number>();
  for (const c of counts ?? []) qtyBySku.set(c.sku, Number(c.qty));

  // Valorisation (Axel, 2026-09-05: "la valorisation de leur stock apres inventaire pour les
  // interface shop") — quantite x prix de vente (price_b2c), meme source que la valorisation
  // stock deja affichee cote admin (analytics/page.tsx). Un SKU sans prix (pas encore au
  // catalogue B2C, ex. les Paris Brest) -> priceB2c: null, la ligne compte pour 0 dans le total
  // plutot que de faire echouer tout le calcul.
  const skus = Array.from(entries.keys());
  const { data: priceRows } = skus.length
    ? await supabase.from('product_variants').select('sku, price_b2c').in('sku', skus)
    : { data: [] as any[] };
  const priceBySku = new Map<string, number>();
  for (const r of priceRows ?? []) if (r.sku && Number(r.price_b2c) > 0) priceBySku.set(r.sku, Number(r.price_b2c));

  return Array.from(entries.entries())
    .map(([sku, v]) => ({
      sku, name: v.name, isExtra: v.isExtra, qty: qtyBySku.has(sku) ? qtyBySku.get(sku)! : null,
      category: v.category, imageUrl: v.imageUrl, priceB2c: priceBySku.get(sku) ?? null,
    }))
    // Grouped by category in the UI — sort server-side the same way so the client can just walk
    // the array in order.
    .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
}

// Axel, 2026-09-05: "plusieurs inventaire par jour" — a shop can run several DISTINCT counts in
// one calendar day (matin/chiều/tối…) instead of every save silently overwriting the same row.
// session_seq partitions lab_shop_stock_counts rows within one shop+day; the "current" (still
// editable) session is always the highest seq that has any saved data — tapping "Nouveau
// comptage" in the UI starts current+1 with a blank checklist, which locks the previous one
// simply by no longer being the target of new saves. Derived entirely from saved rows — no
// separate "sessions" table needed.
export type ShopStockCountSession = { seq: number; savedCount: number; updatedAt: string; updatedByNames: string[]; finishedAt: string | null; finishedByName: string | null };

async function fetchStockSessions(shopName: string, date: string): Promise<ShopStockCountSession[]> {
  const supabase = service();
  if (!supabase) return [];
  const { data } = await supabase.from('lab_shop_stock_counts')
    .select('session_seq, updated_by_name, updated_at')
    .eq('shop_name', shopName).eq('count_date', date);
  const bySession = new Map<number, { count: number; names: Set<string>; latestAt: string }>();
  for (const row of data ?? []) {
    const seq = Number(row.session_seq);
    const cur = bySession.get(seq) ?? { count: 0, names: new Set<string>(), latestAt: row.updated_at as string };
    cur.count += 1;
    if (row.updated_by_name) cur.names.add(row.updated_by_name as string);
    if ((row.updated_at as string) > cur.latestAt) cur.latestAt = row.updated_at as string;
    bySession.set(seq, cur);
  }
  // Explicit "Hoàn tất" marks (lab_v72) — one per session, set by finishStockCountAction.
  const { data: done } = await supabase.from('lab_shop_stock_sessions_done')
    .select('session_seq, finished_at, finished_by_name').eq('shop_name', shopName).eq('count_date', date);
  const doneBySeq = new Map<number, { at: string; by: string | null }>();
  for (const d of done ?? []) doneBySeq.set(Number(d.session_seq), { at: d.finished_at as string, by: (d.finished_by_name as string | null) ?? null });
  return Array.from(bySession.entries())
    .map(([seq, v]) => ({
      seq, savedCount: v.count, updatedAt: v.latestAt, updatedByNames: Array.from(v.names),
      finishedAt: doneBySeq.get(seq)?.at ?? null, finishedByName: doneBySeq.get(seq)?.by ?? null,
    }))
    .sort((a, b) => a.seq - b.seq);
}

export async function getMyStockCountListAction(sessionSeq?: number): Promise<{ shopName?: string; date?: string; sessionSeq?: number; latestSessionSeq?: number; sessions?: ShopStockCountSession[]; lines?: ShopStockCountLine[]; error?: string }> {
  const auth = await requireShopSession();
  if ('error' in auth) return { error: auth.error };
  const today = vnDateStr();
  const sessions = await fetchStockSessions(auth.shopName, today);
  const latest = sessions.length ? sessions[sessions.length - 1].seq : 1;
  // Allow latest+1 too — the client requests it to preview/start a brand-new blank session
  // before anything has actually been saved into it yet.
  const seq = sessionSeq && sessionSeq >= 1 && sessionSeq <= latest + 1 ? sessionSeq : latest;
  return { shopName: auth.shopName, date: today, sessionSeq: seq, latestSessionSeq: latest, sessions, lines: await fetchStockCountList(auth.shopName, today, seq) };
}

export async function getStockCountListForStaffAction(shopName: string, sessionSeq?: number): Promise<{ date?: string; sessionSeq?: number; latestSessionSeq?: number; sessions?: ShopStockCountSession[]; lines?: ShopStockCountLine[]; error?: string }> {
  const auth = await requireStaffOrManagerSession(shopName);
  if ('error' in auth) return { error: auth.error };
  const today = vnDateStr();
  const sessions = await fetchStockSessions(shopName, today);
  const latest = sessions.length ? sessions[sessions.length - 1].seq : 1;
  const seq = sessionSeq && sessionSeq >= 1 && sessionSeq <= latest + 1 ? sessionSeq : latest;
  return { date: today, sessionSeq: seq, latestSessionSeq: latest, sessions, lines: await fetchStockCountList(shopName, today, seq) };
}

export async function saveStockCountAction(input: {
  entries: { sku: string; qty: number }[];
  updatedByName: string;
  sessionSeq?: number; // which count of the day this belongs to — see fetchStockSessions above
  shopName?: string; // only used (and only trusted) when the caller is staff testing as this shop
}): Promise<{ ok?: boolean; saved?: number; sessionSeq?: number; error?: string }> {
  const auth = await requireShopOrStaffSession(input.shopName);
  if ('error' in auth) return { error: auth.error };
  const supabase = service();
  if (!supabase) return { error: 'Server not configured' };

  const name = (input.updatedByName ?? '').trim().slice(0, 80);
  if (!name) return { error: 'Name required' };
  if (!Array.isArray(input.entries) || !input.entries.length) return { error: 'No data' };

  const today = vnDateStr();
  // A save may only continue today's current (latest) session or open exactly the next one —
  // never an arbitrary/older one and never skip a number — "Nouveau comptage" in the UI locks
  // the previous session simply by there being a newer one to save into instead.
  const sessions = await fetchStockSessions(auth.shopName, today);
  const latest = sessions.length ? sessions[sessions.length - 1].seq : 1;
  const requested = Number(input.sessionSeq);
  const sessionSeq = Number.isFinite(requested) && (requested === latest || requested === latest + 1) ? requested : latest;

  // Re-derive names/eligibility server-side rather than trusting the client's pairing — an entry
  // for a SKU that isn't (or is no longer) on this shop's list is silently dropped.
  const entries = await stockCountEntries(auth.shopName);
  const rows = input.entries
    .filter(e => e.sku && entries.has(e.sku) && Number.isFinite(e.qty) && Number(e.qty) >= 0)
    .map(e => ({
      shop_name: auth.shopName, sku: e.sku, product_name: entries.get(e.sku)!.name,
      count_date: today, session_seq: sessionSeq, qty: Number(e.qty), updated_by_name: name, updated_at: new Date().toISOString(),
    }));
  if (!rows.length) return { error: 'No valid data' };

  const { error } = await supabase.from('lab_shop_stock_counts').upsert(rows, { onConflict: 'shop_name,sku,count_date,session_seq' });
  if (error) return { error: error.message };

  // No automatic "completed" notification any more (Axel, 2026-09-06): the previous heuristic
  // (every SKU this shop ever counted) never fired in practice. The shop now declares the end
  // of a count explicitly — see finishStockCountAction below.

  return { ok: true, saved: rows.length, sessionSeq };
}

// Explicit end of a count (Axel, 2026-09-06: "un bouton explicite Hoàn tất kiểm kho"). Marks the
// session done (lab_v72), then pushes the shop + admin with the real numbers (SKU count and
// valuation at price_b2c, same convention as the end-of-day report). Idempotent: re-tapping only
// refreshes the numbers, it never re-notifies.
export async function finishStockCountAction(input: {
  sessionSeq: number;
  finishedByName: string;
  shopName?: string;
}): Promise<{ ok?: boolean; skuCount?: number; valuation?: number; alreadyDone?: boolean; error?: string }> {
  const auth = await requireShopOrStaffSession(input.shopName);
  if ('error' in auth) return { error: auth.error };
  const supabase = service();
  if (!supabase) return { error: 'Server not configured' };
  const name = (input.finishedByName ?? '').trim().slice(0, 80);
  if (!name) return { error: 'Name required' };

  const today = vnDateStr();
  const sessions = await fetchStockSessions(auth.shopName, today);
  const sess = sessions.find(x => x.seq === Number(input.sessionSeq));
  if (!sess || sess.savedCount === 0) return { error: 'Chưa có dữ liệu kiểm kho để hoàn tất' };

  const { data: countRows } = await supabase.from('lab_shop_stock_counts')
    .select('sku, qty').eq('shop_name', auth.shopName).eq('count_date', today).eq('session_seq', sess.seq);
  const skus = Array.from(new Set((countRows ?? []).map((r: any) => r.sku as string)));
  const { data: priceRows } = skus.length ? await supabase.from('product_variants').select('sku, price_b2c').in('sku', skus) : { data: [] as any[] };
  const priceBySku = new Map<string, number>();
  for (const r of priceRows ?? []) if (r.sku && Number(r.price_b2c) > 0) priceBySku.set(r.sku, Number(r.price_b2c));
  const valuation = (countRows ?? []).reduce((acc: number, r: any) => acc + (Number(r.qty) || 0) * (priceBySku.get(r.sku) ?? 0), 0);

  const alreadyDone = !!sess.finishedAt;
  const { error } = await supabase.from('lab_shop_stock_sessions_done').upsert({
    shop_name: auth.shopName, count_date: today, session_seq: sess.seq,
    finished_by_name: name, sku_count: skus.length, valuation,
    ...(alreadyDone ? {} : { finished_at: new Date().toISOString() }),
  }, { onConflict: 'shop_name,count_date,session_seq' });
  if (error) return { error: error.message };

  if (!alreadyDone) {
    const money = new Intl.NumberFormat('vi-VN').format(Math.round(valuation)) + ' ₫';
    const viPayload: PushPayload = { title: auth.shopName, body: `📋 Kiểm kho đợt ${sess.seq} đã hoàn tất — ${skus.length} SP · ${money} (${name})` };
    const enPayload: PushPayload = { title: auth.shopName, body: `📋 Stock count #${sess.seq} finished — ${skus.length} SKUs · ${money} (${name})` };
    await awaitPush(Promise.all([sendShopPush(supabase, auth.shopName, viPayload), sendAdminPush(supabase, viPayload, enPayload)]));
  }
  return { ok: true, skuCount: skus.length, valuation, alreadyDone };
}

// "Add a product" search for the stock-count checklist — unfiltered production catalog
// (birthday cakes and bentos included, see 2nd follow-up note above; packaging/matière stays
// excluded entirely, per the first follow-up).
export async function searchStockCountProductsAction(query: string, shopName?: string): Promise<{ products?: ShopStockSearchProduct[]; error?: string }> {
  const auth = await requireShopOrStaffSession(shopName);
  if ('error' in auth) return { error: auth.error };
  const q = (query ?? '').trim().toLowerCase().slice(0, 60);
  const all = await fetchProductionCatalog();
  const filtered = (q ? all.filter(p => (p.name + ' ' + p.sku).toLowerCase().includes(q)) : all)
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
  const { data: priceRow } = await supabase.from('product_variants').select('price_b2c').eq('sku', sku).maybeSingle();
  const priceB2c = priceRow && Number(priceRow.price_b2c) > 0 ? Number(priceRow.price_b2c) : null;
  return { item: { sku, name, qty: null, isExtra: true, category: meta.category, imageUrl: meta.imageUrl, priceB2c } };
}

// ── Daily report ("Báo cáo") ────────────────────────────────────────────────
// Axel, 2026-09-03: "un rapport quotidien en fin de journée après comptabilisation du stock avec
// recap du stock et des pertes" — a single combined view, in-app only (no cron/Zalo), generated
// on demand by just re-reading today's stock count + today's losses; nothing new is stored here.
// Axel (follow-up): "affiche les produits a 0 et met en rouge quand c'est a 0" — every catalog
// line is shown (not just counted ones), with qty 0 flagged as an out-of-stock alert by the UI.
export type ShopDailyReport = {
  date: string;
  stockLines: ShopStockCountLine[];
  stockCountedCount: number;
  stockTotalCount: number;
  stockCounted: boolean;
  stockValuationTotal: number;
  losses: ShopLossDailyRecapProduct[];
  lossesTotalQty: number;
  lossesReportCount: number;
};

// Axel, 2026-09-11: "je voudrais que dans l'onglet report des shops qu il y ait l historique sur
// 7 jours glissants" — same rolling-7-day posture as fetchDailyLossRecap above, VN calendar days,
// most-recent first (today always included, even with nothing counted yet — the UI shows that as
// "not counted" rather than omitting the day).
function last7VnDates(): string[] {
  const out: string[] = [];
  for (let i = 0; i < 7; i++) out.push(vnDateStr(new Date(Date.now() - i * 86400000)));
  return out;
}

// Batched across the whole 7-day window rather than looping fetchDailyReport per day: the
// catalog/extras lookup (stockCountEntries -> fetchProductionCatalog, several Supabase reads) is
// the same every day for one shop, so it's fetched ONCE here, same for the price lookup and the
// already-7-day fetchDailyLossRecap — only the raw stock-count rows are fetched per-window (one
// query) rather than per-day. Axel: "optimise bien tout pour que l'usage supabase/vercel soit
// reduit" — a naive 7x loop would re-run ~5 queries/day for no reason.
async function fetchDailyReportRange(shopName: string): Promise<ShopDailyReport[]> {
  const dates = last7VnDates();
  const minDate = dates[dates.length - 1];
  const supabase = service();
  const entries = await stockCountEntries(shopName);
  const skus = Array.from(entries.keys());

  const [countsRes, pricesRes, lossRecap] = await Promise.all([
    supabase
      ? supabase.from('lab_shop_stock_counts').select('sku, qty, count_date, session_seq')
          .eq('shop_name', shopName).gte('count_date', minDate)
      : Promise.resolve({ data: [] as any[] }),
    supabase && skus.length
      ? supabase.from('product_variants').select('sku, price_b2c').in('sku', skus)
      : Promise.resolve({ data: [] as any[] }),
    fetchDailyLossRecap(shopName),
  ]);

  const priceBySku = new Map<string, number>();
  for (const r of pricesRes.data ?? []) if (r.sku && Number(r.price_b2c) > 0) priceBySku.set(r.sku, Number(r.price_b2c));

  const rowsByDate = new Map<string, { sku: string; qty: number; session_seq: number }[]>();
  for (const r of countsRes.data ?? []) {
    const d = r.count_date as string;
    const arr = rowsByDate.get(d) ?? [];
    arr.push({ sku: r.sku, qty: Number(r.qty), session_seq: Number(r.session_seq) });
    rowsByDate.set(d, arr);
  }

  return dates.map(date => {
    const rows = rowsByDate.get(date) ?? [];
    // Same "highest session_seq with any saved data = current" rule as fetchStockSessions.
    const latestSeq = rows.length ? Math.max(...rows.map(r => r.session_seq)) : null;
    const qtyBySku = new Map<string, number>();
    if (latestSeq != null) for (const r of rows) if (r.session_seq === latestSeq) qtyBySku.set(r.sku, r.qty);

    const stockLines: ShopStockCountLine[] = Array.from(entries.entries())
      .map(([sku, v]) => ({
        sku, name: v.name, isExtra: v.isExtra, qty: qtyBySku.has(sku) ? qtyBySku.get(sku)! : null,
        category: v.category, imageUrl: v.imageUrl, priceB2c: priceBySku.get(sku) ?? null,
      }))
      .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));

    const stockCountedCount = stockLines.filter(l => l.qty !== null).length;
    const stockValuationTotal = stockLines.reduce((s, l) => s + (l.qty ?? 0) * (l.priceB2c ?? 0), 0);
    const dayLoss = lossRecap.find(r => r.date === date);
    return {
      date,
      stockLines,
      stockCountedCount,
      stockTotalCount: stockLines.length,
      stockCounted: stockCountedCount > 0,
      stockValuationTotal,
      losses: dayLoss?.products ?? [],
      lossesTotalQty: dayLoss?.totalQty ?? 0,
      lossesReportCount: dayLoss?.reportCount ?? 0,
    };
  });
}

export async function getMyDailyReportRangeAction(): Promise<{ reports?: ShopDailyReport[]; error?: string }> {
  const auth = await requireShopSession();
  if ('error' in auth) return { error: auth.error };
  return { reports: await fetchDailyReportRange(auth.shopName) };
}

export async function getDailyReportRangeForStaffAction(shopName: string): Promise<{ reports?: ShopDailyReport[]; error?: string }> {
  const auth = await requireStaffOrManagerSession(shopName);
  if ('error' in auth) return { error: auth.error };
  return { reports: await fetchDailyReportRange(shopName) };
}

// ── Live inventory reference (Order tab) ────────────────────────────────────────────────────
// Axel, 2026-09-10: shop managers place orders across all 5 shops and asked for a view of the
// shop's latest stock count right next to product search, with a toggle for in-stock/out-of-
// stock. Reuses the exact same Kiểm kho data (lab_shop_stock_counts via fetchStockSessions/
// fetchStockCountList above) — read-only, scoped to whichever session is most recent today, no
// separate table and no new Odoo/Supabase reads beyond what Kiểm kho already does.
//
// A line with no count yet (qty: null in fetchStockCountList — nobody has entered a number for
// it in the latest session) used to be dropped entirely, so "All" silently only ever showed
// counted lines. Axel, 2026-09-10 follow-up: "le all doit afficher tout ... le out of stock doit
// comprendre les produits a 0 et ceux non compte car c'est 0" — an uncounted product is exactly
// as un-orderable-with-confidence as a counted zero, so it's folded into qty 0 (out of stock)
// here rather than tracked as a separate "not counted" state nothing asked for.
export type ShopStockLevel = { sku: string; name: string; qty: number; category: string };

export async function getShopCurrentStockLevelsAction(shopName?: string): Promise<{ levels?: ShopStockLevel[]; asOf?: string | null; error?: string }> {
  const auth = await requireShopOrStaffSession(shopName);
  if ('error' in auth) return { error: auth.error };
  const today = vnDateStr();
  const sessions = await fetchStockSessions(auth.shopName, today);
  if (!sessions.length) return { levels: [], asOf: null };
  const latest = sessions.reduce((a, b) => (b.seq > a.seq ? b : a));
  const list = await fetchStockCountList(auth.shopName, today, latest.seq);
  return {
    levels: list.map(l => ({ sku: l.sku, name: l.name, qty: l.qty ?? 0, category: l.category })),
    asOf: latest.updatedAt,
  };
}

// ── Commande (manager-only) ─────────────────────────────────────────────────────────────────
// Phase 3 of the shop portal plan (Axel, 2026-09-03): a shop manager places a real stock
// replenishment order directly from the portal, PIN-gated. Deliberately separate from the
// existing lab_manual_cakes "exceptional orders" flow — Axel: "je ne veux pas que tu considere
// cette commande comme les commandes exceptionnel manuels". Reads/writes here never touch
// lab_manual_cakes; the actual Odoo document creation lives in its own module
// (src/lib/odoo-manager-order.ts) that always auto-confirms (draft -> submitted -> approved) so
// the order reaches the chefs' production queue the same way any other confirmed order does —
// "l'app lira la commande pour les chefs comme le process actuel". Managers may only ever order
// for next-day delivery (Axel confirmed 2026-09-03) — same "same-day stays exceptional" posture
// the rest of the app already has (odoo-order-lock.ts).
//
// The PIN unlocks the tab within whichever shop's shared portal login is already open — there
// is no separate manager login (Axel confirmed this UX 2026-09-03). A manager can be authorized
// for several shops on one PIN (Quan: Timecity + Bà Triệu). The PIN is re-verified server-side
// on every submit (not just trusted from a client-held "already unlocked" flag) — the client
// keeps the PIN in memory after a successful unlock so the manager isn't asked to retype it for
// every order in the same session, but the actual Odoo-writing action always re-checks it.
function hashManagerPin(pin: string): string {
  return createHash('sha256').update(pin).digest('hex');
}

export type ShopManager = { id: string; name: string; color: string };

async function resolveManager(shopName: string, pin: string): Promise<ShopManager | null> {
  const cleanPin = (pin ?? '').trim();
  if (!cleanPin) return null;
  const supabase = service();
  if (!supabase) return null;
  const { data } = await supabase.from('lab_shop_managers')
    .select('id, name, color, shops')
    .eq('active', true)
    .eq('pin_hash', hashManagerPin(cleanPin));
  const match = (data ?? []).find((m: any) => Array.isArray(m.shops) && m.shops.includes(shopName));
  return match ? { id: match.id, name: match.name, color: match.color } : null;
}

export async function verifyManagerPinAction(pin: string, shopName?: string): Promise<{ manager?: ShopManager; error?: string }> {
  const auth = await requireShopOrStaffSession(shopName);
  if ('error' in auth) return { error: auth.error };
  const manager = await resolveManager(auth.shopName, pin);
  if (!manager) return { error: 'Mã PIN không đúng' };
  return { manager };
}

// "Add a product" search for the Commande cart — same production catalog as the Kiểm kho
// search (every active category, birthday cakes/bentos included — this is a real Odoo
// replenishment order, not the daily-count checklist, so nothing needs to be held back) PLUS
// packaging/matière SKUs resolved live against Odoo with the Vietnamese name (same
// lab_excluded_skus + context: { lang: 'vi_VN' } approach used by the Kiểm kho search before
// packaging was dropped from that specific feature — packaging stays IN SCOPE here, per Axel's
// original Phase 3 spec: shops do need to reorder packaging/matière, not just finished goods).
// priceB2c rides along per SKU (same product_variants.price_b2c source as the Kiểm kho
// valuation above) so the cart can show a running order total (Axel, 2026-09-12: "quand les
// shops passent commande, peux tu afficher la total value de la commande ?" — closes the gap
// the manager-Order-screen build already flagged: "the mockup's sticky bar shows a money total
// ... neither exists in the underlying data yet"). null for a SKU with no B2C price (packaging,
// matière) — those simply don't contribute to the total, same convention as elsewhere.
export type ShopManagerCatalogProduct = { sku: string; name: string; category: string; imageUrl: string | null; isPackaging: boolean; priceB2c: number | null };

// `category` lets the manager browse a whole category (e.g. tapping a chip) instead of typing —
// Axel, 2026-09-03: "faciliter l'ajout de produit, pas forcement 1 par 1, et un filtre par
// categorie". When a category is picked with no text query, this returns the WHOLE category
// (raised cap) rather than the short typeahead cap used for a plain text search.
export async function searchManagerOrderProductsAction(query: string, shopName?: string, category?: string): Promise<{ products?: ShopManagerCatalogProduct[]; error?: string }> {
  const auth = await requireShopOrStaffSession(shopName);
  if ('error' in auth) return { error: auth.error };
  const supabase = service();
  if (!supabase) return { error: 'Server not configured' };
  const q = (query ?? '').trim().toLowerCase().slice(0, 60);
  const cat = (category ?? '').trim();
  const browsingCategory = !q && !!cat;

  type CatalogProductNoPrice = Omit<ShopManagerCatalogProduct, 'priceB2c'>;
  let filteredProduction: CatalogProductNoPrice[] = (await fetchProductionCatalog(true)).map(p => ({ ...p, isPackaging: false }));
  if (q) filteredProduction = filteredProduction.filter(p => (p.name + ' ' + p.sku).toLowerCase().includes(q));
  if (cat) filteredProduction = filteredProduction.filter(p => p.category === cat);

  let packaging: CatalogProductNoPrice[] = [];
  if (!cat || cat === 'Packaging') {
    const { data: excludedRows } = await supabase.from('lab_excluded_skus').select('sku');
    const excludedSkus = (excludedRows ?? []).map((r: any) => r.sku).filter(Boolean);
    if (excludedSkus.length && odooConfigured()) {
      try {
        const domain: any[] = q
          ? ['&', ['default_code', 'in', excludedSkus], '|', ['name', 'ilike', q], ['default_code', 'ilike', q]]
          : [['default_code', 'in', excludedSkus]];
        const rows = await odooExecute<any[]>('product.product', 'search_read', [domain],
          { fields: ['default_code', 'name', 'display_name'], context: { lang: 'vi_VN' }, limit: browsingCategory ? 200 : 30 });
        packaging = rows.filter(p => p.default_code).map(p => {
          const variantName = String(p.display_name || '').replace(/\[.*?\]\s*/, '').trim();
          return { sku: p.default_code as string, name: variantName || p.name || p.default_code, category: 'Packaging', imageUrl: null, isPackaging: true };
        });
      } catch {
        // Best-effort — a slow/unreachable Odoo never blocks the production-catalog results.
      }
    }
  }

  const cap = browsingCategory ? 200 : 40;
  const capped = [...filteredProduction, ...packaging].sort((a, b) => a.name.localeCompare(b.name)).slice(0, cap);

  const skusForPrice = Array.from(new Set(capped.map(p => p.sku)));
  const { data: priceRows } = skusForPrice.length
    ? await supabase.from('product_variants').select('sku, price_b2c').in('sku', skusForPrice)
    : { data: [] as any[] };
  const priceBySku = new Map<string, number>();
  for (const r of priceRows ?? []) if (r.sku && Number(r.price_b2c) > 0) priceBySku.set(r.sku, Number(r.price_b2c));

  const all: ShopManagerCatalogProduct[] = capped.map(p => ({ ...p, priceB2c: priceBySku.get(p.sku) ?? null }));
  return { products: all };
}

// Distinct categories for the browse chips — production-catalog categories plus "Packaging"
// when there's anything to show there, sorted for a stable chip order.
export async function getManagerOrderCategoriesAction(shopName?: string): Promise<{ categories?: string[]; error?: string }> {
  const auth = await requireShopOrStaffSession(shopName);
  if ('error' in auth) return { error: auth.error };
  const supabase = service();
  if (!supabase) return { error: 'Server not configured' };
  const production = await fetchProductionCatalog();
  const cats = new Set<string>();
  for (const p of production) if (p.category) cats.add(p.category);
  const { data: excludedRows } = await supabase.from('lab_excluded_skus').select('sku');
  if ((excludedRows ?? []).some((r: any) => r.sku)) cats.add('Packaging');
  return { categories: Array.from(cats).sort((a, b) => a.localeCompare(b, 'vi')) };
}

export async function getManagerOrderContextAction(): Promise<{ minDate?: string; defaultDate?: string; tomorrowOrderingOpen?: boolean; error?: string }> {
  const minDate = tomorrowLabDate();
  const tomorrowOrderingOpen = isManagerOrderWindowOpenForTomorrow();
  return { minDate, defaultDate: tomorrowOrderingOpen ? minDate : dayAfter(minDate), tomorrowOrderingOpen };
}

function dayAfter(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + 1);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
}

// ── Đặt hàng draft (Axel, 2026-09-05 follow-up) ─────────────────────────────────────────────
// Revised design: ANY shop staff member can build/edit the cart (no PIN) — same posture as
// Kiểm kho/Hao hụt, identified by name via NamePicker. Only actually SENDING it to Odoo needs a
// manager's PIN — either a manager taps "Xác nhận" themselves, or, if nobody has by 14h00 for a
// delivery of tomorrow specifically, the scheduled auto-submit job sends it on their behalf
// (src/app/api/odoo/auto-submit-manager-orders/route.ts). The draft itself never touches Odoo —
// it's just a shared, persisted "current cart" for the shop's Đặt hàng tab (lab_shop_manager_
// order_drafts), one active (status='draft') row per shop+delivery_date.
export type ShopManagerOrderDraft = {
  id: string;
  deliveryDate: string;
  deliveryTime: string | null;
  lines: { sku: string; name: string; qty: number; note?: string; priceB2c?: number | null }[];
  createdByName: string | null;
  updatedAt: string;
};

async function findActiveDraft(shopName: string, deliveryDate: string) {
  const supabase = service();
  if (!supabase) return null;
  const { data } = await supabase.from('lab_shop_manager_order_drafts')
    .select('id, delivery_date, delivery_time, lines, created_by_name, updated_at')
    .eq('shop_name', shopName).eq('delivery_date', deliveryDate).eq('status', 'draft')
    .order('updated_at', { ascending: false }).limit(1);
  return data?.[0] ?? null;
}

// Loads whatever draft already exists for this shop+date, if any — lets staff/managers resume
// or review whatever the last person left, regardless of who built it or on which device.
export async function getManagerOrderDraftAction(deliveryDate: string, shopName?: string): Promise<{ draft?: ShopManagerOrderDraft | null; error?: string }> {
  const auth = await requireShopOrStaffSession(shopName);
  if ('error' in auth) return { error: auth.error };
  const date = String(deliveryDate ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: 'Ngày giao không hợp lệ' };
  const row = await findActiveDraft(auth.shopName, date);
  if (!row) return { draft: null };
  const lines: { sku: string; name: string; qty: number; note?: string }[] = Array.isArray(row.lines) ? row.lines : [];

  // Draft rows only ever store sku/name/qty/note (see saveManagerOrderDraftAction) — price is
  // resolved fresh here instead of stored, same convention as the Kiểm kho valuation, so an
  // order total always reflects the current price_b2c even for a draft saved days ago.
  const supabase = service();
  const skus = Array.from(new Set(lines.map(l => l.sku).filter(Boolean)));
  const { data: priceRows } = supabase && skus.length
    ? await supabase.from('product_variants').select('sku, price_b2c').in('sku', skus)
    : { data: [] as any[] };
  const priceBySku = new Map<string, number>();
  for (const r of priceRows ?? []) if (r.sku && Number(r.price_b2c) > 0) priceBySku.set(r.sku, Number(r.price_b2c));

  return {
    draft: {
      id: row.id, deliveryDate: row.delivery_date, deliveryTime: row.delivery_time,
      lines: lines.map(l => ({ ...l, priceB2c: priceBySku.get(l.sku) ?? null })),
      createdByName: row.created_by_name, updatedAt: row.updated_at,
    },
  };
}

// No PIN — any staff member can save/update the shared draft for this shop+date. Upserts the
// one active draft row for that date (finds it first rather than relying on a DB unique
// constraint, since a shop can hold drafts for several different delivery dates at once).
export async function saveManagerOrderDraftAction(input: {
  shopName?: string;
  createdByName: string;
  deliveryDate: string;
  deliveryTime?: string;
  lines: { sku: string; name: string; qty: number; note?: string }[];
}): Promise<{ draft?: ShopManagerOrderDraft; error?: string }> {
  const auth = await requireShopOrStaffSession(input.shopName);
  if ('error' in auth) return { error: auth.error };
  const supabase = service();
  if (!supabase) return { error: 'Server not configured' };

  const name = (input.createdByName ?? '').trim().slice(0, 80);
  if (!name) return { error: 'Cần chọn tên trước' };
  const date = String(input.deliveryDate ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: 'Ngày giao không hợp lệ' };
  if (date < tomorrowLabDate()) return { error: 'Không thể đặt giao cho hôm nay hoặc ngày đã qua' };

  const lines = (input.lines ?? [])
    .map(l => ({ sku: String(l.sku ?? '').trim(), name: String(l.name ?? '').trim(), qty: Number(l.qty), note: l.note?.trim() || undefined }))
    .filter(l => l.sku && l.qty > 0);
  if (!lines.length) return { error: 'Giỏ hàng trống' };

  const existing = await findActiveDraft(auth.shopName, date);
  const payload = {
    shop_name: auth.shopName, delivery_date: date, delivery_time: input.deliveryTime ?? null,
    lines, created_by_name: name, status: 'draft', updated_at: new Date().toISOString(),
  };
  const { data, error } = existing
    ? await supabase.from('lab_shop_manager_order_drafts').update(payload).eq('id', existing.id)
        .select('id, delivery_date, delivery_time, lines, created_by_name, updated_at').single()
    : await supabase.from('lab_shop_manager_order_drafts').insert(payload)
        .select('id, delivery_date, delivery_time, lines, created_by_name, updated_at').single();
  if (error || !data) return { error: error?.message ?? 'Lưu nháp thất bại' };
  return {
    draft: {
      id: data.id, deliveryDate: data.delivery_date, deliveryTime: data.delivery_time,
      lines: Array.isArray(data.lines) ? data.lines : [], createdByName: data.created_by_name, updatedAt: data.updated_at,
    },
  };
}

// Any staff can discard a draft they/a colleague started — low-risk, same posture as freely
// editing it; nothing has reached Odoo yet at this point.
export async function discardManagerOrderDraftAction(deliveryDate: string, shopName?: string): Promise<{ ok?: boolean; error?: string }> {
  const auth = await requireShopOrStaffSession(shopName);
  if ('error' in auth) return { error: auth.error };
  const supabase = service();
  if (!supabase) return { error: 'Server not configured' };
  const date = String(deliveryDate ?? '').trim();
  const existing = await findActiveDraft(auth.shopName, date);
  if (!existing) return { ok: true };
  const { error } = await supabase.from('lab_shop_manager_order_drafts').update({ status: 'cancelled' }).eq('id', existing.id);
  if (error) return { error: error.message };
  return { ok: true };
}

// The real, order-creating action — the one moment a manager's PIN is actually required.
// Re-verifies the PIN server-side (see comment above), then hands off to
// createManagerReplenishment (src/lib/odoo-manager-order.ts) — creates the Odoo document and
// adds every line, LEFT IN DRAFT (Axel, 2026-09-08: shop orders should not auto-validate) — the
// 16h/23:59 lockTomorrowOrders cron (src/lib/odoo-order-lock.ts) confirms it later. On success,
// logs an audit row (lab_shop_manager_orders) and closes out any matching draft — both
// best-effort, never block the manager from seeing their order reference just because a local
// log write failed.
export async function submitManagerOrderAction(input: {
  pin: string;
  shopName?: string;
  deliveryDate: string;
  deliveryTime?: string;
  lines: { sku: string; name: string; qty: number; note?: string }[];
}): Promise<{ orderRef?: string; deliveryDate?: string; deliveryTime?: string; managerName?: string; error?: string }> {
  const auth = await requireShopOrStaffSession(input.shopName);
  if ('error' in auth) return { error: auth.error };
  const manager = await resolveManager(auth.shopName, input.pin);
  if (!manager) return { error: 'Mã PIN không đúng' };

  const lines = (input.lines ?? [])
    .map(l => ({ sku: String(l.sku ?? '').trim(), name: String(l.name ?? '').trim(), qty: Number(l.qty), note: l.note?.trim() }))
    .filter(l => l.sku && l.qty > 0);
  if (!lines.length) return { error: 'Giỏ hàng trống' };

  const res = await createManagerReplenishment(auth.shopName, lines, String(input.deliveryDate ?? ''), input.deliveryTime);
  if (!res.ok || !res.orderRef) return { error: res.error ?? 'Lỗi không xác định' };

  const supabase = service();
  if (supabase) {
    await supabase.from('lab_shop_manager_orders').insert({
      manager_id: manager.id,
      manager_name: manager.name,
      shop_name: auth.shopName,
      order_ref: res.orderRef,
      delivery_date: res.deliveryDate,
      delivery_time: res.deliveryTime,
      lines,
    });
    // Best-effort — a manager confirming manually closes out whatever draft was sitting there
    // for the same date, so the 14h00 auto-submit job never double-sends it.
    const draft = await findActiveDraft(auth.shopName, String(input.deliveryDate ?? ''));
    if (draft) {
      await supabase.from('lab_shop_manager_order_drafts')
        .update({ status: 'submitted', submitted_order_ref: res.orderRef, submitted_at: new Date().toISOString() })
        .eq('id', draft.id);
    }
  }

  // Notify the shop (its other devices / manager) + admin that tomorrow's order is in (Axel,
  // 2026-09-07: "une notification lorsqu'ils créent la commande du jour").
  if (supabase) {
    const units = lines.reduce((a, l) => a + l.qty, 0);
    const ddate = String(res.deliveryDate ?? input.deliveryDate ?? '');
    const dd = `${ddate.slice(8, 10)}/${ddate.slice(5, 7)}`;
    const viPayload: PushPayload = { title: auth.shopName, body: `📦 Đã gửi đơn đặt hàng ${dd}: ${res.orderRef} — ${lines.length} SP · ${units} cái (${manager.name})` };
    const enPayload: PushPayload = { title: auth.shopName, body: `📦 Order for ${dd} sent: ${res.orderRef} — ${lines.length} SKUs · ${units} units (${manager.name})` };
    await awaitPush(Promise.all([sendShopPush(supabase, auth.shopName, viPayload), sendAdminPush(supabase, viPayload, enPayload)]));
  }

  return { orderRef: res.orderRef, deliveryDate: res.deliveryDate, deliveryTime: res.deliveryTime, managerName: manager.name };
}

// Surfaces every order ALREADY submitted for today's and tomorrow's delivery (Axel, 2026-09-12:
// Bà Triệu placed two separate orders for the same delivery date — a normal advance order plus a
// same-day top-up — and nothing in the Order tab showed the first one once a second was
// submitted, so a manager reviewing "what's already ordered" only ever saw one when there were
// two). Reads lab_shop_manager_orders directly — the audit log already written by
// submitManagerOrderAction above — rather than relying on the draft table, which only ever holds
// the CURRENT unsubmitted cart and gets marked 'submitted'/replaced the moment an order goes out.
export type ShopRecentOrder = {
  orderRef: string; deliveryDate: string; deliveryTime: string | null;
  managerName: string | null; createdAt: string; itemCount: number; totalQty: number;
};
export async function getRecentManagerOrdersAction(shopName?: string): Promise<{ orders?: ShopRecentOrder[]; today?: string; tomorrow?: string; error?: string }> {
  const auth = await requireShopOrStaffSession(shopName);
  if ('error' in auth) return { error: auth.error };
  const supabase = service();
  if (!supabase) return { error: 'Server not configured' };
  const [today, tomorrow] = labTodayTomorrow();
  const { data, error } = await supabase.from('lab_shop_manager_orders')
    .select('order_ref, delivery_date, delivery_time, manager_name, created_at, lines')
    .eq('shop_name', auth.shopName).in('delivery_date', [today, tomorrow])
    .order('delivery_date', { ascending: true }).order('created_at', { ascending: true });
  if (error) return { error: error.message };
  const orders: ShopRecentOrder[] = (data ?? []).map(r => {
    const lines = Array.isArray(r.lines) ? r.lines : [];
    return {
      orderRef: r.order_ref, deliveryDate: r.delivery_date, deliveryTime: r.delivery_time,
      managerName: r.manager_name, createdAt: r.created_at,
      itemCount: lines.length, totalQty: lines.reduce((a: number, l: any) => a + Number(l?.qty ?? 0), 0),
    };
  });
  return { orders, today, tomorrow };
}

// ── Push notifications (phase 4, 2026-09-05) ────────────────────────────────
// Shop-scoped subscribe/unsubscribe — same posture as the chefs' subscribePushAction
// (station/[team]/actions.ts): the session only confirms the click came from a logged-in shop
// account, the actual write goes through the service-role client (lab_shop_push_subscriptions
// has zero RLS policies). Keyed on (endpoint, shop_name) rather than endpoint alone — see
// lab_v67_notification_phase4 — so a manager covering two shops on one phone (Axel, 2026-09-05:
// "quan est manager des 2 shops") can hold a subscription for each without one overwriting the
// other; every notification always leads with the shop name so he can tell them apart.
export async function subscribeShopPushAction(
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
  shopName?: string,
): Promise<{ ok?: boolean; error?: string }> {
  const auth = await requireShopOrStaffSession(shopName);
  if ('error' in auth) return { error: auth.error };
  if (!subscription?.endpoint || !subscription.keys?.p256dh || !subscription.keys?.auth) {
    return { error: 'Invalid subscription' };
  }
  const supabase = service();
  if (!supabase) return { error: 'Not configured' };
  const { error } = await supabase.from('lab_shop_push_subscriptions').upsert({
    shop_name: auth.shopName,
    endpoint: subscription.endpoint,
    p256dh: subscription.keys.p256dh,
    auth: subscription.keys.auth,
    last_seen_at: new Date().toISOString(),
  }, { onConflict: 'endpoint,shop_name' });
  if (error) return { error: error.message };
  return { ok: true };
}

export async function unsubscribeShopPushAction(endpoint: string, shopName?: string): Promise<{ ok?: boolean }> {
  const auth = await requireShopOrStaffSession(shopName);
  if ('error' in auth) return { ok: true }; // best-effort, never blocks the client-side toggle
  const supabase = service();
  if (!supabase || !endpoint) return { ok: true };
  await supabase.from('lab_shop_push_subscriptions').delete().eq('endpoint', endpoint).eq('shop_name', auth.shopName);
  return { ok: true };
}

// ── Inter-shop stock transfers (Axel, 2026-09-07) ───────────────────────────────────────────
// A La Paris shop sends products to another La Paris shop. Odoo gets ONE internal transfer
// (see src/lib/odoo-shop-transfer.ts): created when the sending manager confirms with the PIN,
// validated when the receiving shop confirms the quantities it really got. lab_shop_transfers /
// lab_shop_transfer_lines are the portal's view + history; the Odoo picking is the stock truth.
// Sending needs the manager PIN (it moves stock); receiving may be done by any staff member of
// the destination shop, like a lab delivery. Same session model as everything else here: the
// shop's own login, or staff acting as a shop from the admin dashboard (readOnly mode).

export type ShopTransferStatus = 'sent' | 'received' | 'cancelled';
export type ShopTransferLine = {
  id: string; sku: string; name: string; category: string | null; imageUrl: string | null;
  qtySent: number; qtyReceived: number | null; note: string | null;
};
export type ShopTransfer = {
  id: string; ref: string; fromShop: string; toShop: string; status: ShopTransferStatus;
  odooPickingName: string | null; sentByName: string | null; sentAt: string;
  receivedByName: string | null; receivedAt: string | null; cancelledByName: string | null; cancelledAt: string | null;
  note: string | null; lineCount: number; unitCount: number; lines: ShopTransferLine[];
  fromIsVirtual: boolean; toIsVirtual: boolean;
};

const shortShop = (s: string) => s.replace(/^La Paris\s+/i, '');

// Shops this shop may transfer to: every other shop with an Odoo warehouse. canTransfer=false
// for a shop without one (Moon Flower) — the tab then explains instead of offering peers.
export async function getTransferPeersAction(shopName?: string): Promise<{ shopName?: string; canTransfer?: boolean; peers?: string[]; error?: string }> {
  const auth = await requireShopOrStaffSession(shopName);
  if ('error' in auth) return { error: auth.error };
  const canTransfer = transferEligible(auth.shopName);
  const peers = SHOP_NAMES_ALL.filter(s => s !== auth.shopName && transferEligible(s));
  return { shopName: auth.shopName, canTransfer, peers };
}

function mapTransferRow(t: any, lines: any[]): ShopTransfer {
  return {
    id: t.id, ref: t.ref, fromShop: t.from_shop, toShop: t.to_shop, status: t.status,
    odooPickingName: t.odoo_picking_name ?? null, sentByName: t.sent_by_name ?? null, sentAt: t.sent_at,
    receivedByName: t.received_by_name ?? null, receivedAt: t.received_at ?? null,
    cancelledByName: t.cancelled_by_name ?? null, cancelledAt: t.cancelled_at ?? null,
    note: t.note ?? null, lineCount: Number(t.line_count ?? 0), unitCount: Number(t.unit_count ?? 0),
    fromIsVirtual: isVirtualTransferShop(t.from_shop), toIsVirtual: isVirtualTransferShop(t.to_shop),
    lines: lines.map((l: any) => ({
      id: l.id, sku: l.sku, name: l.product_name_vi, category: l.category ?? null, imageUrl: l.image_url ?? null,
      qtySent: Number(l.qty_sent), qtyReceived: l.qty_received == null ? null : Number(l.qty_received), note: l.line_note ?? null,
    })),
  };
}

// Outgoing + incoming transfers of this shop, last 30 days (plus anything still 'sent' whatever
// its age, so an unreceived transfer never silently drops off the list).
export async function getMyShopTransfersAction(shopName?: string): Promise<{ shopName?: string; transfers?: ShopTransfer[]; error?: string }> {
  const auth = await requireShopOrStaffSession(shopName);
  if ('error' in auth) return { error: auth.error };
  const supabase = service();
  if (!supabase) return { error: 'Server not configured' };
  const since = new Date(Date.now() - 30 * 86400 * 1000).toISOString();
  const { data: rows, error } = await supabase.from('lab_shop_transfers').select('*')
    .or(`from_shop.eq.${JSON.stringify(auth.shopName)},to_shop.eq.${JSON.stringify(auth.shopName)}`)
    .or(`sent_at.gte.${since},status.eq.sent`)
    .order('sent_at', { ascending: false }).limit(200);
  if (error) return { error: error.message };
  const ids = (rows ?? []).map((r: any) => r.id);
  const { data: lineRows } = ids.length
    ? await supabase.from('lab_shop_transfer_lines').select('*').in('transfer_id', ids).order('product_name_vi').limit(5000)
    : { data: [] as any[] };
  const linesByTransfer = new Map<string, any[]>();
  for (const l of lineRows ?? []) { const arr = linesByTransfer.get(l.transfer_id) ?? []; arr.push(l); linesByTransfer.set(l.transfer_id, arr); }
  return { shopName: auth.shopName, transfers: (rows ?? []).map((t: any) => mapTransferRow(t, linesByTransfer.get(t.id) ?? [])) };
}

// The stock-moving step on the sending side: PIN re-verified server-side, Odoo picking created
// and confirmed, then the app rows. If the app rows cannot be written after Odoo succeeded, the
// picking is cancelled again so Odoo and the app never disagree.
export async function submitShopTransferAction(input: {
  pin: string;
  shopName?: string;
  toShop: string;
  sentByName: string;
  note?: string;
  lines: { sku: string; name: string; qty: number; note?: string; category?: string | null; imageUrl?: string | null }[];
}): Promise<{ transfer?: ShopTransfer; assigned?: boolean; error?: string }> {
  const auth = await requireShopOrStaffSession(input.shopName);
  if ('error' in auth) return { error: auth.error };
  const manager = await resolveManager(auth.shopName, input.pin);
  if (!manager) return { error: 'Mã PIN không đúng' };
  const supabase = service();
  if (!supabase) return { error: 'Server not configured' };

  const toShop = String(input.toShop ?? '').trim();
  if (!transferEligible(auth.shopName)) return { error: `${auth.shopName} không thể chuyển kho` };
  if (!transferEligible(toShop)) return { error: 'Kho nhận không hợp lệ' };
  if (toShop === auth.shopName) return { error: 'Kho nhận phải khác kho gửi' };
  if (isVirtualTransferShop(auth.shopName) && isVirtualTransferShop(toShop)) return { error: 'Cần ít nhất một bên có kho Odoo thật' };
  const fromCode = transferRefCode(auth.shopName);
  const toCode = transferRefCode(toShop);
  const sentByName = String(input.sentByName ?? '').trim().slice(0, 80);
  if (!sentByName) return { error: 'Chọn tên người gửi' };

  const merged = new Map<string, { sku: string; name: string; qty: number; note?: string; category: string | null; imageUrl: string | null }>();
  for (const l of input.lines ?? []) {
    const sku = String(l.sku ?? '').trim(); const qty = Math.floor(Number(l.qty));
    if (!sku || !(qty > 0)) continue;
    const cur = merged.get(sku);
    if (cur) { cur.qty += qty; if (!cur.note && l.note?.trim()) cur.note = l.note.trim(); }
    else merged.set(sku, { sku, name: String(l.name ?? sku).trim(), qty, note: l.note?.trim() || undefined, category: l.category ?? null, imageUrl: l.imageUrl ?? null });
  }
  const lines = Array.from(merged.values());
  if (!lines.length) return { error: 'Chưa có sản phẩm nào' };

  const { data: seq, error: seqErr } = await supabase.rpc('lab_shop_transfer_next_seq');
  if (seqErr || seq == null) return { error: `Không tạo được mã chuyển kho: ${seqErr?.message ?? 'seq'}` };
  const ref = `TRF-${fromCode}-${toCode}-${String(seq).padStart(4, '0')}`;
  const note = input.note?.trim().slice(0, 500) || undefined;

  const odoo = await createInterShopTransfer(auth.shopName, toShop, lines, ref, note);
  if (!odoo.ok || !odoo.pickingId) return { error: odoo.error ?? 'Lỗi Odoo không xác định' };

  const units = lines.reduce((a, l) => a + l.qty, 0);
  const { data: inserted, error: insErr } = await supabase.from('lab_shop_transfers').insert({
    ref, from_shop: auth.shopName, to_shop: toShop, status: 'sent',
    odoo_picking_id: odoo.pickingId, odoo_picking_name: odoo.pickingName ?? null,
    sent_by_name: sentByName, sent_by_manager_id: manager.id, note: note ?? null,
    line_count: lines.length, unit_count: units,
  }).select('*').single();
  if (insErr || !inserted) {
    await cancelInterShopTransfer(odoo.pickingId).catch(() => {});
    return { error: `Không lưu được phiếu chuyển kho: ${insErr?.message ?? 'insert'}` };
  }
  const { data: lineRows, error: lineErr } = await supabase.from('lab_shop_transfer_lines').insert(lines.map(l => ({
    transfer_id: inserted.id, sku: l.sku, product_name_vi: l.name, category: l.category, image_url: l.imageUrl,
    qty_sent: l.qty, line_note: l.note ?? null, odoo_move_id: odoo.moveIdBySku?.[l.sku] ?? null,
  }))).select('*');
  if (lineErr) {
    await supabase.from('lab_shop_transfers').delete().eq('id', inserted.id);
    await cancelInterShopTransfer(odoo.pickingId).catch(() => {});
    return { error: `Không lưu được dòng chuyển kho: ${lineErr.message}` };
  }

  const who = `${manager.name}${sentByName && sentByName !== manager.name ? ` / ${sentByName}` : ''}`;
  const viPayload: PushPayload = { title: toShop, body: `🔁 Chuyển kho từ ${shortShop(auth.shopName)} → ${shortShop(toShop)} ${ref}: ${lines.length} SP · ${units} cái (${who}) — vào tab Chuyển kho để nhận` };
  const enPayload: PushPayload = { title: toShop, body: `🔁 Stock transfer ${shortShop(auth.shopName)} → ${shortShop(toShop)} ${ref}: ${lines.length} SKUs · ${units} units (${who})` };
  await awaitPush(Promise.all([sendShopPush(supabase, toShop, viPayload), sendAdminPush(supabase, viPayload, enPayload)]));

  return { transfer: mapTransferRow(inserted, lineRows ?? []), assigned: odoo.assigned };
}

// Receiving side: writes the real quantities on the Odoo picking and validates it (stock moves
// A -> B now), then records who received what. Odoo first: if it refuses, nothing changes in the
// app and the error is shown as-is.
export async function receiveShopTransferAction(input: {
  shopName?: string;
  transferId: string;
  receivedByName: string;
  lines: { sku: string; qtyReceived: number }[];
}): Promise<{ transfer?: ShopTransfer; warning?: string; error?: string }> {
  const auth = await requireShopOrStaffSession(input.shopName);
  if ('error' in auth) return { error: auth.error };
  const supabase = service();
  if (!supabase) return { error: 'Server not configured' };
  const receivedByName = String(input.receivedByName ?? '').trim().slice(0, 80);
  if (!receivedByName) return { error: 'Chọn tên người nhận' };

  const { data: t } = await supabase.from('lab_shop_transfers').select('*').eq('id', input.transferId).maybeSingle();
  if (!t) return { error: 'Phiếu chuyển kho không tìm thấy' };
  if (t.to_shop !== auth.shopName) return { error: 'Phiếu này không gửi cho kho của bạn' };
  if (t.status === 'received') return { error: 'Phiếu này đã được nhận' };
  if (t.status === 'cancelled') return { error: 'Phiếu này đã bị huỷ' };
  if (!t.odoo_picking_id) return { error: 'Phiếu chưa có mã Odoo — liên hệ quản lý' };

  const { data: lineRows } = await supabase.from('lab_shop_transfer_lines').select('*').eq('transfer_id', t.id);
  const sentBySku: Record<string, number> = {};
  for (const l of lineRows ?? []) sentBySku[l.sku] = Number(l.qty_sent);
  const received: Record<string, number> = {};
  for (const l of input.lines ?? []) {
    const sku = String(l.sku ?? '').trim();
    if (!(sku in sentBySku)) return { error: `Sản phẩm ${sku} không có trên phiếu` };
    const q = Math.floor(Number(l.qtyReceived));
    if (!(q >= 0)) return { error: `Số lượng nhận không hợp lệ (${sku})` };
    if (q > sentBySku[sku]) return { error: `Không thể nhận nhiều hơn số đã gửi (${sku}: ${q} > ${sentBySku[sku]})` };
    received[sku] = q;
  }
  for (const sku of Object.keys(sentBySku)) if (!(sku in received)) received[sku] = 0;
  if (!Object.values(received).some(q => q > 0)) return { error: 'Không có sản phẩm nào được nhận — nếu không nhận được gì, kho gửi cần huỷ phiếu' };

  const odoo = await receiveInterShopTransfer(Number(t.odoo_picking_id), Object.entries(received).map(([sku, qtyReceived]) => ({ sku, qtyReceived })));
  if (!odoo.ok) {
    const viPayload: PushPayload = { title: auth.shopName, body: `⚠️ Nhận chuyển kho ${t.ref} thất bại trên Odoo: ${odoo.error ?? '?'}` };
    await awaitPush(sendAdminPush(supabase, viPayload, { title: auth.shopName, body: `⚠️ Transfer ${t.ref} reception failed on Odoo: ${odoo.error ?? '?'}` }));
    return { error: odoo.error ?? 'Lỗi Odoo không xác định' };
  }

  const now = new Date().toISOString();
  for (const [sku, q] of Object.entries(received)) {
    await supabase.from('lab_shop_transfer_lines').update({ qty_received: q }).eq('transfer_id', t.id).eq('sku', sku);
  }
  const { data: updated } = await supabase.from('lab_shop_transfers')
    .update({ status: 'received', received_by_name: receivedByName, received_at: now })
    .eq('id', t.id).select('*').single();
  const { data: freshLines } = await supabase.from('lab_shop_transfer_lines').select('*').eq('transfer_id', t.id).order('product_name_vi');

  const diffs = (freshLines ?? []).filter((l: any) => Number(l.qty_received ?? 0) !== Number(l.qty_sent))
    .map((l: any) => `${l.product_name_vi} ${Number(l.qty_received ?? 0) - Number(l.qty_sent)}`);
  const unitsRecv = Object.values(received).reduce((a, b) => a + b, 0);
  const shortfallNote = isVirtualTransferShop(t.from_shop)
    ? `chỉ số lượng thực nhận được cộng vào kho Odoo của ${shortShop(t.to_shop)}`
    : `phần thiếu vẫn nằm trong kho ${shortShop(t.from_shop)} trên Odoo — nếu mất hàng, ${shortShop(t.from_shop)} cần ghi hao hụt`;
  const diffTxt = diffs.length ? ` — ⚠ chênh lệch: ${diffs.join(', ')} (${shortfallNote})` : '';
  const viPayload: PushPayload = { title: t.from_shop, body: `✅ ${shortShop(t.to_shop)} đã nhận chuyển kho ${t.ref}: ${unitsRecv} cái (${receivedByName})${diffTxt}` };
  const enPayload: PushPayload = { title: t.from_shop, body: `✅ ${shortShop(t.to_shop)} received transfer ${t.ref}: ${unitsRecv} units (${receivedByName})${diffs.length ? ` — ⚠ differences: ${diffs.join(', ')}` : ''}` };
  await awaitPush(Promise.all([sendShopPush(supabase, t.from_shop, viPayload), sendAdminPush(supabase, viPayload, enPayload)]));

  return { transfer: mapTransferRow(updated ?? { ...t, status: 'received', received_by_name: receivedByName, received_at: now }, freshLines ?? []), warning: odoo.backorderWarning };
}

// Sending shop may cancel while the destination has not received yet: Odoo picking cancelled
// first, then the app row. Anyone at the sending shop may cancel (no PIN — it undoes, never moves stock).
export async function cancelShopTransferAction(input: { shopName?: string; transferId: string; byName: string }): Promise<{ transfer?: ShopTransfer; error?: string }> {
  const auth = await requireShopOrStaffSession(input.shopName);
  if ('error' in auth) return { error: auth.error };
  const supabase = service();
  if (!supabase) return { error: 'Server not configured' };
  const byName = String(input.byName ?? '').trim().slice(0, 80);
  if (!byName) return { error: 'Chọn tên của bạn' };
  const { data: t } = await supabase.from('lab_shop_transfers').select('*').eq('id', input.transferId).maybeSingle();
  if (!t) return { error: 'Phiếu chuyển kho không tìm thấy' };
  if (t.from_shop !== auth.shopName) return { error: 'Chỉ kho gửi mới huỷ được phiếu này' };
  if (t.status !== 'sent') return { error: t.status === 'received' ? 'Phiếu đã được nhận — không thể huỷ' : 'Phiếu đã bị huỷ' };
  if (t.odoo_picking_id) {
    const odoo = await cancelInterShopTransfer(Number(t.odoo_picking_id));
    if (!odoo.ok) return { error: odoo.error ?? 'Lỗi Odoo không xác định' };
  }
  const now = new Date().toISOString();
  const { data: updated } = await supabase.from('lab_shop_transfers')
    .update({ status: 'cancelled', cancelled_by_name: byName, cancelled_at: now }).eq('id', t.id).select('*').single();
  const { data: lineRows } = await supabase.from('lab_shop_transfer_lines').select('*').eq('transfer_id', t.id).order('product_name_vi');
  const viPayload: PushPayload = { title: t.to_shop, body: `✖ ${shortShop(t.from_shop)} đã huỷ chuyển kho ${t.ref} (${byName})` };
  const enPayload: PushPayload = { title: t.to_shop, body: `✖ ${shortShop(t.from_shop)} cancelled transfer ${t.ref} (${byName})` };
  await awaitPush(Promise.all([sendShopPush(supabase, t.to_shop, viPayload), sendAdminPush(supabase, viPayload, enPayload)]));
  return { transfer: mapTransferRow(updated ?? { ...t, status: 'cancelled' }, lineRows ?? []) };
}
