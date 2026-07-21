import { createClient } from '@/lib/supabase-server';
import { redirect } from 'next/navigation';
import BirthdayCakesView from './BirthdayCakesView';

export const revalidate = 0;

export default async function BirthdayCakesPage() {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) redirect('/login');
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
  if (!['admin', 'lab_manager', 'assistant'].includes(profile?.role ?? '')) redirect('/dashboard');

  const today = new Date().toISOString().split('T')[0];
  // History window: the tab also shows the last 7 days (read-only), so assistants can
  // look up a delivered cake (message, phone, shop) without leaving the page.
  const since7 = new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0];

  // 1. Which fiches are birthday cakes (by product category on the recipe card).
  // Only ACTIVE ones — a "deleted" fiche is archived (is_active=false) and must not appear in the
  // manual-cake product picker.
  const { data: bcFiches } = await supabase
    .from('lab_fiche_meta').select('id').eq('category', 'Birthday cake').eq('is_active', true);
  const bcFicheIds = (bcFiches ?? []).map(f => f.id);
  // …and their SKUs — so a line still matches even if its fiche_id wasn't set at import
  // (product got its recipe card AFTER the order was imported → line.fiche_id stays null).
  const { data: bcVariants } = bcFicheIds.length
    ? await supabase.from('lab_fiche_variants').select('sku').in('fiche_id', bcFicheIds)
    : { data: [] as any[] };
  const bcSkus = Array.from(new Set((bcVariants ?? []).map((v: any) => v.sku).filter(Boolean)));

  // 2. READ the already-imported order lines (upcoming) — matched by fiche_id OR by SKU.
  const lineCols = 'id, order_ref, product_name_vi, shop_name, delivery_date, delivery_time, qty, product_sku, source_type';
  const [byFicheRes, bySkuRes] = await Promise.all([
    bcFicheIds.length
      ? supabase.from('lab_order_lines').select(lineCols).in('fiche_id', bcFicheIds).gte('delivery_date', since7)
      : Promise.resolve({ data: [] as any[] }),
    bcSkus.length
      ? supabase.from('lab_order_lines').select(lineCols).in('product_sku', bcSkus).gte('delivery_date', since7)
      : Promise.resolve({ data: [] as any[] }),
  ]);
  const byId = new Map<string, any>();
  for (const l of [...(byFicheRes.data ?? []), ...(bySkuRes.data ?? [])]) byId.set(l.id, l);
  const lines = Array.from(byId.values())
    .sort((a, b) => (a.delivery_date + (a.delivery_time ?? '')).localeCompare(b.delivery_date + (b.delivery_time ?? '')));

  // 3. Attach the complementary info (message / ready time / who delivers)
  const lineIds = (lines ?? []).map(l => l.id);
  const { data: details } = lineIds.length
    ? await supabase.from('lab_birthday_details')
        .select('order_line_id, message, ready_time, delivered_by, delivery_address').in('order_line_id', lineIds)
    : { data: [] as any[] };
  const byLine: Record<string, any> = {};
  for (const d of details ?? []) byLine[d.order_line_id] = d;

  // Fallback source: a manual cake that was LINKED to an Odoo order keeps its own info
  // (message / address / ready time). If the copy onto the order line's details is missing
  // or empty (e.g. linked before copy-on-link existed), read it back from the manual cake so
  // the manager never "loses" what they typed. Keyed by matched_order_ref + sku.
  const { data: matchedManual } = await supabase.from('lab_manual_cakes')
    .select('matched_order_ref, product_sku, message, ready_time, delivered_by, delivery_address')
    .not('matched_order_ref', 'is', null).gte('delivery_date', since7);
  const manualByRefSku: Record<string, any> = {};
  for (const m of matchedManual ?? []) manualByRefSku[`${m.matched_order_ref}||${m.product_sku ?? ''}`] = m;
  const pick = (a: string | null | undefined, b: string | null | undefined) =>
    (a && a.trim() !== '') ? a : (b ?? '');

  const odooCakes = (lines ?? []).map(l => {
    const d = byLine[l.id];
    const mc = manualByRefSku[`${l.order_ref}||${l.product_sku ?? ''}`];
    return {
      id: l.id,
      source: 'odoo' as const, manualId: null as string | null, needsOdoo: false,
      suggestedRef: null as string | null, suggestedShop: null as string | null,
      sku: (l.product_sku ?? null) as string | null,
      order_ref: l.order_ref,
      name: l.product_name_vi,
      shop: l.shop_name,
      delivery_date: l.delivery_date,
      delivery_time: l.delivery_time,
      qty: l.qty,
      message: pick(d?.message, mc?.message),
      ready_time: pick(d?.ready_time, mc?.ready_time),
      delivered_by: pick(d?.delivered_by, mc?.delivered_by),
      delivery_address: pick(d?.delivery_address, mc?.delivery_address),
    };
  });

  // Manual cakes created in the app (not yet matched to an Odoo order)
  const { data: manual } = await supabase.from('lab_manual_cakes')
    .select('id, product_name_vi, product_sku, delivery_date, ready_time, delivered_by, delivery_address, message, qty, needs_odoo, rejected_order_refs')
    .is('matched_order_ref', null)
    .gte('delivery_date', since7)
    .order('delivery_date');
  // Phase 2 detection: a manual cake matches an Odoo order when a real order line exists with
  // the same SKU + delivery date. Computed live (human confirms before it's linked).
  const mcSkus = Array.from(new Set((manual ?? []).map((m: any) => m.product_sku).filter(Boolean)));
  const { data: matchLines } = mcSkus.length
    ? await supabase.from('lab_order_lines').select('product_sku, delivery_date, order_ref, shop_name').in('product_sku', mcSkus).gte('delivery_date', since7)
    : { data: [] as any[] };
  const matchBySkuDate: Record<string, { ref: string; shop: string | null }[]> = {};
  for (const l of matchLines ?? []) {
    if (!l.order_ref) continue;
    const k = `${l.product_sku}||${l.delivery_date}`;
    const arr = (matchBySkuDate[k] ??= []);
    if (!arr.find(x => x.ref === l.order_ref)) arr.push({ ref: l.order_ref, shop: l.shop_name ?? null });
  }
  const manualCakes = (manual ?? []).map((m: any) => {
    const rejected = new Set<string>(m.rejected_order_refs ?? []);
    const sug = (matchBySkuDate[`${m.product_sku}||${m.delivery_date}`] ?? []).find(c => !rejected.has(c.ref)) ?? null;
    return {
      id: m.id,
      source: 'manual' as const, manualId: m.id as string | null, needsOdoo: !!m.needs_odoo,
      suggestedRef: (sug?.ref ?? null) as string | null, suggestedShop: (sug?.shop ?? null) as string | null,
      sku: (m.product_sku ?? null) as string | null,
      order_ref: '',
      name: m.product_name_vi,
      shop: m.delivered_by ?? null,
      delivery_date: m.delivery_date,
      delivery_time: null as string | null,
      qty: m.qty,
      message: m.message ?? '',
      ready_time: m.ready_time ?? '',
      delivered_by: m.delivered_by ?? '',
      delivery_address: m.delivery_address ?? '',
    };
  });

  const cakes = [...odooCakes, ...manualCakes];

  // Products available for a new manual cake — ONE entry per variant (not only the default),
  // so any size/flavour of a birthday cake can be chosen.
  const { data: bcFichesFull } = bcFicheIds.length
    ? await supabase.from('lab_fiche_meta').select('id, name_vi, name_en, teams, image_url').in('id', bcFicheIds)
    : { data: [] as any[] };
  const ficheById: Record<string, any> = {};
  for (const f of bcFichesFull ?? []) ficheById[f.id] = f;
  const { data: bcVars } = bcFicheIds.length
    ? await supabase.from('lab_fiche_variants').select('fiche_id, id, sku, label, image_url, is_default, sort_order').in('fiche_id', bcFicheIds).order('is_default', { ascending: false }).order('sort_order')
    : { data: [] as any[] };
  // The readable product name lives on the Odoo order lines (fiche name_vi is often empty).
  const bcSkusAll = Array.from(new Set((bcVars ?? []).map((v: any) => v.sku).filter(Boolean)));
  const { data: nameRows } = bcSkusAll.length
    ? await supabase.from('lab_order_lines').select('product_sku, product_name_vi').in('product_sku', bcSkusAll).limit(3000)
    : { data: [] as any[] };
  const nameBySku: Record<string, string> = {};
  for (const r of nameRows ?? []) if (r.product_sku && r.product_name_vi && !nameBySku[r.product_sku]) nameBySku[r.product_sku] = r.product_name_vi;
  const productChoices = (bcVars ?? []).flatMap((v: any) => {
    const f = ficheById[v.fiche_id];
    if (!f) return [];
    const label = v.label && v.label !== 'Standard' ? v.label : '';
    const orderName = v.sku ? nameBySku[v.sku] : null;
    const nameVi = orderName
      || (f.name_vi ? (label ? `${f.name_vi} · ${label}` : f.name_vi) : (v.sku || (label ? `· ${label}` : '')));
    return [{
      ficheId: f.id, variantId: v.id, sku: v.sku ?? null,
      nameVi,
      nameEn: f.name_en || nameVi,
      imageUrl: v.image_url ?? f.image_url ?? null,
      team: (f.teams ?? [])[0] ?? '',
    }];
  }).sort((a: any, b: any) => a.nameVi.localeCompare(b.nameVi));

  return <BirthdayCakesView cakes={cakes} productChoices={productChoices} today={today} />;
}
