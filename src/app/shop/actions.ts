'use server';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { createClient, getSafeSession } from '@/lib/supabase-server';
import { ensureDeliveryOrderChecklist, type CheckLine, type DeliveryOrderHeader } from '@/lib/delivery-check';
import {
  getScrapReasonTags, resolveProductsBySku, resolveShopWarehouseLocation, createShopScrap,
} from '@/lib/odoo-scrap';

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
    .select('id, shop_name').eq('id', input.deliveryOrderId).maybeSingle();
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
  return { ok: true };
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
const EXPIRED_REASON_KEYWORDS = ['het han', 'han su dung', 'perime', 'expired', 'expiry', 'qua han'];
function reduceLossReasons(all: ShopLossReason[]): ShopLossReason[] {
  const filtered = all.filter(r => {
    const n = normalizeReasonName(r.name);
    return BROKEN_REASON_KEYWORDS.some(k => n.includes(k)) || EXPIRED_REASON_KEYWORDS.some(k => n.includes(k));
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
