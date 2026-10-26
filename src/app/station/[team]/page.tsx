import { parseWishNote } from '@/lib/cake-wish';
import { createClient, getSafeSession } from '@/lib/supabase-server';
import { redirect } from 'next/navigation';
import StationView from './StationView';
import type { Team } from '@/lib/types';
import { TEAMS } from '@/lib/types';
import { filterByPublished } from '@/lib/published-cards';

export const revalidate = 0;

export default async function StationPage({ params }: { params: { team: string } }) {
  const supabase = createClient();
  const { data: { session } } = await getSafeSession(supabase);

  let team = params.team as Team;

  if (params.team === 'me') {
    if (!session) redirect('/login');
    const { data: labProfile } = await supabase
      .from('lab_profiles')
      .select('team')
      .eq('id', session.user.id)
      .single();
    if (!labProfile?.team) redirect('/login');
    team = labProfile.team as Team;
  }

  if (!TEAMS.includes(team)) redirect('/login');

  // Current user role (worker/viewer → read-only station mode) + name (for production traceability)
  let userRole: string | null = null;
  let userName: string | null = null;
  const userId: string | null = session?.user.id ?? null;
  if (session) {
    const { data: profile } = await supabase
      .from('profiles')
      .select('role, full_name')
      .eq('id', session.user.id)
      .single();
    userRole = profile?.role ?? null;
    userName = profile?.full_name ?? null;
  }

  const today = new Date().toISOString().split('T')[0];
  const tomorrowDate = new Date();
  tomorrowDate.setDate(tomorrowDate.getDate() + 1);
  const tomorrow = tomorrowDate.toISOString().split('T')[0];

  // Load a full day's production (assignments enriched with fiche/variant/breakdown).
  // Lab fiches are the ONLY product reference — zero reads from the B2C catalogue tables.
  async function loadDay(date: string) {
    // Day's import ids first, then cards by import_id (index): the embedded-filter form alone
    // made Postgres read every card of the team (~4 000) on each load — 0.5 s+ (2026-10-26 audit).
    const { data: dayImports } = await supabase.from('lab_imports').select('id')
      .eq('delivery_date', date).eq('status', 'published');
    const dayImportIds = (dayImports ?? []).map((i: any) => i.id);
    const { data: assignments } = !dayImportIds.length ? { data: [] as any[] } : await supabase
      .from('lab_assignments')
      .select(`
        id, fiche_id, variant_id, product_name_vi, product_name_en, image_url,
        variant_label, total_qty, qty_to_produce, qty_produced,
        status, is_extra, produced_ahead, cancelled, transferred, qty_sent_total, notes, sort_order, import_id,
        produced_by_name, produced_at,
        corrected_at, corrected_by_name, corrected_reason, corrected_from, corrected_qty, corrected_ref,
        lab_imports!inner(delivery_date, order_number, type, status, imported_at)
      `)
      .eq('team', team)
      .in('import_id', dayImportIds)
      .eq('lab_imports.status', 'published')
      .eq('lab_imports.delivery_date', date)
      .order('sort_order')
      .limit(120);

    const assignmentIds = (assignments ?? []).map((a: any) => a.id);
    const { data: breakdowns } = assignmentIds.length > 0
      ? await supabase.from('lab_assignments').select('id, breakdown').in('id', assignmentIds)
      : { data: [] as any[] };
    const breakdownMap: Record<string, any[]> = {};
    for (const b of breakdowns ?? []) breakdownMap[b.id] = Array.isArray(b.breakdown) ? b.breakdown : [];

    const ficheIds = Array.from(new Set((assignments ?? []).map((a: any) => a.fiche_id).filter(Boolean))) as string[];
    const { data: ficheRows } = ficheIds.length > 0
      ? await supabase.from('lab_fiche_meta').select('id, category, weight_grams, image_url').in('id', ficheIds)
      : { data: [] as any[] };
    const ficheById: Record<string, any> = {};
    for (const f of ficheRows ?? []) ficheById[f.id] = { category: f.category ?? null, weight_grams: f.weight_grams ?? null, image_url: f.image_url ?? null };

    const variantIds = Array.from(new Set((assignments ?? []).map((a: any) => a.variant_id).filter(Boolean))) as string[];
    const { data: variantRows } = variantIds.length > 0
      ? await supabase.from('lab_fiche_variants').select('id, sku, weight_g, image_url').in('id', variantIds)
      : { data: [] as any[] };
    const variantById: Record<string, any> = {};
    for (const v of variantRows ?? []) variantById[v.id] = { sku: v.sku ?? null, weight_g: v.weight_g ?? null, image_url: v.image_url ?? null };

    const importIds = Array.from(new Set((assignments ?? []).map((a: any) => a.import_id).filter(Boolean))) as string[];

    // Odoo state per order ref (draft/sent/sale) — to warn chefs that an order is still a
    // draft/quotation in Odoo (it may still change or be cancelled).
    const { data: impCR } = importIds.length > 0
      ? await supabase.from('lab_imports').select('id, control_report').in('id', importIds)
      : { data: [] as any[] };
    const orderStates: Record<string, string> = {};
    for (const imp of impCR ?? []) { const s = (imp as any).control_report?.order_states; if (s) Object.assign(orderStates, s); }
    const isDraftOdoo = (refs: (string | undefined)[]) =>
      refs.some(r => { const st = r ? orderStates[r] : undefined; return !!st && st !== 'sale' && st !== 'approved'; });

    const { data: orderLineDeliveries } = importIds.length > 0
      ? await supabase.from('lab_order_lines').select('order_ref, delivery_time').in('import_id', importIds)
          .not('delivery_time', 'is', null).not('order_ref', 'is', null)
      : { data: [] as any[] };
    const deliveryTimeByRef: Record<string, string> = {};
    for (const ol of orderLineDeliveries ?? []) if (ol.order_ref && ol.delivery_time) deliveryTimeByRef[ol.order_ref] = ol.delivery_time;

    // Birthday-cake complementary info (message + ready-by time) entered by assistants,
    // shown read-only to the chef. Linked to the card BY assignment_id (exact link stamped at
    // import, v19) — with a product-name fallback for legacy lines imported before the stamp.
    const { data: teamLines } = importIds.length > 0
      ? await supabase.from('lab_order_lines').select('id, product_name_vi, assignment_id').in('import_id', importIds)
      : { data: [] as any[] };
    const lineById: Record<string, { name: string; asgId: string | null }> = {};
    for (const l of teamLines ?? []) lineById[l.id] = { name: l.product_name_vi, asgId: l.assignment_id ?? null };
    const teamLineIds = (teamLines ?? []).map((l: any) => l.id);
    const { data: bcDetails } = teamLineIds.length > 0
      ? await supabase.from('lab_birthday_details').select('order_line_id, message, ready_time').in('order_line_id', teamLineIds)
      : { data: [] as any[] };
    const bcByAsg: Record<string, { messages: string[]; ready: string | null }> = {};
    const bcByProduct: Record<string, { messages: string[]; ready: string | null }> = {}; // legacy name fallback
    for (const d of bcDetails ?? []) {
      const line = lineById[d.order_line_id]; if (!line) continue;
      const bucket = line.asgId
        ? (bcByAsg[line.asgId] ??= { messages: [], ready: null })
        : (bcByProduct[line.name] ??= { messages: [], ready: null });
      if (d.message) bucket.messages.push(d.message);
      if (d.ready_time && (!bucket.ready || d.ready_time < bucket.ready)) bucket.ready = d.ready_time;
    }

    // Manual (app-created) cakes: their message / ready-time is linked to the card directly.
    // shop_name + matched_order_ref (2026-08-25, Axel: manual cake cards have an empty
    // `breakdown` — unlike normal Odoo-sourced cards — so the chef couldn't see WHICH shop a
    // manual/exceptional cake belongs to, or which real order it ended up matched to once one
    // exists. '__pending_create__' is the in-flight sentinel (see manual-cake-coverage.ts) —
    // not a real order ref, so it's filtered out here rather than shown to the chef.
    const asgIds = (assignments ?? []).map((a: any) => a.id);
    // notes (generic free-text, distinct from `message` which is cake-only "chữ trên bánh")
    // added 2026-08-27 (Axel: staff reported entremets never show their notes on the chef's
    // card) — this generic field was captured on every manual/exceptional order regardless of
    // category (see exceptional-orders form) but was never selected here, so it never reached
    // the chef for ANY category. Most noticeable on entremets because those never get a
    // `message` either (message is gated to Birthday cake / Bento cake), so notes was their
    // only channel for special instructions — and it was silently dropped.
    const { data: manualCakes } = asgIds.length > 0
      ? await supabase.from('lab_manual_cakes').select('assignment_id, message, notes, ready_time, design_notes, design_photo_url, shop_name, matched_order_ref').in('assignment_id', asgIds)
      : { data: [] as any[] };
    const manualByAsg: Record<string, { message: string | null; notes: string | null; ready_time: string | null; design_notes: string | null; design_photo_url: string | null; shop_name: string | null; order_ref: string | null }> = {};
    for (const m of manualCakes ?? []) if (m.assignment_id) manualByAsg[m.assignment_id] = {
      message: m.message, notes: m.notes ?? null, ready_time: m.ready_time, design_notes: m.design_notes, design_photo_url: m.design_photo_url,
      shop_name: m.shop_name ?? null,
      order_ref: (m.matched_order_ref && m.matched_order_ref !== '__pending_create__') ? m.matched_order_ref : null,
    };

    // Which client orders of this day are published — chefs only see published portions.
    const { data: pubRows } = importIds.length > 0
      ? await supabase.from('lab_order_lines').select('order_ref').eq('delivery_date', date).eq('published', true)
      : { data: [] as any[] };
    const publishedRefs = new Set((pubRows ?? []).map((r: any) => r.order_ref).filter(Boolean));

    // Birthday-cake message typed by the shop in its order form (Axel, 2026-10-17): it rides in the
    // line note as "🎂 <message> | <note>" (src/lib/cake-wish.ts). Orders placed through the shop
    // form always carry an explicit decision, so a cake from those orders with no message is a
    // display cake ("no message"), not a missing one: only other orders keep the red badge.
    const allRefs = Array.from(new Set(Object.values(breakdownMap).flat().map((b: any) => b?.order_ref).filter(Boolean))) as string[];
    // Read with the service role: chefs have no RLS access to lab_shop_manager_orders (only the
    // order refs are read). Without the key, nothing is found and the red badge stays as before.
    let formRows: any[] = [];
    if (allRefs.length && process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.NEXT_PUBLIC_SUPABASE_URL) {
      const { createClient: createSb } = await import('@supabase/supabase-js');
      const svc = createSb(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
      const { data } = await svc.from('lab_shop_manager_orders').select('order_ref').in('order_ref', allRefs);
      formRows = data ?? [];
    }
    const shopFormRefs = new Set(formRows.map((r: any) => r.order_ref));

    // Delivered before declared (Axel, 2026-10-23): a delivery check already counted this product
    // for one of the card's orders while the card is not produced / not sent to stock yet. Chefs
    // have no RLS on the delivery tables → service role, read only. Key = order_ref|sku.
    const deliveredByKey: Record<string, { qty: number; at: string | null; shop: string }> = {};
    if (allRefs.length && process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.NEXT_PUBLIC_SUPABASE_URL) {
      const { createClient: createSb } = await import('@supabase/supabase-js');
      const svc = createSb(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
      const { data: orders } = await svc.from('lab_delivery_orders')
        .select('id, order_ref, shop_name, customer_name, marked_not_delivered')
        .eq('delivery_date', date).in('order_ref', allRefs);
      const live = (orders ?? []).filter((o: any) => !o.marked_not_delivered);
      if (live.length) {
        const byId: Record<string, any> = {};
        for (const o of live) byId[o.id] = o;
        const { data: lines } = await svc.from('lab_delivery_check_lines')
          .select('delivery_order_id, sku, qty_checked, checked_at')
          .in('delivery_order_id', live.map((o: any) => o.id)).gt('qty_checked', 0);
        for (const l of lines ?? []) {
          const o = byId[l.delivery_order_id]; if (!o || !l.sku) continue;
          const k = `${o.order_ref}|${l.sku}`;
          const e = deliveredByKey[k] ?? { qty: 0, at: null, shop: o.shop_name || o.customer_name || '' };
          e.qty += Number(l.qty_checked) || 0;
          if (l.checked_at && (!e.at || l.checked_at < e.at)) e.at = l.checked_at;
          deliveredByKey[k] = e;
        }
      }
    }
    const deliveredFor = (sku: string | null, bds: any[]) => {
      if (!sku) return null;
      let qty = 0; let at: string | null = null; const shops: string[] = [];
      for (const b of bds) {
        const d = b?.order_ref ? deliveredByKey[`${b.order_ref}|${sku}`] : undefined;
        if (!d) continue;
        qty += Math.min(d.qty, Number(b.qty) || d.qty);
        if (d.at && (!at || d.at < at)) at = d.at;
        if (d.shop && !shops.includes(d.shop)) shops.push(d.shop);
      }
      return qty > 0 ? { qty, at, shops } : null;
    };

    const mapped = (assignments ?? []).map((a: any) => {
      const bdsRaw: any[] = breakdownMap[a.id] ?? [];
      const bdsParsed = bdsRaw.map((b: any) => ({ b, w: parseWishNote(b?.note) }));
      const shopWishes = bdsParsed.map(x => x.w.wish).filter(Boolean);
      const allFromShopForm = bdsRaw.length > 0 && bdsRaw.every((b: any) => b?.order_ref && shopFormRefs.has(b.order_ref));
      const variant = a.variant_id ? variantById[a.variant_id] ?? null : null;
      const fiche = a.fiche_id ? ficheById[a.fiche_id] ?? null : null;
      return {
        ...a,
        sku: variant?.sku ?? null,
        image_url: variant?.image_url ?? fiche?.image_url ?? a.image_url ?? null,
        weight_grams: variant?.weight_g ?? fiche?.weight_grams ?? null,
        category_name_vi: fiche?.category ?? null,
        category_name_en: fiche?.category ?? null,
        bc_message: bcByAsg[a.id]?.messages.join(' · ') || bcByProduct[a.product_name_vi]?.messages.join(' · ') || manualByAsg[a.id]?.message || shopWishes.join(' · ') || null,
        bc_no_wish: !shopWishes.length && allFromShopForm,
        bc_ready_time: bcByAsg[a.id]?.ready || bcByProduct[a.product_name_vi]?.ready || manualByAsg[a.id]?.ready_time || null,
        bc_notes: manualByAsg[a.id]?.notes || null,
        bc_design_notes: manualByAsg[a.id]?.design_notes || null,
        bc_design_photo_url: manualByAsg[a.id]?.design_photo_url || null,
        bc_shop_name: manualByAsg[a.id]?.shop_name || null,
        bc_order_ref: manualByAsg[a.id]?.order_ref || null,
        delivered: deliveredFor(variant?.sku ?? null, bdsRaw),
        draft_odoo: isDraftOdoo(((breakdownMap[a.id] ?? []) as any[]).map((b: any) => b.order_ref)),
        breakdown: bdsParsed.map(({ b, w }) => ({
          ...b,
          note: w.isBirthday ? (w.note || null) : (b.note ?? null),
          wish: w.wish || null,
          delivery_time: b.order_ref ? (deliveryTimeByRef[b.order_ref] ?? null) : null,
        })),
        lab_imports: Array.isArray(a.lab_imports) ? a.lab_imports[0] : a.lab_imports,
      };
    });
    return filterByPublished(mapped, publishedRefs);
  }

  const [todayAssignments, tomorrowAssignments] = await Promise.all([loadDay(today), loadDay(tomorrow)]);

  return <StationView team={team} teamSlug={params.team}
    assignments={todayAssignments} tomorrowAssignments={tomorrowAssignments}
    viewDate={today} today={today} tomorrow={tomorrow} isHistoryView={false} userRole={userRole} userId={userId} userName={userName} />;
}
