import { createClient, getSafeSession } from '@/lib/supabase-server';
import { redirect } from 'next/navigation';
import DeliveryCheckIndexView from './DeliveryCheckIndexView';
import { isOrderDone } from '@/lib/delivery-order-status';
import { getOdooDoneExternalMap } from '@/lib/late-delivery-odoo-cache';
import { fetchOrderDeliveryDestinationsBatch, normShopName } from '@/lib/delivery-check';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { listDeliveryGaps } from '@/lib/reception-gaps';
import { fetchProductionGapsByOrder } from '@/lib/delivery-check-production';
import { loadOrderReceptions, isPortalShop, type OrderReception } from '@/lib/reception-tracker';

export const revalidate = 0;
// Delivery-check follow-ups (Odoo unbuild / scrap / MO sync) can take > 10 s.
export const maxDuration = 60;

// Lab-local (Asia/Ho_Chi_Minh) today + tomorrow, matching the paper workflow: assistants
// check what was produced yesterday for today's delivery, and print tomorrow's bons ahead.
function labTodayTomorrow(): [string, string] {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' });
  const now = new Date();
  const today = fmt.format(now);
  const tomorrow = fmt.format(new Date(now.getTime() + 24 * 3600 * 1000));
  return [today, tomorrow];
}

// Same grace window as odoo-sync.ts's SYNC_GRACE_DAYS (2026-08-26, Axel: a manual/exceptional
// cake formalized into a real Odoo order a day+ late, for a delivery_date already in the past —
// without this the order could be synced-in but still invisible on this page, which only ever
// looked at [today, tomorrow]). "Late" orders live in their own tab in the view, not merged into
// today's list, since mixing dates in one list would be confusing.
const LATE_GRACE_DAYS = 7; // Axel, 2026-08-26: "met que 7 jour de retard max" — must match SYNC_GRACE_DAYS in odoo-sync.ts, else a 6-day-late order would be widened-in here but never actually synced from Odoo in the first place
function labDateWindow(today: string, tomorrow: string): string[] {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' });
  const dates = [tomorrow, today];
  for (let i = 1; i <= LATE_GRACE_DAYS; i++) {
    dates.push(fmt.format(new Date(Date.now() - i * 24 * 3600 * 1000)));
  }
  return dates;
}

