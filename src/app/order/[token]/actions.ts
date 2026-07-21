'use server';
import { createClient as createServiceClient } from '@supabase/supabase-js';

// Public shop order form — server actions.
// No session here: the token in the URL is the access key, checked on EVERY call.
// All DB work uses the service-role key server-side, so the core tables need no anon
// policies. Product data is always re-resolved server-side from the fiche — the client
// only sends ids, never names/SKUs to trust.

const SHOPS = ['La Parisienne', 'Moon Flower', 'Paris'];
const DELIVERERS = ['Lab', 'La Parisienne', 'Moon Flower', 'Paris'];
const TEAMS = ['baby_mama', 'hung', 'entremet', 'baker'];
const MANUAL_MARK = '__manual_cakes__';

function service() {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return null;
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } },
  );
}

async function tokenOk(supabase: NonNullable<ReturnType<typeof service>>, token: string): Promise<boolean> {
  if (!token || token.length < 8) return false;
  const { data } = await supabase.from('lab_shop_link')
    .select('id').eq('token', token).eq('active', true).maybeSingle();
  return !!data;
}

export type ShopProduct = {
  ficheId: string; variantId: string | null; sku: string | null;
  nameVi: string; imageUrl: string | null; isCake: boolean; hasTeam: boolean;
};

export async function searchShopProductsAction(token: string, query: string): Promise<{ products?: ShopProduct[]; error?: string }> {
  const supabase = service();
  if (!supabase) return { error: 'Server not configured' };
  if (!(await tokenOk(supabase, token))) return { error: 'Invalid link' };

  const q = (query ?? '').trim().toLowerCase().slice(0, 60);
  const { data: fiches } = await supabase
    .from('lab_fiche_meta').select('id, name_vi, name_en, teams, image_url, category').eq('is_active', true);
  const ficheById: Record<string, any> = {};
  for (const f of fiches ?? []) ficheById[f.id] = f;
  const ficheIds = (fiches ?? []).map(f => f.id);
  const { data: vars } = ficheIds.length
    ? await supabase.from('lab_fiche_variants')
        .select('fiche_id, id, sku, label, image_url, is_default, sort_order')
        .in('fiche_id', ficheIds).order('is_default', { ascending: false }).order('sort_order')
    : { data: [] as any[] };

  // Readable names often live on the Odoo order lines, not the fiche — same fallback as the app
  const skus = Array.from(new Set((vars ?? []).map((v: any) => v.sku).filter(Boolean)));
  const { data: nameRows } = skus.length
    ? await supabase.from('lab_order_lines').select('product_sku, product_name_vi').in('product_sku', skus).limit(5000)
    : { data: [] as any[] };
  const nameBySku: Record<string, string> = {};
  for (const r of nameRows ?? []) if (r.product_sku && r.product_name_vi && !nameBySku[r.product_sku]) nameBySku[r.product_sku] = r.product_name_vi;

  const all: ShopProduct[] = (vars ?? []).flatMap((v: any) => {
    const f = ficheById[v.fiche_id];
    if (!f) return [];
    const label = v.label && v.label !== 'Standard' ? v.label : '';
    const orderName = v.sku ? nameBySku[v.sku] : null;
    const nameVi = orderName
      || (f.name_vi ? (label ? `${f.name_vi} · ${label}` : f.name_vi) : (v.sku || ''));
    if (!nameVi) return [];
    return [{
      ficheId: f.id as string, variantId: (v.id ?? null) as string | null, sku: (v.sku ?? null) as string | null,
      nameVi, imageUrl: (v.image_url ?? f.image_url ?? null) as string | null,
      isCake: f.category === 'Birthday cake',
      hasTeam: TEAMS.includes((f.teams ?? [])[0] ?? ''),
    }];
  });

  const filtered = (q
    ? all.filter(p => (p.nameVi + ' ' + (p.sku ?? '')).toLowerCase().includes(q))
    : all
  ).sort((a, b) => a.nameVi.localeCompare(b.nameVi)).slice(0, 20);

  return { products: filtered };
}

export type ShopOrderItem = { ficheId: string; variantId: string | null; qty: number; message: string | null };

