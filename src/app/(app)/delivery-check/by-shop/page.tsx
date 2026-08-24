import { createClient, getSafeSession } from '@/lib/supabase-server';
import { redirect } from 'next/navigation';
import { ensureDeliveryOrderChecklist, ensureDeliveryOrderChecklistsBatch, ensureUnreconciledChecklist } from '@/lib/delivery-check';
import DeliveryCheckByShopView from './DeliveryCheckByShopView';

export const revalidate = 0;

function labTodayTomorrow(): [string, string] {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' });
  const now = new Date();
  const today = fmt.format(now);
  const tomorrow = fmt.format(new Date(now.getTime() + 24 * 3600 * 1000));
  return [today, tomorrow];
}

// Case/spacing-insensitive comparison — Odoo's own shop_name is often ALL CAPS ("MOON FLOWER")
// while the manual-cake shop pickers use title case ("Moon Flower"); same shop, different
// casing (2026-08-24, Axel: two separate pills showing for what's really one shop). Used for
// mismatch detection here; the view groups rows the same way for the same reason.
function normShop(s: string | null): string {
  return (s ?? '').trim().toLowerCase();
}

// "Par lieu de livraison" (2026-08-24, Axel: "des commande manuel qui sont pour le shop x mais
// livré au shop Y"). A plain Odoo order has exactly ONE shop field (lab_order_lines.shop_name) —
// that mismatch structurally cannot happen for those, Odoo itself has one warehouse/partner per
// order. Manual/exceptional cakes (lab_manual_cakes) are the only place it CAN happen: shop_name
// is the nominal/intended shop, delivered_by is the actual "Giao đến" destination typed at
// creation — the two are already independently editable there. This view groups every
// delivery-check line by the ACTUAL shop (delivered_by when a manual cake is behind the line,
// else the order's own shop_name) and flags a line whose intended shop differs from where it's
// actually going, whether the cake is still unmatched (3rd "panier") or already matched to a
// real Odoo order.
export default async function DeliveryCheckByShopPage() {
  const supabase = createClient();
  const { data: { session } } = await getSafeSession(supabase);
  if (!session) redirect('/login');
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
  if (!['admin', 'lab_manager', 'assistant'].includes(profile?.role ?? '')) redirect('/dashboard');

  const [today, tomorrow] = labTodayTomorrow();
  const dates = [today, tomorrow];

  const { data: imports } = await supabase.from('lab_imports')
    .select('id').in('delivery_date', dates).eq('status', 'published');
  const importIds = (imports ?? []).map((i: any) => i.id);

  // qty > 0 only — see delivery-check index page for why: a cancelled order's lab_order_lines
  // rows are zeroed, never deleted (2026-08-11, REP/2026/01012).
  const { data: orderLines } = importIds.length
    ? await supabase.from('lab_order_lines').select('order_ref, delivery_date').in('import_id', importIds).gt('qty', 0)
    : { data: [] as any[] };
  const { data: packagingOnlyLines } = await supabase.from('lab_order_packaging_lines')
    .select('order_ref, delivery_date').in('delivery_date', dates);

  const orderKeys = Array.from(new Set([
    ...(orderLines ?? []).map((l: any) => `${l.delivery_date}||${l.order_ref}`),
    ...(packagingOnlyLines ?? []).map((l: any) => `${l.delivery_date}||${l.order_ref}`),
  ])).map(k => { const [delivery_date, order_ref] = k.split('||'); return { delivery_date, order_ref }; });

  // Batched path (2026-08-24, Supabase read-volume optimization) — same fallback safety net as
  // the category view: if the batch call throws for any reason, degrade to the proven per-order
  // path rather than breaking the page.
  let results: ({ header: Awaited<ReturnType<typeof ensureDeliveryOrderChecklist>>['header']; lines: Awaited<ReturnType<typeof ensureDeliveryOrderChecklist>>['lines'] } | null)[];
  try {
    const batch = await ensureDeliveryOrderChecklistsBatch(supabase, orderKeys);
    results = orderKeys.map(o => batch.get(`${o.delivery_date}||${o.order_ref}`) ?? null);
  } catch {
    results = await Promise.all(orderKeys.map(async o => {
      try { return await ensureDeliveryOrderChecklist(supabase, o.delivery_date, o.order_ref); }
      catch { return null; }
    }));
  }

  // Manual cakes for the date window — the only source of BOTH "intended shop" (shop_name) and
  // "actual delivery shop" (delivered_by). Matched cakes ride along inside their order's own
  // check lines above (joined back in below by order_ref+sku); unmatched ones are pulled
  // separately from ensureUnreconciledChecklist.
  const { data: cakes } = await supabase.from('lab_manual_cakes')
    .select('id, product_sku, delivery_date, shop_name, delivered_by, matched_order_ref')
    .in('delivery_date', dates).is('cancelled_at', null);
  const cakeByOrderSku = new Map<string, { shop_name: string | null; delivered_by: string | null }>();
  const cakeById = new Map<string, { shop_name: string | null; delivered_by: string | null }>();
  for (const c of cakes ?? []) {
    const info = { shop_name: c.shop_name ?? null, delivered_by: c.delivered_by ?? null };
    if (c.matched_order_ref) cakeByOrderSku.set(`${c.matched_order_ref}||${c.product_sku}`, info);
    cakeById.set(c.id, info);
  }

  type Row = {
    id: string; sku: string | null; product_name_vi: string; product_name_en: string | null;
    category: string; product_category: string | null; team: string | null; order_ref: string | null;
    intended_shop: string | null; actual_shop: string | null; mismatch: boolean; customer_name: string | null;
    delivery_date: string; qty_expected: number; qty_checked: number | null; status: string;
    discrepancy_reason: string | null; discrepancy_note: string | null; note: string | null;
  };
  const rows: Row[] = [];
  for (const r of results) {
    if (!r) continue;
    for (const l of r.lines) {
      const cake = l.sku ? cakeByOrderSku.get(`${r.header.order_ref}||${l.sku}`) : undefined;
      const intended = cake?.shop_name ?? r.header.shop_name;
      const actual = cake?.delivered_by ?? r.header.shop_name;
      rows.push({
        id: l.id, sku: l.sku, product_name_vi: l.product_name_vi, product_name_en: l.product_name_en,
        category: l.category, product_category: l.product_category, team: l.team,
        order_ref: r.header.order_ref, intended_shop: intended, actual_shop: actual,
        mismatch: !!(intended && actual && normShop(intended) !== normShop(actual)),
        customer_name: null,
        delivery_date: r.header.delivery_date, qty_expected: l.qty_expected, qty_checked: l.qty_checked,
        status: l.status, discrepancy_reason: l.discrepancy_reason, discrepancy_note: l.discrepancy_note,
        note: l.note,
      });
    }
  }

  const unreconciled = await ensureUnreconciledChecklist(supabase, dates);
  for (const l of unreconciled) {
    const cake = cakeById.get(l.manual_cake_id);
    const intended = cake?.shop_name ?? null;
    const actual = cake?.delivered_by ?? intended;
    rows.push({
      id: l.id, sku: l.sku, product_name_vi: l.product_name_vi, product_name_en: l.product_name_en,
      category: l.category, product_category: l.product_category, team: l.team,
      order_ref: null, intended_shop: intended, actual_shop: actual,
      mismatch: !!(intended && actual && intended !== actual),
      customer_name: l.customer_name,
      delivery_date: l.delivery_date, qty_expected: l.qty_expected, qty_checked: l.qty_checked,
      status: l.status, discrepancy_reason: l.discrepancy_reason, discrepancy_note: l.discrepancy_note,
      note: l.note,
    });
  }

  return <DeliveryCheckByShopView rows={rows} today={today} tomorrow={tomorrow} />;
}
