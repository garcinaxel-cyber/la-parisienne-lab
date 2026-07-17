import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';

export const dynamic = 'force-dynamic';

// TEMP read-only diagnostic — inspect BCPD24 (Charlotte Passion D24) + phantom "orders not
// published". Admin only. Delete after use.
export async function GET(req: Request) {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return NextResponse.json({ error: 'auth' }, { status: 401 });
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
  if (!['admin', 'lab_manager'].includes(profile?.role ?? '')) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  const today = new Date().toISOString().split('T')[0];
  const sku = new URL(req.url).searchParams.get('sku') || 'BCPD24';

  // 1. BCPD24 — any fiche variant? any order lines? Charlotte Passion fiches overview.
  const { data: variantsForSku } = await supabase.from('lab_fiche_variants')
    .select('id, fiche_id, label, sku, weight_g').eq('sku', sku);
  const { data: linesForSku } = await supabase.from('lab_order_lines')
    .select('id, order_ref, delivery_date, import_id, qty, published, product_name_vi, fiche_id, variant_id')
    .eq('product_sku', sku).gte('delivery_date', today);
  const { data: charlotteVariants } = await supabase.from('lab_fiche_variants')
    .select('id, fiche_id, label, sku').ilike('sku', 'BC%D%');
  const { data: charlotteFiches } = await supabase.from('lab_fiche_meta')
    .select('id, name_vi, name_en, category, is_active').ilike('name_vi', '%Charlotte Passion%');

  // 2. Unpublished orders on upcoming dates — is `published` false or NULL? Is the import published?
  const { data: upLines } = await supabase.from('lab_order_lines')
    .select('order_ref, delivery_date, import_id, published, product_sku')
    .gte('delivery_date', today);
  const { data: upImports } = await supabase.from('lab_imports')
    .select('id, delivery_date, order_number, type, status, notes').gte('delivery_date', today);
  const impById: Record<string, any> = {};
  for (const i of upImports ?? []) impById[i.id] = i;

  // Per (date, order_ref): count published true / false / null, and parent import status
  const byOrder: Record<string, any> = {};
  for (const l of upLines ?? []) {
    const k = `${l.delivery_date}||${l.order_ref}`;
    const o = byOrder[k] ??= { date: l.delivery_date, order_ref: l.order_ref, t: 0, f: 0, n: 0, importStatuses: new Set<string>(), importIds: new Set<string>() };
    if (l.published === true) o.t++; else if (l.published === false) o.f++; else o.n++;
    o.importStatuses.add(impById[l.import_id]?.status ?? '???');
    o.importIds.add(l.import_id);
  }
  const unpublishedOrders = Object.values(byOrder)
    .filter((o: any) => o.f > 0 || o.n > 0)
    .map((o: any) => ({ date: o.date, order_ref: o.order_ref, published: o.t, unpub_false: o.f, unpub_null: o.n, importStatuses: Array.from(o.importStatuses) }));

  // Group unpublished orders by date so we can see which date shows the banner + how many
  const byDate: Record<string, any> = {};
  for (const o of unpublishedOrders) {
    const d = byDate[o.date] ??= { date: o.date, count: 0, orders: [] as string[], hasPublishedImport: false };
    d.count++; d.orders.push(o.order_ref);
  }
  for (const i of upImports ?? []) {
    if (i.status === 'published' && byDate[i.delivery_date]) byDate[i.delivery_date].hasPublishedImport = true;
  }

  // 3. Recently linked manual cakes — did their info survive onto the Odoo line's birthday_details?
  const { data: matchedCakes } = await supabase.from('lab_manual_cakes')
    .select('id, product_sku, delivery_date, matched_order_ref, message, delivery_address, ready_time, delivered_by')
    .not('matched_order_ref', 'is', null).gte('delivery_date', today);
  const linkCheck: any[] = [];
  for (const m of matchedCakes ?? []) {
    let lq = supabase.from('lab_order_lines').select('id')
      .eq('order_ref', m.matched_order_ref).eq('delivery_date', m.delivery_date);
    if (m.product_sku) lq = lq.eq('product_sku', m.product_sku);
    const { data: ol } = await lq;
    const olIds = (ol ?? []).map((x: any) => x.id);
    const { data: det } = olIds.length
      ? await supabase.from('lab_birthday_details').select('order_line_id, message, delivery_address').in('order_line_id', olIds)
      : { data: [] as any[] };
    linkCheck.push({
      cakeId: m.id, sku: m.product_sku, order_ref: m.matched_order_ref,
      cake_message: m.message, cake_address: m.delivery_address,
      odoo_lines: olIds.length, details_rows: (det ?? []).length,
      detail_message: (det ?? [])[0]?.message ?? null, detail_address: (det ?? [])[0]?.delivery_address ?? null,
    });
  }

  return NextResponse.json({
    sku,
    bcpd24: { variants: variantsForSku, order_lines: linesForSku, charlotteFiches, charlotteVariants },
    publish: { unpublishedOrders, byDate: Object.values(byDate), totalUpcomingLines: (upLines ?? []).length },
    linkCheck,
  });
}
