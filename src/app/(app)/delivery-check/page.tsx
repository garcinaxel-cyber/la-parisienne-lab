import { createClient, getSafeSession } from '@/lib/supabase-server';
import { redirect } from 'next/navigation';
import DeliveryCheckIndexView from './DeliveryCheckIndexView';

export const revalidate = 0;

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

  const { data: imports, error: importsErr } = await supabase.from('lab_imports')
    .select('id, delivery_date, status').in('delivery_date', dateWindow).eq('status', 'published')
    .limit(5000);
  const importIds = (imports ?? []).map((i: any) => i.id);
  // TEMP DEBUG 2026-08-26 (Axel: "je vois toujours pas les commandes") — remove once root-caused.
  console.log('[delivery-check DEBUG]', JSON.stringify({ today, dateWindow, importsCount: imports?.length, importsErr: importsErr?.message }));

  // qty > 0 only: a cancelled Odoo order isn't deleted from lab_order_lines, applyOdooChanges
  // just zeroes its qty (odoo-apply.ts) and marks the production card cancelled — the row stays.
  // Without this filter a cancelled order kept showing up here as a phantom bon to check, all
  // lines ×0 (2026-08-11, REP/2026/01012).
  // BUG FIX 2026-08-26: widening dateWindow to 9 days (today+tomorrow+7 late-grace days) made
  // this .in('import_id', importIds) fan-out return 2700+ rows on a normal day — well past
  // PostgREST/supabase-js's default 1000-row response cap, which silently truncates in
  // whatever order Postgres happens to return rows (not date-sorted), so TODAY's orders could
  // be partly or entirely cut from the result depending on where they landed. Axel: "j'ai bien
  // seulement 4 commande de delivery check aujourd'hui" instead of the expected ~12-13. Explicit
  // .limit() well above any realistic volume fixes it; filtering directly on delivery_date
  // instead of via import_id also shrinks the actual row count fetched.
  const { data: orderLines, error: orderLinesErr } = importIds.length
    ? await supabase.from('lab_order_lines')
        .select('order_ref, delivery_date, shop_name, qty')
        .in('import_id', importIds).in('delivery_date', dateWindow).gt('qty', 0)
        .limit(10000)
    : { data: [] as any[], error: null as any };
  console.log('[delivery-check DEBUG]', JSON.stringify({
    importIdsCount: importIds.length,
    orderLinesCount: orderLines?.length,
    orderLinesErr: orderLinesErr?.message,
    orderLinesTodayRefs: Array.from(new Set((orderLines ?? []).filter((l: any) => l.delivery_date === today).map((l: any) => l.order_ref))),
  }));

  // A 100%-packaging order (e.g. a pure supplies-restock replenishment) has NO lab_order_lines
  // rows at all — it only ever lives in lab_order_packaging_lines. Union both sources so it
  // still shows up as a bon to check, instead of being invisible (2026-08-10, REP/2026/01003).
  const { data: packagingOnlyLines } = await supabase.from('lab_order_packaging_lines')
    .select('order_ref, delivery_date, shop_name, qty').in('delivery_date', dateWindow)
    .limit(5000);

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

  // Progress: any lab_delivery_orders header already started for these (date, ref)
  const { data: headers } = orders.length
    ? await supabase.from('lab_delivery_orders')
        .select('id, order_ref, delivery_date, status, printed_at, odoo_push_status')
        .in('delivery_date', dateWindow)
        .limit(5000)
    : { data: [] as any[] };
  const headerByKey: Record<string, { id: string; status: string; printed_at: string | null; odoo_push_status: string | null }> = {};
  for (const h of headers ?? []) headerByKey[`${h.delivery_date}||${h.order_ref}`] = { id: h.id, status: h.status, printed_at: h.printed_at ?? null, odoo_push_status: (h as any).odoo_push_status ?? null };
  const headerIds = (headers ?? []).map((h: any) => h.id);

  // Lines checked so far, to show an "X/Y" progress badge without opening the order
  const { data: checkLines } = headerIds.length
    ? await supabase.from('lab_delivery_check_lines').select('delivery_order_id, qty_checked').in('delivery_order_id', headerIds).limit(20000)
    : { data: [] as any[] };
  const linesByHeader: Record<string, { total: number; checked: number }> = {};
  for (const l of checkLines ?? []) {
    const e = linesByHeader[l.delivery_order_id] ??= { total: 0, checked: 0 };
    e.total++; if (l.qty_checked != null) e.checked++;
  }

  // Pending manual cakes (3rd panier) for the badge count
  const { data: pendingCakes } = await supabase.from('lab_manual_cakes')
    .select('id').in('delivery_date', dateWindow).is('matched_order_ref', null).is('cancelled_at', null)
    .limit(2000);

  // Coverage check (see odoo-sync.ts's syncGaps doc comment): the 15-min cron already flags any
  // Odoo order that ended up with zero representation in the app — this is a plain read of that,
  // no Odoo call here. Axel asked for this after REP/2026/01006 turned out invisible with no warning.
  const { data: gapRows } = await supabase.from('lab_sync_gaps')
    .select('order_ref, source_type, delivery_date, reason').or(`delivery_date.in.(${dateWindow.join(',')}),delivery_date.is.null`);

  // Date reassigned in Odoo after import (see odoo-sync.ts's OdooSyncResult.dateChanges doc
  // comment, 2026-08-12 S03188/KAFEBEAN) — flag-only banner, not filtered to today/tomorrow since
  // the OLD (wrong) date could be any day still in the sync window.
  const { data: dateAlertRows } = await supabase.from('lab_sync_date_alerts')
    .select('order_ref, source_type, old_date, new_date');

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
    };
  });

  return (
    <DeliveryCheckIndexView
      today={today}
      tomorrow={tomorrow}
      orders={ordersWithProgress}
      pendingCakesCount={(pendingCakes ?? []).length}
      syncGaps={gapRows ?? []}
      dateAlerts={dateAlertRows ?? []}
    />
  );
}
