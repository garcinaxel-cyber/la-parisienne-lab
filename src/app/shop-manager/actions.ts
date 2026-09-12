'use server';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { createClient, getSafeSession } from '@/lib/supabase-server';
import { computeShopRecaps, type ShopRecap } from '@/lib/shop-recap';

// Shop Manager cockpit (Axel, 2026-09-10) — its own thin action file, same one-file-per-route
// convention as shop/actions.ts and online-orders/actions.ts. Deliberately does NOT duplicate
// any read/write already covered by shop/actions.ts (deliveries, cakes, losses, stock, staff
// roster, commande) — those are reached through requireShopOrStaffSession there, extended
// 2026-09-10 to accept a shop_manager session. This file only adds the two things unique to the
// multi-shop cockpit itself: the "Today" recap for one shop, and the "Shops" tab's status
// across every shop this manager covers — both built on the SAME batched src/lib/shop-recap.ts
// query used by admin's own "Suivi shops" page, never a second hand-copied version.

function service() {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return null;
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } },
  );
}

async function currentManager(): Promise<{ userId: string; shops: string[] } | { error: string }> {
  const supabase = createClient();
  const { data: { session } } = await getSafeSession(supabase);
  if (!session) return { error: 'Not authenticated' };
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
  if (profile?.role !== 'shop_manager') return { error: 'Forbidden' };
  const svc = service();
  if (!svc) return { error: 'Server not configured' };
  const { data: manager } = await svc.from('lab_shop_managers')
    .select('shops').eq('user_id', session.user.id).eq('active', true).maybeSingle();
  if (!manager) return { error: 'Manager not configured' };
  return { userId: session.user.id, shops: Array.isArray(manager.shops) ? manager.shops : [] };
}

function vnDateStr(d: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

export type ManagerOnlineToday = { count: number; total: number };

// Deliberately its own small query, not a call into online-orders/actions.ts's
// getOnlineAnalyticsAction — that one pulls 60+ days of every seller's data for the full
// Analytic tab, far more than a one-line "6 orders today · 1,240,000 ₫" recap card needs.
async function fetchOnlineToday(svc: ReturnType<typeof service>, shopName: string, date: string): Promise<ManagerOnlineToday> {
  if (!svc) return { count: 0, total: 0 };
  const { data: orders } = await svc.from('lab_online_orders').select('order_batch_id, source').eq('shop_name', shopName).eq('delivery_date', date);
  const batchIds = (orders ?? []).map((o: any) => o.order_batch_id as string);
  if (!batchIds.length) return { count: 0, total: 0 };
  const labIds = (orders ?? []).filter((o: any) => (o.source ?? 'lab') === 'lab').map((o: any) => o.order_batch_id as string);
  const [{ data: lines }, { data: stockLines }] = await Promise.all([
    labIds.length
      ? svc.from('lab_manual_cakes').select('order_batch_id, qty, unit_price, cancelled_at').in('order_batch_id', labIds)
      : Promise.resolve({ data: [] as any[] }),
    svc.from('lab_online_sale_lines').select('order_batch_id, qty, unit_price').in('order_batch_id', batchIds),
  ]);
  let total = 0;
  for (const l of lines ?? []) if (!l.cancelled_at) total += Number(l.qty ?? 0) * Number(l.unit_price ?? 0);
  for (const l of stockLines ?? []) total += Number(l.qty ?? 0) * Number(l.unit_price ?? 0);
  return { count: batchIds.length, total };
}

// ── Today (one shop) ─────────────────────────────────────────────────────────────────────────
export async function getManagerTodayRecapAction(shopName: string): Promise<{ recap?: ShopRecap; online?: ManagerOnlineToday; date?: string; error?: string }> {
  const auth = await currentManager();
  if ('error' in auth) return { error: auth.error };
  if (!auth.shops.includes(shopName)) return { error: 'Forbidden' };
  const svc = service();
  if (!svc) return { error: 'Server not configured' };
  const date = vnDateStr();
  const [recaps, online] = await Promise.all([
    computeShopRecaps(svc, [shopName], date),
    fetchOnlineToday(svc, shopName, date),
  ]);
  return { recap: recaps[0], online, date };
}

// ── Shops (every shop this manager covers, one batched call) ───────────────────────────────────
export type ManagerShopStatus = {
  shop: string;
  receptionTotal: number; receptionConfirmed: number;
  countDone: boolean;
  // Split by delivery date, not one lumped total — computeShopRecaps' orders window now spans
  // today + tomorrow (Axel, 2026-09-12: "faut separer ... sinon on comprend pas": a manager who
  // placed tomorrow's order in advance needs that visually distinct from today's own order, not
  // folded into one "3 orders" figure that reads as if 3 were placed for the SAME delivery).
  ordersToday: number; ordersTodayOdooDirect: number;
  ordersTomorrow: number; ordersTomorrowOdooDirect: number;
  lossesCount: number;
  transfersPending: number;
};

export async function getManagerShopsStatusAction(): Promise<{ shops?: ManagerShopStatus[]; date?: string; error?: string }> {
  const auth = await currentManager();
  if ('error' in auth) return { error: auth.error };
  const svc = service();
  if (!svc) return { error: 'Server not configured' };
  const date = vnDateStr();
  const recaps = await computeShopRecaps(svc, auth.shops, date);
  return {
    date,
    shops: recaps.map(r => {
      const todayOrders = r.orders.filter(o => o.deliveryDate === date);
      const tomorrowOrders = r.orders.filter(o => o.deliveryDate !== date);
      return {
        shop: r.shop,
        receptionTotal: r.reception?.totalLines ?? 0, receptionConfirmed: r.reception?.confirmedLines ?? 0,
        countDone: !!r.count,
        ordersToday: todayOrders.length, ordersTodayOdooDirect: todayOrders.filter(o => o.odooDirect).length,
        ordersTomorrow: tomorrowOrders.length, ordersTomorrowOdooDirect: tomorrowOrders.filter(o => o.odooDirect).length,
        lossesCount: r.losses.count,
        transfersPending: r.transfers.filter(t => t.status === 'sent').length,
      };
    }),
  };
}
