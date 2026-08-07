import { createClient, getSafeSession } from '@/lib/supabase-server';
import { redirect } from 'next/navigation';
import ExceptionalOrdersView from './ExceptionalOrdersView';

export const revalidate = 0;

// Exceptional orders — the admin window over ALL manual/urgent orders (any product),
// whether created by an assistant in the app or by a shop via the public link (phase 2).
// The birthday-cakes tab stays the cake-specific operational view; this page is where
// the "enter in Odoo" lifecycle is tracked and duplicates are reconciled.
export default async function ExceptionalOrdersPage() {
  const supabase = createClient();
  const { data: { session } } = await getSafeSession(supabase);
  if (!session) redirect('/login');
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
  if (!['admin', 'lab_manager', 'assistant'].includes(profile?.role ?? '')) redirect('/dashboard');

  const today = new Date().toISOString().split('T')[0];
  const since = new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];

  // 1. All manual orders of the last 30 days + upcoming (matched ones kept for history)
  const { data: manual } = await supabase.from('lab_manual_cakes')
    .select('id, fiche_id, product_name_vi, product_name_en, product_sku, image_url, team, qty, delivery_date, ready_time, delivered_by, delivery_address, message, design_notes, design_photo_url, notes, customer_name, customer_phone, shop_name, needs_odoo, matched_order_ref, matched_at, cancelled_at, cancelled_by_name, cancel_reason, rejected_order_refs, assignment_id, created_by_name, created_at')
    .gte('delivery_date', since)
    .order('delivery_date', { ascending: false })
    .order('created_at', { ascending: false });
  const orders = manual ?? [];

  // 2. Production state of each order's card
  const asgIds = orders.map(o => o.assignment_id).filter(Boolean) as string[];
  const { data: asgs } = asgIds.length
    ? await supabase.from('lab_assignments').select('id, status, qty_produced, transferred, cancelled').in('id', asgIds)
    : { data: [] as any[] };
  const asgById: Record<string, any> = {};
  for (const a of asgs ?? []) asgById[a.id] = a;

  // 3. Auto-match suggestions — an Odoo line with the same SKU + delivery date exists
  //    (same logic as the birthday tab, generalised to every product)
  const openOrders = orders.filter(o => o.needs_odoo && !o.matched_order_ref);
  const mcSkus = Array.from(new Set(openOrders.map(o => o.product_sku).filter(Boolean))) as string[];
  const { data: matchLines } = mcSkus.length
    ? await supabase.from('lab_order_lines').select('product_sku, delivery_date, order_ref, shop_name').in('product_sku', mcSkus).gte('delivery_date', since)
    : { data: [] as any[] };
  const matchBySkuDate: Record<string, { ref: string; shop: string | null }[]> = {};
  for (const l of matchLines ?? []) {
    if (!l.order_ref) continue;
    const k = `${l.product_sku}||${l.delivery_date}`;
    const arr = (matchBySkuDate[k] ??= []);
    if (!arr.find(x => x.ref === l.order_ref)) arr.push({ ref: l.order_ref, shop: l.shop_name ?? null });
  }

  // 4. Manual-link candidates — every Odoo line on the open orders' delivery dates
  //    (any product; the picked line's SKU becomes the match key)
  const openDates = Array.from(new Set(openOrders.map(o => o.delivery_date)));
  const { data: candLines } = openDates.length
    ? await supabase.from('lab_order_lines')
        .select('order_ref, shop_name, delivery_date, product_name_vi, product_sku, qty')
        .in('delivery_date', openDates).order('order_ref')
    : { data: [] as any[] };

  // 5. Product choices for the "new order" modal — the WHOLE active catalogue, one entry
  //    per variant. isCake drives the conditional cake-only fields in the form.
  const { data: fiches } = await supabase
    .from('lab_fiche_meta').select('id, name_vi, name_en, teams, image_url, category').eq('is_active', true);
  const ficheById: Record<string, any> = {};
  for (const f of fiches ?? []) ficheById[f.id] = f;
  const ficheIds = (fiches ?? []).map(f => f.id);
  const { data: vars } = ficheIds.length
    ? await supabase.from('lab_fiche_variants').select('fiche_id, id, sku, label, image_url, is_default, sort_order').in('fiche_id', ficheIds).order('is_default', { ascending: false }).order('sort_order')
    : { data: [] as any[] };
  const skusAll = Array.from(new Set((vars ?? []).map((v: any) => v.sku).filter(Boolean)));
  const { data: nameRows } = skusAll.length
    ? await supabase.from('lab_order_lines').select('product_sku, product_name_vi').in('product_sku', skusAll).limit(5000)
    : { data: [] as any[] };
  const nameBySku: Record<string, string> = {};
  for (const r of nameRows ?? []) if (r.product_sku && r.product_name_vi && !nameBySku[r.product_sku]) nameBySku[r.product_sku] = r.product_name_vi;
  const productChoices = (vars ?? []).flatMap((v: any) => {
    const f = ficheById[v.fiche_id];
    if (!f) return [];
    const label = v.label && v.label !== 'Standard' ? v.label : '';
    const orderName = v.sku ? nameBySku[v.sku] : null;
    const nameVi = orderName
      || (f.name_vi ? (label ? `${f.name_vi} · ${label}` : f.name_vi) : (v.sku || (label ? `· ${label}` : '')));
    if (!nameVi) return [];
    return [{
      ficheId: f.id, variantId: v.id, sku: v.sku ?? null,
      nameVi,
      nameEn: f.name_en || nameVi,
      imageUrl: v.image_url ?? f.image_url ?? null,
      team: (f.teams ?? [])[0] ?? '',
      category: f.category ?? null,
      // Only these two categories can carry a customer-written custom message ("chữ trên bánh") —
      // "Bento cake" added 2026-08-05 after a Bento product's birthday text got typed into the
      // generic Notes field instead (no dedicated input shown), so it never reached
      // lab_manual_cakes.message and thus never surfaced on the Birthday cakes tab / chef's card.
      isCake: f.category === 'Birthday cake' || f.category === 'Bento cake',
    }];
  }).sort((a: any, b: any) => a.nameVi.localeCompare(b.nameVi));

  // lab_order_lines.shop_name comes straight from Odoo and is often ALL CAPS ("MOON FLOWER"),
  // while lab_manual_cakes.shop_name is title case ("Moon Flower") — same normalization used
  // elsewhere (existingOrderChoices in ExceptionalOrdersView.tsx, and the equivalent suggestion
  // list in orders/[date]/page.tsx).
  const normShop = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();
  const list = orders.map(o => {
    const rejected = new Set<string>(o.rejected_order_refs ?? []);
    // Never suggest a candidate from an obviously different shop — a Moon Flower manual cake
    // must not be proposed against a Winmart replenishment just because they share a SKU and
    // delivery date (2026-08-07 incident, see [[lab-app-audit-2026-08-07]]). Only filter when
    // BOTH sides carry a shop name — manual cakes created without one (the classic
    // /birthday-cakes flow) keep the old permissive behavior.
    const sug = (o.needs_odoo && !o.matched_order_ref)
      ? ((matchBySkuDate[`${o.product_sku}||${o.delivery_date}`] ?? []).find(c =>
          !rejected.has(c.ref) && (!o.shop_name || !c.shop || normShop(o.shop_name) === normShop(c.shop))
        ) ?? null)
      : null;
    const asg = o.assignment_id ? asgById[o.assignment_id] ?? null : null;
    return {
      id: o.id,
      name: o.product_name_vi || o.product_name_en || o.product_sku || '—',
      sku: o.product_sku ?? null,
      imageUrl: o.image_url ?? null,
      team: o.team ?? null,
      qty: o.qty,
      deliveryDate: o.delivery_date,
      readyTime: o.ready_time ?? '',
      deliveredBy: o.delivered_by ?? '',
      deliveryAddress: o.delivery_address ?? '',
      message: o.message ?? '',
      notes: o.notes ?? '',
      customerName: o.customer_name ?? '',
      customerPhone: o.customer_phone ?? '',
      source: o.shop_name ? `${o.shop_name}` : (o.created_by_name ?? ''),
      fromShop: !!o.shop_name,
      // '__pending_create__' is a transient claim set while an Odoo document is being
      // created for this row (race guard in createOdooOrderForSelection) — treat it as still
      // "to enter", never as a real matched ref, so a page refresh mid-creation can't show a
      // broken badge or let the admin select it again.
      needsOdoo: !!o.needs_odoo && (!o.matched_order_ref || o.matched_order_ref === '__pending_create__'),
      matchedRef: (o.matched_order_ref && o.matched_order_ref !== '__pending_create__') ? o.matched_order_ref : null,
      claimPending: o.matched_order_ref === '__pending_create__',
      cancelledAt: o.cancelled_at ?? null,
      cancelledByName: o.cancelled_by_name ?? null,
      cancelReason: o.cancel_reason ?? null,
      designNotes: o.design_notes ?? null,
      designPhotoUrl: o.design_photo_url ?? null,
      suggestedRef: sug?.ref ?? null,
      suggestedShop: sug?.shop ?? null,
      prodStatus: (asg?.cancelled ? 'cancelled' : asg?.transferred ? 'transferred' : asg?.status ?? null) as string | null,
      qtyProduced: asg?.qty_produced ?? 0,
    };
  });

  const candidates = (candLines ?? []).map((l: any) => ({
    orderRef: l.order_ref as string, shop: (l.shop_name ?? null) as string | null,
    deliveryDate: l.delivery_date as string, name: l.product_name_vi as string,
    sku: (l.product_sku ?? null) as string | null, qty: l.qty as number,
  }));

  // Universal shop order link (manager RLS)
  const { data: linkRow } = await supabase.from('lab_shop_link').select('token, active').limit(1).maybeSingle();

  return <ExceptionalOrdersView orders={list} candidates={candidates} productChoices={productChoices} today={today}
    shopLinkToken={linkRow?.active ? linkRow.token : null} />;
}
