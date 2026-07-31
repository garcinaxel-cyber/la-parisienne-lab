'use server';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { SHOP_ODOO_MAP } from '@/lib/odoo-shop-order-sync';

// Public shop order form — server actions.
// No session here: the token in the URL is the access key, checked on EVERY call.
// All DB work uses the service-role key server-side, so the core tables need no anon
// policies. Product data is always re-resolved server-side from the fiche — the client
// only sends ids, never names/SKUs to trust.
//
// This is the URGENT ORDER interface — for orders arriving outside the normal Odoo-first
// flow (any hour, day or night). Normal shop orders are entered in Odoo and flow down to
// the app via the existing hourly sync; this link exists specifically for when that isn't
// possible in the moment. B2B clients are not yet selectable here — added once Axel gives
// the list (see memory).
const SHOPS = Object.keys(SHOP_ODOO_MAP); // Moon Flower, Lab, La Paris Tây Hồ/Long Biên/Bà Triệu/Timecity
const DELIVERERS = SHOPS; // "Lab livre directement" or one of the shops delivers itself
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

export type ShopOrderItem = {
  ficheId: string; variantId: string | null; qty: number; message: string | null;
  designNotes: string | null; designPhotoUrl: string | null;
};

// One submission = a small cart. Shared info (shop, date, customer…) applies to every
// line; each line becomes its own manual order + production card, so each one later
// matches its own Odoo order line independently.
export async function submitShopOrderAction(token: string, input: {
  shop: string; deliveryDate: string; readyTime: string | null;
  deliveredBy: string | null; deliveryAddress: string | null;
  customerName: string | null; customerPhone: string | null; notes: string | null;
  items: ShopOrderItem[]; clientSubmissionKey: string;
}): Promise<{ ok?: boolean; error?: string }> {
  const supabase = service();
  if (!supabase) return { error: 'Server not configured' };
  if (!(await tokenOk(supabase, token))) return { error: 'Invalid link' };

  // ── Idempotency: double-tap / network-retry protection ──
  // The client generates one key per "compose" session (kept until a successful submit
  // resets the form). First insert wins; a conflict means this exact submission already
  // went through, so we return success without creating a second set of rows.
  if (!input.clientSubmissionKey || !/^[0-9a-f-]{20,40}$/i.test(input.clientSubmissionKey)) {
    return { error: 'Missing submission key' };
  }
  const { error: dedupeErr } = await supabase.from('lab_shop_submission_dedupe')
    .insert({ client_submission_key: input.clientSubmissionKey });
  if (dedupeErr) {
    // Unique violation = genuine duplicate of an already-processed submit -> idempotent success.
    // Any other error (table missing, etc.) should NOT silently swallow a real order.
    if (dedupeErr.code === '23505') return { ok: true };
    return { error: `Submission check failed: ${dedupeErr.message}` };
  }

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

  // ── Required fields depending on delivery mode (2026-07-31 audit, scenario 1) ──
  // Direct lab delivery to the end customer needs contact + address to actually happen;
  // any cake needs a way to reach the customer too (it's a personalised gift).
  const custName = clean(input.customerName, 120);
  const custPhone = clean(input.customerPhone, 40);
  const addr = clean(input.deliveryAddress, 300);
  const ready = clean(input.readyTime, 8);
  if (deliveredBy === 'Lab') {
    if (!custName || !custPhone) return { error: 'Customer name and phone are required for direct lab delivery' };
    if (!addr) return { error: 'Delivery address is required for direct lab delivery' };
    if (!ready) return { error: 'Ready time is required for direct lab delivery' };
  }

  // ── Resolve EVERY line server-side first — fail before anything is written ──
  type Resolved = {
    ficheId: string; variantId: string | null; sku: string | null; team: string;
    nameVi: string; nameEn: string; imageUrl: string | null; variantLabel: string;
    qty: number; message: string | null; isCake: boolean;
    designNotes: string | null; designPhotoUrl: string | null;
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
    const isCake = fiche.category === 'Birthday cake';
    // Design photo must be one we generated via uploadDesignPhotoAction (our own storage
    // bucket) — never trust an arbitrary URL pasted by the client.
    const photoUrl = item.designPhotoUrl && item.designPhotoUrl.includes('/lab-design-photos/') ? item.designPhotoUrl : null;
    resolved.push({
      ficheId: fiche.id, variantId: variant?.id ?? null, sku, team,
      nameVi, nameEn: fiche.name_en ?? '', imageUrl: variant?.image_url ?? fiche.image_url ?? null,
      variantLabel: variant?.label ?? 'Standard', qty, isCake,
      message: isCake ? clean(item.message, 200) : null,
      designNotes: isCake ? clean(item.designNotes, 400) : null,
      designPhotoUrl: isCake ? photoUrl : null,
    });
  }

  // ── Required fields depending on delivery mode / product (scenario 1) ──
  // Any cake needs a way to reach the customer — it's a personalised gift, and someone
  // has to be reachable if there's a problem with the design or the writing.
  if (resolved.some(r => r.isCake) && !(custName && custPhone)) {
    return { error: 'Customer name and phone are required for a birthday cake order' };
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

  // ── One batch id shared by every line of THIS submission — lets the Odoo sync queue
  //    group them into a single document (one order = one sale.order/replenishment, not
  //    one per product line) ──
  const orderBatchId = crypto.randomUUID();

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
      message: r.message, design_notes: r.designNotes, design_photo_url: r.designPhotoUrl,
      customer_name: clean(input.customerName, 120), customer_phone: clean(input.customerPhone, 40),
      notes: clean(input.notes, 500),
      shop_name: input.shop, created_by_name: `${input.shop} (shop)`,
      needs_odoo: true, assignment_id: asg.id, import_id: importId,
      order_batch_id: orderBatchId,
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

  // The Odoo document is NOT created automatically anymore (the auto-queue caused
  // duplicate creations — see git history for lab_odoo_sync_queue). The chef's production
  // card above is unaffected either way. An admin now creates the matching Odoo document
  // manually from /exceptional-orders, optionally grouping several exceptional orders
  // (e.g. multiple same-day Moon Flower cakes) into a single quotation/replenishment.

  return { ok: true };
}

// Upload a cake design reference photo (scenario 3 of the 2026-07-31 audit). Called as soon
// as the shop attaches a file, before the final submit — the resulting public URL is then
// passed as `designPhotoUrl` on the relevant item. Validated server-side (type/size) even
// though the input is a plain <input type="file"> with no client-side enforcement.
export async function uploadDesignPhotoAction(token: string, formData: FormData): Promise<{ url?: string; error?: string }> {
  const supabase = service();
  if (!supabase) return { error: 'Server not configured' };
  if (!(await tokenOk(supabase, token))) return { error: 'Invalid link' };

  const file = formData.get('file');
  if (!(file instanceof File)) return { error: 'No file' };
  if (!file.type.startsWith('image/')) return { error: 'Only images are allowed' };
  if (file.size > 5 * 1024 * 1024) return { error: 'Image too large — max 5MB' };

  const ext = (file.type.split('/')[1] || 'jpg').replace(/[^a-z0-9]/gi, '').slice(0, 5) || 'jpg';
  const path = `${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}.${ext}`;
  const buf = Buffer.from(await file.arrayBuffer());
  const { error: upErr } = await supabase.storage.from('lab-design-photos')
    .upload(path, buf, { contentType: file.type, upsert: false });
  if (upErr) return { error: upErr.message };

  const { data } = supabase.storage.from('lab-design-photos').getPublicUrl(path);
  return { url: data.publicUrl };
}

// Shop order tracking (scenario 5/6 follow-up, 2026-07-31 audit) — self-service status view
// on the same token-gated link, no account needed. The shop re-picks itself (same selector
// used to order) and sees its own recent birthday-cake orders with a plain status.
export type ShopOrderStatus = {
  id: string; name: string; qty: number; deliveryDate: string;
  status: 'pending' | 'confirmed' | 'cancelled';
  matchedRef: string | null; cancelReason: string | null; createdAt: string;
};

export async function getShopOrdersAction(token: string, shop: string): Promise<{ orders?: ShopOrderStatus[]; error?: string }> {
  const supabase = service();
  if (!supabase) return { error: 'Server not configured' };
  if (!(await tokenOk(supabase, token))) return { error: 'Invalid link' };
  if (!SHOPS.includes(shop)) return { error: 'Invalid shop' };

  const since = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const { data, error } = await supabase.from('lab_manual_cakes')
    .select('id, product_name_vi, qty, delivery_date, matched_order_ref, cancelled_at, cancel_reason, created_at')
    .eq('shop_name', shop).gte('delivery_date', since)
    .order('delivery_date', { ascending: false }).order('created_at', { ascending: false }).limit(50);
  if (error) return { error: error.message };

  const orders: ShopOrderStatus[] = (data ?? []).map((o: any) => {
    const realRef = o.matched_order_ref && o.matched_order_ref !== '__pending_create__' ? o.matched_order_ref : null;
    return {
      id: o.id, name: o.product_name_vi, qty: o.qty, deliveryDate: o.delivery_date,
      status: o.cancelled_at ? 'cancelled' : realRef ? 'confirmed' : 'pending',
      matchedRef: realRef, cancelReason: o.cancel_reason ?? null, createdAt: o.created_at,
    };
  });
  return { orders };
}