// One submission = a small cart. Shared info (shop, date, customer…) applies to every
// line; each line becomes its own manual order + production card, so each one later
// matches its own Odoo order line independently.
export async function submitShopOrderAction(token: string, input: {
  shop: string; deliveryDate: string; readyTime: string | null;
  deliveredBy: string | null; deliveryAddress: string | null;
  customerName: string | null; customerPhone: string | null; notes: string | null;
  items: ShopOrderItem[];
}): Promise<{ ok?: boolean; error?: string }> {
  const supabase = service();
  if (!supabase) return { error: 'Server not configured' };
  if (!(await tokenOk(supabase, token))) return { error: 'Invalid link' };

  // ── Validate the shared fields ──
  if (!SHOPS.includes(input.shop)) return { error: 'Invalid shop' };
  const items = Array.isArray(input.items) ? input.items : [];
  if (items.length < 1 || items.length > 20) return { error: 'Invalid item count' };
  const today = new Date().toISOString().split('T')[0];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.deliveryDate ?? '') || input.deliveryDate < today) return { error: 'Invalid delivery date' };
  const deliveredBy = input.deliveredBy && DELIVERERS.includes(input.deliveredBy) ? input.deliveredBy : null;
  const clean = (s: string | null, max: number) => {
    const t = (s ?? '').trim().slice(0, max);
    return t === '' ? null : t;
  };

  // ── Resolve EVERY line server-side first — fail before anything is written ──
  type Resolved = {
    ficheId: string; variantId: string | null; sku: string | null; team: string;
    nameVi: string; nameEn: string; imageUrl: string | null; variantLabel: string;
    qty: number; message: string | null;
  };
  const resolved: Resolved[] = [];
  for (const item of items) {
    const qty = Math.round(Number(item.qty));
    if (!qty || qty < 1 || qty > 500) return { error: 'Invalid quantity' };
    const { data: fiche } = await supabase.from('lab_fiche_meta')
      .select('id, name_vi, name_en, teams, image_url, category').eq('id', item.ficheId).eq('is_active', true).maybeSingle();
    if (!fiche) return { error: 'Product not found' };
    const team = (fiche.teams ?? [])[0] ?? '';
    if (!TEAMS.includes(team)) return { error: `"${fiche.name_vi || 'A product'}" has no production team yet — ask the lab` };
    let variant: any = null;
    if (item.variantId) {
      const { data: v } = await supabase.from('lab_fiche_variants')
        .select('id, sku, label, image_url, fiche_id').eq('id', item.variantId).maybeSingle();
      if (!v || v.fiche_id !== fiche.id) return { error: 'Variant not found' };
      variant = v;
    }
    const sku = variant?.sku ?? null;
    let nameVi = fiche.name_vi ?? '';
    if (sku) {
      const { data: nameRow } = await supabase.from('lab_order_lines')
        .select('product_name_vi').eq('product_sku', sku).not('product_name_vi', 'is', null).limit(1).maybeSingle();
      if (nameRow?.product_name_vi) nameVi = nameRow.product_name_vi;
    }
    if (!nameVi) nameVi = sku ?? 'Sản phẩm';
    resolved.push({
      ficheId: fiche.id, variantId: variant?.id ?? null, sku, team,
      nameVi, nameEn: fiche.name_en ?? '', imageUrl: variant?.image_url ?? fiche.image_url ?? null,
      variantLabel: variant?.label ?? 'Standard', qty,
      message: fiche.category === 'Birthday cake' ? clean(item.message, 200) : null,
    });
  }

  // ── Per-day manual container (same one the assistants' creations use) ──
  let importId: string;
  const { data: existing } = await supabase.from('lab_imports')
    .select('id').eq('delivery_date', input.deliveryDate).eq('type', 'cake_addon').eq('notes', MANUAL_MARK).eq('status', 'published').limit(1).maybeSingle();
  if (existing?.id) importId = existing.id;
  else {
    const { data: maxRow } = await supabase.from('lab_imports').select('order_number').eq('delivery_date', input.deliveryDate).order('order_number', { ascending: false }).limit(1).maybeSingle();
    const { data: imp, error: impErr } = await supabase.from('lab_imports').insert({
      delivery_date: input.deliveryDate, order_number: (maxRow?.order_number ?? 0) + 1,
      type: 'cake_addon', status: 'published', notes: MANUAL_MARK, published_at: new Date().toISOString(),
    }).select('id').single();
    if (impErr || !imp) return { error: 'Could not register the order (container)' };
    importId = imp.id;
  }

  // ── Insert every line; roll back this submission's rows on any failure ──
  const createdAsg: string[] = [];
  for (const r of resolved) {
    const { data: asg, error: asgErr } = await supabase.from('lab_assignments').insert({
      import_id: importId, team: r.team, fiche_id: r.ficheId, variant_id: r.variantId,
      product_name_vi: r.nameVi, product_name_en: r.nameEn, image_url: r.imageUrl,
      variant_label: r.variantLabel, total_qty: r.qty, qty_to_produce: r.qty, qty_produced: 0,
      status: 'pending', sort_order: 9000, breakdown: [],
    }).select('id').single();
    if (asgErr || !asg) {
      if (createdAsg.length) {
        await supabase.from('lab_manual_cakes').delete().in('assignment_id', createdAsg);
        await supabase.from('lab_assignments').delete().in('id', createdAsg);
      }
      return { error: 'Could not create the production card' };
    }
    const { error: mcErr } = await supabase.from('lab_manual_cakes').insert({
      fiche_id: r.ficheId, variant_id: r.variantId, product_sku: r.sku,
      product_name_vi: r.nameVi, product_name_en: r.nameEn, image_url: r.imageUrl,
      team: r.team, qty: r.qty, delivery_date: input.deliveryDate,
      ready_time: clean(input.readyTime, 8), delivered_by: deliveredBy,
      delivery_address: clean(input.deliveryAddress, 300),
      message: r.message,
      customer_name: clean(input.customerName, 120), customer_phone: clean(input.customerPhone, 40),
      notes: clean(input.notes, 500),
      shop_name: input.shop, created_by_name: `${input.shop} (shop)`,
      needs_odoo: true, assignment_id: asg.id, import_id: importId,
    });
    if (mcErr) {
      await supabase.from('lab_assignments').delete().eq('id', asg.id);
      if (createdAsg.length) {
        await supabase.from('lab_manual_cakes').delete().in('assignment_id', createdAsg);
        await supabase.from('lab_assignments').delete().in('id', createdAsg);
      }
      return { error: 'Could not save the order' };
    }
    createdAsg.push(asg.id);
  }

  return { ok: true };
}
