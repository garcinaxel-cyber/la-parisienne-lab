'use server';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { ensureDeliveryOrderChecklist, type CheckLine, type DeliveryOrderHeader } from '@/lib/delivery-check';

// Public shop delivery/cakes portal — one token per shop, no login (each shop has 5-6 staff,
// an individual account per person isn't manageable, see lab_v44). Same pattern as
// /order/[token]/actions.ts: token checked on EVERY call, all DB work via the service-role
// key so the core tables need no anon policies.

function service() {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return null;
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } },
  );
}

async function shopForToken(supabase: NonNullable<ReturnType<typeof service>>, token: string): Promise<string | null> {
  if (!token || token.length < 8) return null;
  const { data } = await supabase.from('lab_shop_portal_links')
    .select('shop_name').eq('token', token).eq('active', true).maybeSingle();
  return data?.shop_name ?? null;
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

export async function getShopDeliveriesAction(token: string): Promise<{ shopName?: string; orders?: ShopDeliveryOrder[]; error?: string }> {
  const supabase = service();
  if (!supabase) return { error: 'Server not configured' };
  const shopName = await shopForToken(supabase, token);
  if (!shopName) return { error: 'Invalid link' };

  const [today, tomorrow] = labTodayTomorrow();

  // Same source-of-truth as the main delivery-check index page (lab_order_lines +
  // lab_order_packaging_lines), not lab_delivery_orders directly — an order that no assistant
  // has opened yet still needs to show up here, with its checklist materialized on the fly via
  // ensureDeliveryOrderChecklist (same idempotent helper the assistants' own pages use).
  const { data: orderLines } = await supabase.from('lab_order_lines')
    .select('order_ref, delivery_date, shop_name').eq('shop_name', shopName).in('delivery_date', [today, tomorrow]).gt('qty', 0);
  const { data: packagingLines } = await supabase.from('lab_order_packaging_lines')
    .select('order_ref, delivery_date, shop_name').eq('shop_name', shopName).in('delivery_date', [today, tomorrow]);

  const pairs = new Map<string, { date: string; orderRef: string }>();
  for (const l of [...(orderLines ?? []), ...(packagingLines ?? [])]) {
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

  return { shopName, orders };
}

export async function confirmReceiptAction(
  token: string,
  input: { checkLineId: string; deliveryOrderId: string; qtyReceived: number | null; status: 'ok' | 'issue'; note: string | null; confirmedByName: string },
): Promise<{ ok?: boolean; error?: string }> {
  const supabase = service();
  if (!supabase) return { error: 'Server not configured' };
  const shopName = await shopForToken(supabase, token);
  if (!shopName) return { error: 'Invalid link' };

  const name = (input.confirmedByName ?? '').trim().slice(0, 80);
  if (!name) return { error: 'Name required' };

  // Defense in depth: re-verify this check line really belongs to an order for THIS shop
  // before writing — never trust the client-supplied deliveryOrderId/shopName pairing blindly.
  const { data: header } = await supabase.from('lab_delivery_orders')
    .select('id, shop_name').eq('id', input.deliveryOrderId).maybeSingle();
  if (!header || header.shop_name !== shopName) return { error: 'Order not found for this shop' };
  const { data: line } = await supabase.from('lab_delivery_check_lines')
    .select('id').eq('id', input.checkLineId).eq('delivery_order_id', input.deliveryOrderId).maybeSingle();
  if (!line) return { error: 'Line not found' };

  const { error } = await supabase.from('lab_shop_receipt_lines').upsert({
    check_line_id: input.checkLineId, delivery_order_id: input.deliveryOrderId, shop_name: shopName,
    qty_received: input.qtyReceived, status: input.status, note: input.note ? input.note.slice(0, 300) : null,
    confirmed_by_name: name, confirmed_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }, { onConflict: 'check_line_id' });
  if (error) return { error: error.message };
  return { ok: true };
}

export type ShopCake = {
  id: string; name: string; qty: number; deliveryDate: string; readyTime: string | null;
  status: 'pending' | 'confirmed' | 'cancelled'; matchedRef: string | null; cancelReason: string | null;
};

export async function getShopCakesAction(token: string): Promise<{ cakes?: ShopCake[]; error?: string }> {
  const supabase = service();
  if (!supabase) return { error: 'Server not configured' };
  const shopName = await shopForToken(supabase, token);
  if (!shopName) return { error: 'Invalid link' };

  const since = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
  const { data, error } = await supabase.from('lab_manual_cakes')
    .select('id, product_name_vi, qty, delivery_date, ready_time, matched_order_ref, cancelled_at, cancel_reason')
    .eq('shop_name', shopName).gte('delivery_date', since)
    .order('delivery_date', { ascending: true }).limit(50);
  if (error) return { error: error.message };

  const cakes: ShopCake[] = (data ?? []).map((c: any) => {
    const realRef = c.matched_order_ref && c.matched_order_ref !== '__pending_create__' ? c.matched_order_ref : null;
    return {
      id: c.id, name: c.product_name_vi, qty: c.qty, deliveryDate: c.delivery_date, readyTime: c.ready_time ?? null,
      status: c.cancelled_at ? 'cancelled' : realRef ? 'confirmed' : 'pending',
      matchedRef: realRef, cancelReason: c.cancel_reason ?? null,
    };
  });
  return { cakes };
}