export default async function DeliveryCheckPage() {
  const supabase = createClient();
  const { data: { session } } = await getSafeSession(supabase);
  if (!session) redirect('/login');
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
  if (!['admin', 'lab_manager', 'assistant'].includes(profile?.role ?? '')) redirect('/dashboard');

  const [today, tomorrow] = labTodayTomorrow();
  const dateWindow = labDateWindow(today, tomorrow);

  // Perf (Axel 2026-10-26): the reads below used to run one after the other (~15 round trips,
  // 4-5 s). Everything that only depends on the date window now starts at once; same queries.
  const svcSb = createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const { unstable_cache } = await import('next/cache');
  const [
    { data: imports }, { data: packagingOnlyLines }, { data: headers }, { data: pendingCakes },
    { data: gapRows }, { data: dateAlertRows }, taskCount, receptionsRes,
  ] = await Promise.all([
    supabase.from('lab_imports').select('id, delivery_date, status').in('delivery_date', dateWindow).eq('status', 'published').limit(5000),
    supabase.from('lab_order_packaging_lines').select('order_ref, delivery_date, shop_name, qty').in('delivery_date', dateWindow).limit(5000),
    supabase.from('lab_delivery_orders').select('id, order_ref, delivery_date, status, printed_at, odoo_push_status, marked_not_delivered').in('delivery_date', dateWindow).limit(5000),
    // Pending manual cakes — same dates as /delivery-check/unreconciled (today + tomorrow, Axel 2026-10-20)
    supabase.from('lab_manual_cakes').select('id').in('delivery_date', [today, tomorrow]).is('matched_order_ref', null).is('cancelled_at', null).limit(2000),
    // Coverage check flagged by the 15-min cron (plain read, no Odoo call)
    supabase.from('lab_sync_gaps').select('order_ref, source_type, delivery_date, reason').or(`delivery_date.in.(${dateWindow.join(',')}),delivery_date.is.null`),
    // Date reassigned in Odoo after import — flag-only banner
    supabase.from('lab_sync_date_alerts').select('order_ref, source_type, old_date, new_date'),
    // Same cached count as the sidebar badge (60 s, invalidated by the gap actions)
    unstable_cache(async () => { const { computeDeliveryTaskCount } = await import('@/lib/delivery-tasks'); try { return await computeDeliveryTaskCount(svcSb as any); } catch { return { base: 0, toSend: 0 }; } },
      ['delivery-task-count'], { revalidate: 60, tags: ['delivery-tasks'] })(),
    // Shop reception tracker (Axel 2026-10-16) — today + late days; never blocks the page
    loadOrderReceptions(svcSb as any, dateWindow.filter(d => d <= today)).catch((e: any) => { console.error('reception tracker failed:', e); return [] as OrderReception[]; }),
  ]);
  const importIds = (imports ?? []).map((i: any) => i.id);

  // qty > 0 only: a cancelled Odoo order isn't deleted from lab_order_lines, applyOdooChanges
  // just zeroes its qty (odoo-apply.ts) and marks the production card cancelled — the row stays.
  // Without this filter a cancelled order kept showing up here as a phantom bon to check, all
  // lines ×0 (2026-08-11, REP/2026/01012).
  // BUG FIX 2026-08-26: widening dateWindow to 9 days (today+tomorrow+7 late-grace days) makes
  // this match 2700+ rows on a normal day. Supabase's PostgREST enforces its own server-side
  // "Max Rows" cap (1000 here) that silently overrides ANY client-side .limit() above it — a
  // first attempt at fixing this with .limit(10000) had ZERO effect (confirmed via a debug log:
  // orderLinesCount was still exactly 1000), and Postgres doesn't return rows in date order, so
  // most of TODAY's orders landed outside the first 1000 and never reached the page. Axel: "j'ai
  // bien seulement 4 commande de delivery check aujourd'hui" instead of ~12-13. Real fix: page
  // through with .range() until a page comes back short, so the true total is always fetched
  // regardless of the server-side per-request cap.
  const PAGE = 1000;
  let orderLines: { order_ref: string; delivery_date: string; shop_name: string; qty: number }[] = [];
  if (importIds.length) {
    for (let offset = 0; ; offset += PAGE) {
      const { data: page } = await supabase.from('lab_order_lines')
        .select('order_ref, delivery_date, shop_name, qty')
        .in('import_id', importIds).in('delivery_date', dateWindow).gt('qty', 0)
        .range(offset, offset + PAGE - 1);
      orderLines = orderLines.concat(page ?? []);
      if (!page || page.length < PAGE) break;
    }
  }

  // A 100%-packaging order (e.g. a pure supplies-restock replenishment) has NO lab_order_lines
  // rows at all — it only ever lives in lab_order_packaging_lines. Union both sources so it
  // still shows up as a bon to check, instead of being invisible (2026-08-10, REP/2026/01003).

  type Row = { order_ref: string; delivery_date: string; shop_name: string; lineCount: number };
  const byKey: Record<string, Row> = {};
  for (const l of orderLines ?? []) {
    const key = `${l.delivery_date}||${l.order_ref}`;
    (byKey[key] ??= { order_ref: l.order_ref, delivery_date: l.delivery_date, shop_name: l.shop_name, lineCount: 0 }).lineCount++;
  }
  for (const l of packagingOnlyLines ?? []) {
    const key = `${l.delivery_date}||${l.order_ref}`;
    if (byKey[key]) continue; // already counted via lab_order_lines
    (byKey[key] ??= { order_ref: l.order_ref, delivery_date: l.delivery_date, shop_name: l.shop_name, lineCount: 0 }).lineCount++;
  }
  const orders = Object.values(byKey).sort((a, b) => a.delivery_date.localeCompare(b.delivery_date) || a.order_ref.localeCompare(b.order_ref));

  // "Qui a passé commande" (Axel, 2026-09-20 diagnostic) — additive, read-only display info,
  // never touches the check flow itself. Two sources, deliberately not merged into one concept:
  //  - manager_name: a shop staff member confirmed this order with their PIN through the app's
  //    own Đặt hàng flow (submitManagerOrderAction, src/app/shop/actions.ts) — lab_shop_manager_orders
  //    is the audit trail written at that moment, keyed by the same order_ref shown here.
  //  - is_online_order: this order_ref was instead created by an ADMIN from /exceptional-orders
  //    ("Créer commande Odoo" on a manual/online-sale cake — createOdooOrderForSelection,
  //    odoo-shop-order-sync.ts). There's no manager/PIN concept there at all — lab_manual_cakes
  //    is what links a matched_order_ref back to that origin. Confirmed 2026-09-20: of the
  //    order_refs with no manager_name, the vast majority are exactly this case (Set Lettre de
  //    Shanghai, mini cakes, etc.) — a handful of remaining ones are shops ordering straight in
  //    Odoo (no app trail at all), which neither source covers — left blank for those, on purpose.
  const orderRefs = orders.map(o => o.order_ref);
  const headerIds = (headers ?? []).map((h: any) => h.id);
  // "Écart SX" tag (Axel, 2026-10-19) — display only, empty on failure.
  const prodShortByKey: Record<string, string[]> = {};
  // "Livré ailleurs que son shop" (Axel, 2026-09-22) + progress X/Y + Écart SX — all in parallel.
  const [[{ data: managerOrders }, { data: onlineMatches }], deliveryDestByRef, prodGapsByKey, { data: checkLines }] = await Promise.all([
    orderRefs.length
      ? Promise.all([
          supabase.from('lab_shop_manager_orders').select('order_ref, manager_name').in('order_ref', orderRefs),
          supabase.from('lab_manual_cakes').select('matched_order_ref').in('matched_order_ref', orderRefs),
        ])
      : Promise.resolve([{ data: [] as any[] }, { data: [] as any[] }] as any),
    fetchOrderDeliveryDestinationsBatch(supabase, orderRefs),
    fetchProductionGapsByOrder(supabase, dateWindow,
      Object.fromEntries((headers ?? []).map((h: any) => [h.id, { order_ref: h.order_ref, delivery_date: h.delivery_date }])), prodShortByKey),
    // Chunked: PostgREST caps each response at 1000 rows (a 9-day window has more check lines).
    (async () => {
      const chunks: string[][] = [];
      for (let i = 0; i < headerIds.length; i += 7) chunks.push(headerIds.slice(i, i + 7)); // ≤7 orders × ≤135 lines (max seen) < 1000
      const parts = await Promise.all(chunks.map(c => supabase.from('lab_delivery_check_lines').select('delivery_order_id, qty_checked').in('delivery_order_id', c).limit(1000)));
      return { data: parts.flatMap(p => p.data ?? []) };
    })(),
  ]);
  const managerNameByRef: Record<string, string> = {};
  for (const m of managerOrders ?? []) if (m.order_ref && m.manager_name) managerNameByRef[m.order_ref] = m.manager_name;
  const onlineOrderRefs = new Set((onlineMatches ?? []).map((m: any) => m.matched_order_ref).filter(Boolean));

  const headerByKey: Record<string, { id: string; status: string; printed_at: string | null; odoo_push_status: string | null; marked_not_delivered: boolean }> = {};
  for (const h of headers ?? []) headerByKey[`${h.delivery_date}||${h.order_ref}`] = { id: h.id, status: h.status, printed_at: h.printed_at ?? null, odoo_push_status: (h as any).odoo_push_status ?? null, marked_not_delivered: (h as any).marked_not_delivered ?? false };

  const linesByHeader: Record<string, { total: number; checked: number }> = {};
  for (const l of checkLines ?? []) {
    const e = linesByHeader[l.delivery_order_id] ??= { total: 0, checked: 0 };
    e.total++; if (l.qty_checked != null) e.checked++;
  }

  const ordersWithProgress = orders.map(o => {
    const key = `${o.delivery_date}||${o.order_ref}`;
    const h = headerByKey[key];
    const counts = h ? linesByHeader[h.id] : undefined;
    return {
      ...o,
      status: h?.status ?? 'not_started',
      checked: counts?.checked ?? 0,
      total: counts?.total ?? o.lineCount,
      printed_at: h?.printed_at ?? null,
      odoo_push_status: h?.odoo_push_status ?? null,
      // App-only "ne sera pas livrée" flag (Axel, 2026-09-18) — surfaced here too so the
      // recap list matches the red "100% (non livrée)" the order's own page already shows,
      // instead of the plain green "validé" it fell back to before.
      marked_not_delivered: h?.marked_not_delivered ?? false,
      prod_gap: prodGapsByKey[key] ?? [],
      prod_short: prodShortByKey[key] ?? [],
      // "Qui a passé commande" (Axel, 2026-09-20) — see the comment above managerNameByRef/
      // onlineOrderRefs for what each of these does and doesn't cover.
      manager_name: managerNameByRef[o.order_ref] ?? null,
      is_online_order: onlineOrderRefs.has(o.order_ref),
      // Delivery-destination mismatch (see fetchOrderDeliveryDestinationsBatch's doc comment).
      ...(() => {
        const dests = deliveryDestByRef.get(o.order_ref) ?? [];
        const mismatching = dests.filter(s => normShopName(s) !== normShopName(o.shop_name));
        return { mismatch: mismatching.length > 0, actual_shop: mismatching.length ? mismatching.join(', ') : null };
      })(),
    };
  });

  // Vérification Odoo (Axel, 2026-09-03 : S03515 "Fully Delivered" sur Odoo mais toujours
  // "en retard" sans signal dans l'app) — scopée aux seules commandes déjà en retard côté app,
  // avec cache (voir late-delivery-odoo-cache.ts) pour ne jamais multiplier les appels Odoo au
  // fil des chargements de page par toute l'équipe.
  const lateCandidates = ordersWithProgress
    .filter(o => o.delivery_date < today && !isOrderDone(o))
    .map(o => ({ order_ref: o.order_ref, delivery_date: o.delivery_date }));
  const odooDoneExternalMap = await getOdooDoneExternalMap(supabase, lateCandidates);
  const ordersFinal = ordersWithProgress.map(o => ({
    ...o,
    odoo_done_external: odooDoneExternalMap[`${o.delivery_date}||${o.order_ref}`] ?? false,
  }));

  const deliveryGapsCount = taskCount.base + (['admin', 'lab_manager'].includes(profile?.role ?? '') ? taskCount.toSend : 0);
  const receptions: OrderReception[] = receptionsRes as OrderReception[];
  // Today's portal-shop orders not sent yet (not counted, shown as "+N not sent yet").
  const notSentToday = ordersFinal.filter(o => o.delivery_date === today && isPortalShop(o.shop_name)
    && o.status !== 'validated' && !o.marked_not_delivered).length;

  return (
    <DeliveryCheckIndexView
      receptions={receptions}
      notSentToday={notSentToday}
      deliveryGapsCount={deliveryGapsCount}
      today={today}
      tomorrow={tomorrow}
      orders={ordersFinal}
      pendingCakesCount={(pendingCakes ?? []).length}
      syncGaps={gapRows ?? []}
      dateAlerts={dateAlertRows ?? []}
    />
  );
}
