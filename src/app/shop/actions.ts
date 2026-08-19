'use server';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { createClient, getSafeSession } from '@/lib/supabase-server';
import { ensureDeliveryOrderChecklist, type CheckLine, type DeliveryOrderHeader } from '@/lib/delivery-check';

// Shop portal data layer — two entry points into the same underlying reads:
//  - the shop's OWN session (role='shop', shop_name resolved from lab_profiles) — read/write,
//    including the receipt confirmation.
//  - staff (admin/lab_manager/assistant) previewing any shop by name from the dashboard
//    (Axel, 2026-08-19: "je veux pouvoir accéder à leur interface... via le dashboard") —
//    READ-ONLY, no confirm action, so it's never ambiguous who actually confirmed a receipt.
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
  lines: (CheckLine & { receipt: { qty_received: number | null; status: string; note: string | null; confirmed_by_name: string; confirmed_at: string } | null })[];
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
      lines: lines.map(l => ({ ...l, receipt: receiptByLine[l.id] ?? null })),
    });
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
}): Promise<{ ok?: boolean; error?: string }> {
  const auth = await requireShopSession();
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
