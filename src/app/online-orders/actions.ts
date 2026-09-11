'use server';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { createClient, getSafeSession } from '@/lib/supabase-server';
import { SHOP_ODOO_MAP, createOdooOrderForSelection } from '@/lib/odoo-shop-order-sync';
import { ONLINE_PUSH_KEY } from '@/lib/online-sales';
import { sendShopPush, sendAdminPush, awaitPush, type PushPayload } from '@/lib/push-notify';
import { revalidatePath } from 'next/cache';

// Online-sales interface (Axel, 2026-09-06) — her own space, replacing her personal Google
// Sheet. She keeps ordering through the existing manual/exceptional-order mechanism
// (lab_manual_cakes + createOdooOrderForSelection, same pipeline the shop token flow and
// /exceptional-orders already use) but gets 3 screens scoped to what she created: Commande
// (order creation, synchronous Odoo document), Suivi (tracking, 2 delivery signals + payment),
// Analytic (revenue by day/month/shop/category). Admin sees everything, she sees only her own.
//
// "Canal" (Facebook page / traffic source — Hoàn Kiếm, Moon Flower, Website, Page Merci, ...)
// is deliberately free text and SEPARATE from "shop" (who fulfills — drives the Odoo document
// via the existing SHOP_CONFIG/SHOP_ODOO_MAP). Axel, 2026-09-06: "ces canaux ce sont pas
// forcement des ventes du lab ... distingue le shop qui prend la vente et le canal."

const SHOPS = Object.keys(SHOP_ODOO_MAP);
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

// shop_manager (2026-09-10) — Axel: "accès en lecture (Analytic + Suivi)" — a manager's own
// login sees everything an admin sees here (both getMyOnlineOrdersAction and
// getOnlineAnalyticsAction already return every seller's data, not just the caller's own), but
// may never place, edit, cancel or otherwise write an order. requireOnlineWriteSession below is
// the same check plus that extra guard, used by every mutating action in this file; the plain
// read actions (list/analytics/channels/fees) keep using requireOnlineSession directly.
async function requireOnlineSession(): Promise<{ userId: string; fullName: string; isAdmin: boolean; role: 'admin' | 'online_sales' | 'shop_manager' } | { error: string }> {
  const supabase = createClient();
  const { data: { session } } = await getSafeSession(supabase);
  if (!session) return { error: 'Not authenticated' };
  const { data: profile } = await supabase.from('profiles').select('role, full_name').eq('id', session.user.id).single();
  if (!profile || !['online_sales', 'admin', 'shop_manager'].includes(profile.role)) return { error: 'Not authorized' };
  return { userId: session.user.id, fullName: profile.full_name ?? '', isAdmin: profile.role === 'admin', role: profile.role as 'admin' | 'online_sales' | 'shop_manager' };
}

async function requireOnlineWriteSession(): Promise<{ userId: string; fullName: string; isAdmin: boolean; role: 'admin' | 'online_sales' | 'shop_manager' } | { error: string }> {
  const auth = await requireOnlineSession();
  if ('error' in auth) return auth;
  if (auth.role === 'shop_manager') return { error: 'Read-only access' };
  return auth;
}

const clean = (s: string | null | undefined, max: number) => {
  const t = (s ?? '').trim().slice(0, max);
  return t === '' ? null : t;
};

// New-vs-returning customer detection (Axel, 2026-09-11): "qui recommande" — a repeat customer,
// keyed on phone number, replacing the old Excel's hand-filled "Khách mới/Khách cũ" column.
// Phone numbers are entered free-text ("097 8421293", "Sđt 0334992879", ...), so comparison is
// digits-only on the last 9 (a VN mobile number minus any leading 0/country code) rather than
// an exact string match.
function normalizePhoneKey(raw: string | null | undefined): string | null {
  const digits = (raw ?? '').replace(/\D/g, '');
  if (digits.length < 8) return null; // too short to be a real phone — never matches
  return digits.slice(-9);
}

// ── Product search (session-gated twin of order/[token]/actions.ts's searchShopProductsAction) ──
export type OnlineProduct = {
  ficheId: string; variantId: string | null; sku: string | null;
  nameVi: string; imageUrl: string | null; isCake: boolean; hasTeam: boolean;
  // Official selling price (product_variants.price_b2c — the same price the B2B/Odoo push and
  // the shop stock valuation use). Prefilled in the cart, still editable per order.
  price: number | null;
};

export async function searchOnlineProductsAction(query: string): Promise<{ products?: OnlineProduct[]; error?: string }> {
  const auth = await requireOnlineSession();
  if ('error' in auth) return { error: auth.error };
  const supabase = service();
  if (!supabase) return { error: 'Server not configured' };

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

  const skus = Array.from(new Set((vars ?? []).map((v: any) => v.sku).filter(Boolean)));
  const { data: nameRows } = skus.length
    ? await supabase.from('lab_order_lines').select('product_sku, product_name_vi').in('product_sku', skus).limit(5000)
    : { data: [] as any[] };
  const nameBySku: Record<string, string> = {};
  for (const r of nameRows ?? []) if (r.product_sku && r.product_name_vi && !nameBySku[r.product_sku]) nameBySku[r.product_sku] = r.product_name_vi;
  const { data: priceRows } = skus.length
    ? await supabase.from('product_variants').select('sku, price_b2c').in('sku', skus)
    : { data: [] as any[] };
  const priceBySku: Record<string, number> = {};
  for (const r of priceRows ?? []) if (r.sku && Number(r.price_b2c) > 0) priceBySku[r.sku] = Number(r.price_b2c);

  const all: OnlineProduct[] = (vars ?? []).flatMap((v: any) => {
    const f = ficheById[v.fiche_id];
    if (!f) return [];
    const label = v.label && v.label !== 'Standard' ? v.label : '';
    const orderName = v.sku ? nameBySku[v.sku] : null;
    const nameVi = orderName || (f.name_vi ? (label ? `${f.name_vi} · ${label}` : f.name_vi) : (v.sku || ''));
    if (!nameVi) return [];
    return [{
      ficheId: f.id as string, variantId: (v.id ?? null) as string | null, sku: (v.sku ?? null) as string | null,
      nameVi, imageUrl: (v.image_url ?? f.image_url ?? null) as string | null,
      isCake: f.category === 'Birthday cake',
      hasTeam: TEAMS.includes((f.teams ?? [])[0] ?? ''),
      price: v.sku ? (priceBySku[v.sku] ?? null) : null,
    }];
  });

  const filtered = (q
    ? all.filter(p => (p.nameVi + ' ' + (p.sku ?? '')).toLowerCase().includes(q))
    : all
  ).sort((a, b) => a.nameVi.localeCompare(b.nameVi)).slice(0, 20);

  return { products: filtered };
}

// Design reference photo — same storage bucket as the public shop-order flow, just
// session-gated instead of token-gated.
export async function uploadOnlineDesignPhotoAction(formData: FormData): Promise<{ url?: string; error?: string }> {
  const auth = await requireOnlineWriteSession();
  if ('error' in auth) return { error: auth.error };
  const supabase = service();
  if (!supabase) return { error: 'Server not configured' };
  const file = formData.get('file');
  if (!(file instanceof File)) return { error: 'No file' };
  if (!file.type.startsWith('image/')) return { error: 'Only images are allowed' };
  if (file.size > 5 * 1024 * 1024) return { error: 'Image too large — max 5MB' };
  const ext = (file.type.split('/')[1] || 'jpg').replace(/[^a-z0-9]/gi, '').slice(0, 5) || 'jpg';
  const path = `${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}.${ext}`;
  const buf = Buffer.from(await file.arrayBuffer());
  const { error: upErr } = await supabase.storage.from('lab-design-photos').upload(path, buf, { contentType: file.type, upsert: false });
  if (upErr) return { error: upErr.message };
  const { data } = supabase.storage.from('lab-design-photos').getPublicUrl(path);
  return { url: data.publicUrl };
}

export type OnlineOrderItem = {
  ficheId: string; variantId: string | null; qty: number; unitPrice: number;
  message: string | null; designNotes: string | null; designPhotoUrl: string | null;
  // Free per-line note (any product, Axel review 2026-09-06) — lands in lab_manual_cakes.notes
  // of that line, shown on /exceptional-orders and the chef card like any other note.
  lineNote?: string | null;
};

// Extra fee (nến sinh nhật, nón sinh nhật...) added on top of the cart — never a catalogue
// product, so it never touches lab_fiche_meta/production/Odoo (Axel, 2026-09-07: "ca prend
// uniquement en compte le produit"). Lands as a plain lab_online_sale_lines row regardless of
// whether the order itself is 'lab' or 'shop_stock' — see buildFeeLineRows below.
export type ExtraFeeLineInput = { emoji?: string | null; label: string; qty: number; unitPrice: number };

function buildFeeLineRows(fees: ExtraFeeLineInput[] | undefined): { fiche_id: null; variant_id: null; sku: null; product_name_vi: string; category: string; qty: number; unit_price: number; line_note: null; is_fee: true }[] {
  return (fees ?? [])
    .map(f => ({ label: clean(f.label, 60), emoji: clean(f.emoji ?? '', 4) || null, qty: Math.round(Number(f.qty)), unitPrice: Math.max(0, Number(f.unitPrice) || 0) }))
    .filter(f => f.label && f.qty > 0)
    .map(f => ({
      fiche_id: null, variant_id: null, sku: null,
      product_name_vi: (f.emoji ? `${f.emoji} ${f.label}` : f.label) as string, category: 'Khác',
      qty: f.qty, unit_price: f.unitPrice, line_note: null, is_fee: true as const,
    }));
}

// One submission = one order = one order_batch_id = one Odoo document, created SYNCHRONOUSLY
// (Axel, 2026-09-06: "une fois validé ça crée la commande odoo"), unlike the shop token flow
// (which defers Odoo creation to an admin batching several exceptional orders together). If the
// Odoo call itself fails, the local rows are NOT rolled back — they still produce a normal
// production card and show up as a regular pending "exceptional order" an admin can create the
// Odoo document for by hand later (existing /exceptional-orders flow) — never silently lost.
export async function submitOnlineOrderAction(input: {
  shop: string; channel: string; deliveryDate: string; readyTime: string | null;
  customerName: string | null; customerPhone: string | null; deliveryAddress: string | null; notes: string | null;
  deliveryFee: number; paymentStatus: 'paid' | 'unpaid' | 'partial'; amountPaid: number;
  // Who delivers to the end customer — 'shop' (lab -> shop -> customer, existing flow) or
  // 'direct' (lab delivers straight to the customer's address, bypassing the shop). Axel,
  // 2026-09-09 — replaces inferring this from whether deliveryAddress is filled.
  deliveryMode?: 'shop' | 'direct';
  items: OnlineOrderItem[]; fees?: ExtraFeeLineInput[];
}): Promise<{ ok?: boolean; orderRef?: string | null; warning?: string; error?: string }> {
  const auth = await requireOnlineWriteSession();
  if ('error' in auth) return { error: auth.error };
  const supabase = service();
  if (!supabase) return { error: 'Server not configured' };

  if (!SHOPS.includes(input.shop)) return { error: 'Invalid shop' };
  // Axel review 2026-09-06: online orders are always fulfilled by a shop, never by the Lab itself.
  if (input.shop === 'Lab') return { error: 'Lab cannot handle online orders' };
  const channel = clean(input.channel, 60);
  if (!channel) return { error: 'Missing channel' };
  const items = Array.isArray(input.items) ? input.items : [];
  if (items.length < 1 || items.length > 20) return { error: 'Invalid item count' };
  const today = new Date().toISOString().split('T')[0];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.deliveryDate ?? '') || input.deliveryDate < today) return { error: 'Invalid delivery date' };
  if (!['paid', 'unpaid', 'partial'].includes(input.paymentStatus)) return { error: 'Invalid payment status' };
  const deliveryMode: 'shop' | 'direct' = input.deliveryMode === 'direct' ? 'direct' : 'shop';

  type Resolved = {
    ficheId: string; variantId: string | null; sku: string | null; team: string;
    nameVi: string; nameEn: string; imageUrl: string | null; variantLabel: string;
    qty: number; unitPrice: number; message: string | null; isCake: boolean;
    designNotes: string | null; designPhotoUrl: string | null; lineNote: string | null;
  };
  const resolved: Resolved[] = [];
  for (const item of items) {
    const qty = Math.round(Number(item.qty));
    if (!qty || qty < 1 || qty > 500) return { error: 'Invalid quantity' };
    const unitPrice = Math.max(0, Number(item.unitPrice) || 0);
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
    const photoUrl = item.designPhotoUrl && item.designPhotoUrl.includes('/lab-design-photos/') ? item.designPhotoUrl : null;
    resolved.push({
      ficheId: fiche.id, variantId: variant?.id ?? null, sku, team,
      nameVi, nameEn: fiche.name_en ?? '', imageUrl: variant?.image_url ?? fiche.image_url ?? null,
      variantLabel: variant?.label ?? 'Standard', qty, unitPrice, isCake,
      message: isCake ? clean(item.message, 200) : null,
      designNotes: isCake ? clean(item.designNotes, 400) : null,
      designPhotoUrl: isCake ? photoUrl : null,
      lineNote: clean(item.lineNote, 300),
    });
  }

  // ── Per-day manual container (same one every manual-cake creation path reuses) ──
  let importId: string;
  const { data: existing } = await supabase.from('lab_imports')
    .select('id').eq('delivery_date', input.deliveryDate).eq('type', 'cake_addon').eq('notes', MANUAL_MARK).eq('status', 'published').limit(1).maybeSingle();
  if (existing?.id) importId = existing.id;
  else {
    const { data: maxRow } = await supabase.from('lab_imports').select('order_number').eq('delivery_date', input.deliveryDate).order('order_number', { ascending: false }).limit(1).maybeSingle();
    const { data: imp, error: impErr } = await supabase.from('lab_imports').insert({
      delivery_date: input.deliveryDate, order_number: (maxRow?.order_number ?? 0) + 1,
      type: 'cake_addon', status: 'published', notes: MANUAL_MARK, published_at: new Date().toISOString(),
      published_by: auth.userId,
    }).select('id').single();
    if (impErr || !imp) return { error: 'Could not register the order (container)' };
    importId = imp.id;
  }

  const orderBatchId = crypto.randomUUID();
  const customerName = clean(input.customerName, 120);
  const customerPhone = clean(input.customerPhone, 40);
  const deliveryAddress = clean(input.deliveryAddress, 300);
  const readyTime = clean(input.readyTime, 8);
  const notes = clean(input.notes, 500);

  const createdAsg: string[] = [];
  const createdCakeIds: string[] = [];
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
    const { data: mc, error: mcErr } = await supabase.from('lab_manual_cakes').insert({
      fiche_id: r.ficheId, variant_id: r.variantId, product_sku: r.sku,
      product_name_vi: r.nameVi, product_name_en: r.nameEn, image_url: r.imageUrl,
      team: r.team, qty: r.qty, unit_price: r.unitPrice, delivery_date: input.deliveryDate,
      ready_time: readyTime, delivered_by: input.shop, delivery_address: deliveryAddress,
      message: r.message, design_notes: r.designNotes, design_photo_url: r.designPhotoUrl,
      customer_name: customerName, customer_phone: customerPhone,
      notes: [r.lineNote, notes].filter(Boolean).join(' · ') || null,
      shop_name: input.shop, channel, created_by: auth.userId, created_by_name: `${auth.fullName} (online)`,
      needs_odoo: true, assignment_id: asg.id, import_id: importId, order_batch_id: orderBatchId,
    }).select('id').single();
    if (mcErr || !mc) {
      await supabase.from('lab_assignments').delete().eq('id', asg.id);
      if (createdAsg.length) {
        await supabase.from('lab_manual_cakes').delete().in('assignment_id', createdAsg);
        await supabase.from('lab_assignments').delete().in('id', createdAsg);
      }
      return { error: 'Could not save the order' };
    }
    createdAsg.push(asg.id);
    createdCakeIds.push(mc.id);
  }

  // ── Synchronous Odoo document creation, tagged "Online order" ──
  // Axel, 2026-09-06 (review): online orders only ever originate from the app, so the "online"
  // marking lives in the app (channel + created_by_name '(online)', ONLINE badge on
  // /exceptional-orders) — nothing is written into Odoo's note fields on purpose.
  const odooResult = await createOdooOrderForSelection(supabase, createdCakeIds);

  // ── Order-level fields (money, payment, who) ──
  const { error: ooErr } = await supabase.from('lab_online_orders').insert({
    order_batch_id: orderBatchId,
    source: 'lab',
    shop_name: input.shop, channel, delivery_date: input.deliveryDate,
    customer_name: customerName, customer_phone: customerPhone, delivery_address: deliveryAddress, notes,
    delivery_fee: Math.max(0, Number(input.deliveryFee) || 0),
    payment_status: input.paymentStatus,
    amount_paid: Math.max(0, Number(input.amountPaid) || 0),
    delivery_mode: deliveryMode,
    created_by: auth.userId,
  });
  if (ooErr) {
    revalidatePath('/online-orders');
    return { ok: true, orderRef: odooResult.order_ref ?? null, warning: `Đơn đã lưu nhưng lỗi ghi thông tin thanh toán: ${ooErr.message}` };
  }

  // Extra fees (nến, nón...): never touch Odoo/production — a plain revenue line alongside the
  // real order. Failure here is non-fatal (the order itself already succeeded).
  const feeRows = buildFeeLineRows(input.fees);
  let feeWarning: string | null = null;
  if (feeRows.length) {
    const { error: feeErr } = await supabase.from('lab_online_sale_lines').insert(feeRows.map(r => ({ ...r, order_batch_id: orderBatchId })));
    if (feeErr) feeWarning = `Đơn đã lưu nhưng lỗi ghi phụ phí: ${feeErr.message}`;
  }

  revalidatePath('/online-orders');
  if (!odooResult.ok) {
    return { ok: true, orderRef: null, warning: feeWarning ?? `Đơn đã lưu, sản xuất đã lên lịch, nhưng tạo đơn Odoo thất bại (${odooResult.error}) — admin sẽ tạo thủ công.` };
  }
  return { ok: true, orderRef: odooResult.order_ref ?? null, warning: feeWarning ?? undefined };
}


// ── Sale served from SHOP STOCK (Axel, 2026-09-07) ──
// The product is already on the shop's shelf (delivered by that morning's REP): the online
// seller records the sale for her own tracking/analytics and the shop hands it over. HARD RULE
// (Axel: "aucun impact odoo ou production"): this path touches ONLY lab_online_orders +
// lab_online_sale_lines. It never writes lab_manual_cakes / lab_assignments / lab_imports and
// never imports anything from the Odoo modules — so no chef card, nothing on
// /exceptional-orders, no Odoo document, no sync. The shop still rings the sale in its POS;
// revenue analysis stays on Odoo SOs — this is an attribution view only.
export type ShopStockSaleItem = {
  ficheId: string; variantId: string | null; qty: number; unitPrice: number; lineNote?: string | null;
};
export async function submitShopStockSaleAction(input: {
  shop: string; channel: string; saleDate: string;
  customerName: string | null; customerPhone: string | null; deliveryAddress: string | null; notes: string | null;
  deliveryFee: number; paymentStatus: 'paid' | 'unpaid' | 'partial'; amountPaid: number;
  items: ShopStockSaleItem[]; fees?: ExtraFeeLineInput[];
}): Promise<{ ok?: boolean; orderBatchId?: string; warning?: string; error?: string }> {
  const auth = await requireOnlineWriteSession();
  if ('error' in auth) return { error: auth.error };
  const supabase = service();
  if (!supabase) return { error: 'Server not configured' };

  if (!SHOPS.includes(input.shop) || input.shop === 'Lab') return { error: 'Invalid shop' };
  const channel = clean(input.channel, 60);
  if (!channel) return { error: 'Missing channel' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.saleDate ?? '')) return { error: 'Invalid date' };
  const items = Array.isArray(input.items) ? input.items.slice(0, 50) : [];
  if (!items.length) return { error: 'Empty cart' };
  if (!['paid', 'unpaid', 'partial'].includes(input.paymentStatus)) return { error: 'Invalid payment status' };

  // Resolve names/categories server-side from the catalogue (never trust the client's labels).
  const ficheIds = Array.from(new Set(items.map(i => i.ficheId).filter(Boolean)));
  const { data: fiches } = await supabase.from('lab_fiche_meta').select('id, name_vi, category').in('id', ficheIds).eq('is_active', true);
  const ficheById = new Map<string, any>();
  for (const f of fiches ?? []) ficheById.set(f.id, f);
  const variantIds = Array.from(new Set(items.map(i => i.variantId).filter((v): v is string => !!v)));
  const { data: variants } = variantIds.length ? await supabase.from('lab_fiche_variants').select('id, fiche_id, sku, label').in('id', variantIds) : { data: [] as any[] };
  const variantById = new Map<string, any>();
  for (const v of variants ?? []) variantById.set(v.id, v);

  const rows: any[] = [];
  for (const it of items) {
    const f = ficheById.get(it.ficheId);
    if (!f) return { error: 'Product not found' };
    const qty = Math.round(Number(it.qty));
    if (!qty || qty < 1 || qty > 500) return { error: 'Invalid quantity' };
    const v = it.variantId ? variantById.get(it.variantId) : null;
    if (it.variantId && (!v || v.fiche_id !== f.id)) return { error: 'Product variant not found' };
    const label = v?.label && v.label !== 'Standard' ? ` · ${v.label}` : '';
    rows.push({
      fiche_id: f.id, variant_id: v?.id ?? null, sku: v?.sku ?? null,
      product_name_vi: `${f.name_vi ?? v?.sku ?? 'Sản phẩm'}${label}`, category: f.category ?? null,
      qty, unit_price: Math.max(0, Number(it.unitPrice) || 0), line_note: clean(it.lineNote, 300),
      // Explicit false, not omitted: a single insert() call mixing this row shape with
      // buildFeeLineRows' is_fee:true rows makes PostgREST fill any row missing the key with a
      // literal NULL instead of the column default, which trips the NOT NULL constraint.
      is_fee: false,
    });
  }

  const orderBatchId = crypto.randomUUID();
  const customerName = clean(input.customerName, 80);
  const customerPhone = clean(input.customerPhone, 30);
  const { error: ooErr } = await supabase.from('lab_online_orders').insert({
    order_batch_id: orderBatchId,
    source: 'shop_stock',
    shop_name: input.shop, channel, delivery_date: input.saleDate,
    customer_name: customerName, customer_phone: customerPhone,
    delivery_address: clean(input.deliveryAddress, 300), notes: clean(input.notes, 500),
    delivery_fee: Math.max(0, Number(input.deliveryFee) || 0),
    payment_status: input.paymentStatus,
    amount_paid: Math.max(0, Number(input.amountPaid) || 0),
    created_by: auth.userId,
  });
  if (ooErr) return { error: ooErr.message };
  const allRows = [...rows, ...buildFeeLineRows(input.fees)];
  const { error: lErr } = await supabase.from('lab_online_sale_lines').insert(allRows.map(r => ({ ...r, order_batch_id: orderBatchId })));
  if (lErr) {
    await supabase.from('lab_online_orders').delete().eq('order_batch_id', orderBatchId);
    return { error: lErr.message };
  }

  // Tell the shop it has something to hand over from its own shelf (+ admin copy).
  const summary = rows.slice(0, 3).map(r => r.qty > 1 ? `${r.product_name_vi} ×${r.qty}` : r.product_name_vi).join(', ') + (rows.length > 3 ? ` +${rows.length - 3}` : '');
  const who = [customerName, customerPhone].filter(Boolean).join(' ');
  const viPayload: PushPayload = { title: `🛍 Online bán từ kho ${input.shop}`, body: `${summary}${who ? ` — ${who}` : ''} (${channel})` };
  const enPayload: PushPayload = { title: `🛍 Online sale from ${input.shop} stock`, body: `${summary}${who ? ` — ${who}` : ''} (${channel})` };
  await awaitPush(Promise.all([sendShopPush(supabase, input.shop, viPayload), sendAdminPush(supabase, viPayload, enPayload)]));

  revalidatePath('/online-orders');
  return { ok: true, orderBatchId };
}

// ── Suivi (tracking) ──
export type OnlineOrderSummary = {
  orderBatchId: string; shopName: string; channel: string | null; orderRef: string | null;
  // 'excel_import': historical row backfilled from the seller's old Excel tracker (Axel,
  // 2026-09-08) -- revenue-only, never touches lab_manual_cakes/Odoo. Kept as its own source
  // value (not folded into 'shop_stock') specifically so it stays visually distinguishable from
  // anything entered live in the app, per Axel's request.
  source: 'lab' | 'shop_stock' | 'excel_import';
  paymentProofUrl: string | null;
  createdAt: string; deliveryDate: string;
  customerName: string | null; customerPhone: string | null;
  items: { nameVi: string; qty: number; unitPrice: number | null; sku: string | null }[];
  total: number; deliveryFee: number; paymentStatus: 'paid' | 'unpaid' | 'partial'; amountPaid: number;
  labDelivered: boolean; shopDelivered: boolean; cancelled: boolean;
  // New-vs-returning (Axel, 2026-09-11): isReturningCustomer is the final answer (auto OR manual
  // override); returningManual marks that a human confirmed it (the auto phone-match can't see
  // pre-app history); priorOrderCount is however many earlier orders that phone number has, for
  // context even when a manual override is set.
  isReturningCustomer: boolean; returningManual: boolean; priorOrderCount: number;
};

export async function getMyOnlineOrdersAction(opts?: { deliveryDate?: string }): Promise<{ orders?: OnlineOrderSummary[]; error?: string }> {
  const auth = await requireOnlineSession();
  if ('error' in auth) return { error: auth.error };
  const supabase = service();
  if (!supabase) return { error: 'Server not configured' };

  // Default (no deliveryDate): unchanged behaviour — most recent 200 by created_at, exactly as
  // before. When a specific day is picked (calendar jump, Axel 2026-09-08 — growing history made
  // the single created_at-ordered list impractical to scroll through), fetch that day only, no cap.
  let oq = supabase.from('lab_online_orders').select('*');
  if (opts?.deliveryDate) {
    oq = oq.eq('delivery_date', opts.deliveryDate).order('created_at', { ascending: false });
  } else {
    oq = oq.order('created_at', { ascending: false }).limit(200);
  }
  // Axel, 2026-09-08: "elle doit pouvoir voir toute la page au complet" -- the online-sales role
  // is shared across whoever takes orders (plus historical excel imports created under Axel's own
  // account), so it must see every order here, not just the ones it personally created. The
  // created_by scoping stays for editing/cancelling (assertOwnsOrder below) -- this is read-only.
  void auth.isAdmin;
  const { data: orders } = await oq;
  if (!orders?.length) return { orders: [] };

  const labBatchIds = orders.filter((o: any) => (o.source ?? 'lab') === 'lab').map((o: any) => o.order_batch_id);
  const allBatchIds = orders.map((o: any) => o.order_batch_id);
  // sale_lines queried for every order (not just shop_stock) — a 'lab' order's extra-fee lines
  // (never in lab_manual_cakes, see buildFeeLineRows) only live here.
  const [{ data: lines }, { data: stockLines }] = await Promise.all([
    labBatchIds.length
      ? supabase.from('lab_manual_cakes')
          .select('order_batch_id, product_name_vi, qty, unit_price, shop_name, channel, delivery_date, customer_name, customer_phone, matched_order_ref, cancelled_at, created_at')
          .in('order_batch_id', labBatchIds)
      : Promise.resolve({ data: [] as any[] }),
    allBatchIds.length
      ? supabase.from('lab_online_sale_lines').select('order_batch_id, product_name_vi, qty, unit_price, sku').in('order_batch_id', allBatchIds)
      : Promise.resolve({ data: [] as any[] }),
  ]);

  const linesByBatch = new Map<string, any[]>();
  // Tag origin so "cancelled" below only judges the real production lines (lab_manual_cakes) —
  // a fee line from lab_online_sale_lines has no cancelled_at at all and must not count against it.
  for (const l of [...(lines ?? []).map((l: any) => ({ ...l, _mc: true })), ...(stockLines ?? []).map((l: any) => ({ ...l, _mc: false }))]) {
    const arr = linesByBatch.get(l.order_batch_id) ?? [];
    arr.push(l); linesByBatch.set(l.order_batch_id, arr);
  }

  const orderRefs = Array.from(new Set((lines ?? [])
    .map((l: any) => l.matched_order_ref)
    .filter((r: string | null): r is string => !!r && r !== '__pending_create__')));
  const { data: deliveries } = orderRefs.length
    ? await supabase.from('lab_delivery_orders').select('order_ref, status').in('order_ref', orderRefs).eq('status', 'validated')
    : { data: [] as any[] };
  const labDeliveredRefs = new Set((deliveries ?? []).map((d: any) => d.order_ref));

  // New-vs-returning: the whole table (order_batch_id, phone, created_at) — cheap, ~150 rows —
  // so a customer's first order can be found even when it falls outside today's/this-page's
  // window. See normalizePhoneKey above for why this isn't a raw string match.
  const { data: allForPhones } = await supabase.from('lab_online_orders').select('order_batch_id, customer_phone, created_at');
  const byPhoneKey = new Map<string, { order_batch_id: string; created_at: string }[]>();
  for (const r of allForPhones ?? []) {
    const key = normalizePhoneKey(r.customer_phone);
    if (!key) continue;
    const arr = byPhoneKey.get(key) ?? []; arr.push(r); byPhoneKey.set(key, arr);
  }

  const result: OnlineOrderSummary[] = orders.map((o: any) => {
    const ls = linesByBatch.get(o.order_batch_id) ?? [];
    const first = ls[0];
    const total = ls.reduce((s: number, l: any) => s + (l.qty ?? 0) * (l.unit_price ?? 0), 0);
    const orderRef = ls.find((l: any) => l.matched_order_ref && l.matched_order_ref !== '__pending_create__')?.matched_order_ref ?? null;
    const source: 'lab' | 'shop_stock' | 'excel_import' =
      o.source === 'shop_stock' ? 'shop_stock' : o.source === 'excel_import' ? 'excel_import' : 'lab';
    const phoneKey = normalizePhoneKey(o.customer_phone);
    const priorOrderCount = phoneKey
      ? (byPhoneKey.get(phoneKey) ?? []).filter(r => r.order_batch_id !== o.order_batch_id && r.created_at < o.created_at).length
      : 0;
    const override: boolean | null = o.customer_returning_override ?? null;
    const isReturningCustomer = override != null ? override : priorOrderCount > 0;
    return {
      orderBatchId: o.order_batch_id, source,
      shopName: o.shop_name ?? first?.shop_name ?? '', channel: o.channel ?? first?.channel ?? null,
      orderRef, createdAt: o.created_at, deliveryDate: o.delivery_date ?? first?.delivery_date ?? '',
      customerName: o.customer_name ?? first?.customer_name ?? null, customerPhone: o.customer_phone ?? first?.customer_phone ?? null,
      items: ls.map((l: any) => ({ nameVi: l.product_name_vi, qty: l.qty, unitPrice: l.unit_price, sku: l.sku ?? null })),
      total, deliveryFee: o.delivery_fee ?? 0, paymentStatus: o.payment_status, amountPaid: o.amount_paid ?? 0,
      labDelivered: source === 'shop_stock' ? true : (orderRef ? labDeliveredRefs.has(orderRef) : false),
      shopDelivered: o.shop_delivered, cancelled: (() => { const mcLines = ls.filter((l: any) => l._mc); return source === 'lab' && mcLines.length > 0 && mcLines.every((l: any) => l.cancelled_at); })(),
      paymentProofUrl: o.payment_proof_url ?? null,
      isReturningCustomer, returningManual: override != null, priorOrderCount,
    };
  });
  return { orders: result };
}

// Reconstruction (Axel, 2026-09-08): a historical excel_import order whose product text
// couldn't be auto-matched to a real SKU lands with ONE generic no-SKU revenue line (original
// Excel text kept verbatim as product_name_vi). This lets the seller replace that single line
// with real catalog items if she still remembers the order -- purely descriptive, never touches
// lab_manual_cakes/Odoo, and is refused for any order that isn't an import (a live lab/shop_stock
// order's lines are wired into other flows and must never be rewritten from here).
export async function replaceOnlineOrderLinesAction(
  orderBatchId: string,
  items: { ficheId: string | null; variantId: string | null; sku: string | null; nameVi: string; qty: number; unitPrice: number }[],
): Promise<{ ok?: boolean; error?: string }> {
  const auth = await requireOnlineWriteSession();
  if ('error' in auth) return { error: auth.error };
  const supabase = service();
  if (!supabase) return { error: 'Server not configured' };
  const ownErr = await assertOwnsOrder(supabase, orderBatchId, auth);
  if (ownErr) return { error: ownErr };
  if (!items.length) return { error: 'Empty' };

  const { data: order } = await supabase.from('lab_online_orders').select('source').eq('order_batch_id', orderBatchId).maybeSingle();
  if (!order || order.source !== 'excel_import') return { error: 'Not an imported order' };

  // Only the non-fee product line(s) are replaced -- a delivery-fee line (is_fee: true) is
  // unrelated to "what was sold" and is never touched here.
  const { error: delErr } = await supabase.from('lab_online_sale_lines').delete().eq('order_batch_id', orderBatchId).eq('is_fee', false);
  if (delErr) return { error: delErr.message };

  const rows = items.map(it => ({
    order_batch_id: orderBatchId, fiche_id: it.ficheId, variant_id: it.variantId, sku: it.sku,
    product_name_vi: it.nameVi, qty: Math.max(1, Math.round(it.qty)), unit_price: Math.max(0, it.unitPrice), is_fee: false,
  }));
  const { error: insErr } = await supabase.from('lab_online_sale_lines').insert(rows);
  if (insErr) return { error: insErr.message };
  revalidatePath('/online-orders');
  return { ok: true };
}

async function assertOwnsOrder(supabase: NonNullable<ReturnType<typeof service>>, orderBatchId: string, auth: { userId: string; isAdmin: boolean }): Promise<string | null> {
  if (auth.isAdmin) return null;
  const { data: row } = await supabase.from('lab_online_orders').select('created_by').eq('order_batch_id', orderBatchId).maybeSingle();
  if (!row || row.created_by !== auth.userId) return 'Not found';
  return null;
}

export async function setShopDeliveredAction(orderBatchId: string, delivered: boolean): Promise<{ ok?: boolean; error?: string }> {
  const auth = await requireOnlineWriteSession();
  if ('error' in auth) return { error: auth.error };
  const supabase = service();
  if (!supabase) return { error: 'Server not configured' };
  const ownErr = await assertOwnsOrder(supabase, orderBatchId, auth);
  if (ownErr) return { error: ownErr };
  const { error } = await supabase.from('lab_online_orders').update({
    shop_delivered: delivered, shop_delivered_at: delivered ? new Date().toISOString() : null,
    shop_delivered_by: delivered ? auth.userId : null,
  }).eq('order_batch_id', orderBatchId);
  if (error) return { error: error.message };
  revalidatePath('/online-orders');
  return { ok: true };
}

// Manual correction for the auto phone-match (Axel, 2026-09-11): toggles between "no override"
// (null — trust the auto-detection) and "confirmed returning customer" (true). Passing null
// clears back to auto.
export async function setCustomerReturningOverrideAction(orderBatchId: string, value: boolean | null): Promise<{ ok?: boolean; error?: string }> {
  const auth = await requireOnlineWriteSession();
  if ('error' in auth) return { error: auth.error };
  const supabase = service();
  if (!supabase) return { error: 'Server not configured' };
  const ownErr = await assertOwnsOrder(supabase, orderBatchId, auth);
  if (ownErr) return { error: ownErr };
  const { error } = await supabase.from('lab_online_orders').update({ customer_returning_override: value }).eq('order_batch_id', orderBatchId);
  if (error) return { error: error.message };
  revalidatePath('/online-orders');
  return { ok: true };
}

export async function setPaymentStatusAction(orderBatchId: string, status: 'paid' | 'unpaid' | 'partial', amountPaid: number): Promise<{ ok?: boolean; error?: string }> {
  const auth = await requireOnlineWriteSession();
  if ('error' in auth) return { error: auth.error };
  if (!['paid', 'unpaid', 'partial'].includes(status)) return { error: 'Invalid status' };
  const supabase = service();
  if (!supabase) return { error: 'Server not configured' };
  const ownErr = await assertOwnsOrder(supabase, orderBatchId, auth);
  if (ownErr) return { error: ownErr };
  const amt = Math.max(0, Number(amountPaid) || 0);
  const { error } = await supabase.from('lab_online_orders').update({
    payment_status: status, amount_paid: amt,
    ...(status === 'paid' ? { payment_alert_sent_at: null } : {}),
  }).eq('order_batch_id', orderBatchId);
  if (error) return { error: error.message };
  revalidatePath('/online-orders');
  return { ok: true };
}

// ── Sales channels (editable list, lab_v70) ──
export async function listOnlineChannelsAction(): Promise<{ channels?: string[]; error?: string }> {
  const auth = await requireOnlineSession();
  if ('error' in auth) return { error: auth.error };
  const supabase = service();
  if (!supabase) return { error: 'Server not configured' };
  const { data, error } = await supabase.from('lab_online_channels').select('name').order('created_at');
  if (error) return { error: error.message };
  return { channels: (data ?? []).map((r: any) => r.name as string) };
}

export async function addOnlineChannelAction(name: string): Promise<{ ok?: boolean; error?: string }> {
  const auth = await requireOnlineWriteSession();
  if ('error' in auth) return { error: auth.error };
  const supabase = service();
  if (!supabase) return { error: 'Server not configured' };
  const n = clean(name, 60);
  if (!n) return { error: 'Empty name' };
  const { error } = await supabase.from('lab_online_channels').upsert({ name: n, created_by: auth.userId }, { onConflict: 'name', ignoreDuplicates: true });
  if (error) return { error: error.message };
  return { ok: true };
}

export async function deleteOnlineChannelAction(name: string): Promise<{ ok?: boolean; error?: string }> {
  const auth = await requireOnlineWriteSession();
  if ('error' in auth) return { error: auth.error };
  const supabase = service();
  if (!supabase) return { error: 'Server not configured' };
  // Only the suggestion list is touched — past orders keep the channel text they were saved with.
  const { error } = await supabase.from('lab_online_channels').delete().eq('name', name);
  if (error) return { error: error.message };
  return { ok: true };
}

// ── Extra fees (configurable, lab_v75) — shared by anyone with online-orders access, same
// posture as sales channels above. Never touches Odoo/production (see buildFeeLineRows).
export type ExtraFeeType = { id: string; emoji: string | null; label: string; defaultPrice: number };

export async function listExtraFeeTypesAction(): Promise<{ fees?: ExtraFeeType[]; error?: string }> {
  const auth = await requireOnlineSession();
  if ('error' in auth) return { error: auth.error };
  const supabase = service();
  if (!supabase) return { error: 'Server not configured' };
  const { data, error } = await supabase.from('lab_online_extra_fees')
    .select('id, emoji, label, default_price').eq('active', true).order('created_at');
  if (error) return { error: error.message };
  return { fees: (data ?? []).map((r: any) => ({ id: r.id, emoji: r.emoji ?? null, label: r.label, defaultPrice: Number(r.default_price) })) };
}

export async function addExtraFeeTypeAction(input: { emoji?: string | null; label: string; defaultPrice: number }): Promise<{ ok?: boolean; error?: string }> {
  const auth = await requireOnlineWriteSession();
  if ('error' in auth) return { error: auth.error };
  const supabase = service();
  if (!supabase) return { error: 'Server not configured' };
  const label = clean(input.label, 60);
  if (!label) return { error: 'Empty name' };
  const emoji = clean(input.emoji ?? '', 4) || null;
  const defaultPrice = Math.max(0, Number(input.defaultPrice) || 0);
  const { error } = await supabase.from('lab_online_extra_fees').insert({ emoji, label, default_price: defaultPrice, created_by: auth.userId });
  if (error) return { error: error.message };
  return { ok: true };
}

export async function updateExtraFeeTypeAction(input: { id: string; emoji?: string | null; label?: string; defaultPrice?: number }): Promise<{ ok?: boolean; error?: string }> {
  const auth = await requireOnlineWriteSession();
  if ('error' in auth) return { error: auth.error };
  const supabase = service();
  if (!supabase) return { error: 'Server not configured' };
  const patch: Record<string, unknown> = {};
  if (input.label != null) { const l = clean(input.label, 60); if (!l) return { error: 'Empty name' }; patch.label = l; }
  if (input.emoji != null) patch.emoji = clean(input.emoji, 4) || null;
  if (input.defaultPrice != null) patch.default_price = Math.max(0, Number(input.defaultPrice) || 0);
  if (!Object.keys(patch).length) return { ok: true };
  const { error } = await supabase.from('lab_online_extra_fees').update(patch).eq('id', input.id);
  if (error) return { error: error.message };
  return { ok: true };
}

export async function deleteExtraFeeTypeAction(id: string): Promise<{ ok?: boolean; error?: string }> {
  const auth = await requireOnlineWriteSession();
  if ('error' in auth) return { error: auth.error };
  const supabase = service();
  if (!supabase) return { error: 'Server not configured' };
  // Soft delete: past orders keep the fee line text/price they were saved with regardless.
  const { error } = await supabase.from('lab_online_extra_fees').update({ active: false }).eq('id', id);
  if (error) return { error: error.message };
  return { ok: true };
}

// ── Payment screenshot (lab_v71) ──
// The browser downsizes the image to ~1200px JPEG before calling this (see OnlineOrdersView),
// so a typical bank-app screenshot lands at 100–250 KB instead of 2–5 MB — negligible for
// storage, and it is only ever rendered as a next/image thumbnail on demand (egress-cached).
export async function uploadPaymentProofAction(orderBatchId: string, formData: FormData): Promise<{ url?: string; error?: string }> {
  const auth = await requireOnlineWriteSession();
  if ('error' in auth) return { error: auth.error };
  const supabase = service();
  if (!supabase) return { error: 'Server not configured' };
  const denied = await assertOwnsOrder(supabase, orderBatchId, auth);
  if (denied) return { error: denied };
  const file = formData.get('file');
  if (!(file instanceof File)) return { error: 'No file' };
  if (!file.type.startsWith('image/')) return { error: 'Only images are allowed' };
  if (file.size > 1.5 * 1024 * 1024) return { error: 'Image too large — max 1.5MB after compression' };
  const ext = (file.type.split('/')[1] || 'jpg').replace(/[^a-z0-9]/gi, '').slice(0, 5) || 'jpg';
  const path = `payments/${new Date().toISOString().slice(0, 10)}/${orderBatchId}.${ext}`;
  const buf = Buffer.from(await file.arrayBuffer());
  const { error: upErr } = await supabase.storage.from('lab-design-photos').upload(path, buf, { contentType: file.type, upsert: true });
  if (upErr) return { error: upErr.message };
  const { data } = supabase.storage.from('lab-design-photos').getPublicUrl(path);
  const { error } = await supabase.from('lab_online_orders').update({ payment_proof_url: data.publicUrl }).eq('order_batch_id', orderBatchId);
  if (error) return { error: error.message };
  return { url: data.publicUrl };
}

// ── Analytic ──
export type OnlineAnalytics = {
  // Axel, 2026-09-08: "afficher les 2 montants" -- todayTotal/monthTotal/rangeTotal are the
  // merchandise-only amount (product lines, no delivery fee, no line-level fee charges).
  // The matching *GrandTotal field adds delivery_fee + fee-lines on top -- what the customer
  // actually paid.
  todayTotal: number; todayGrandTotal: number; todayCount: number;
  monthTotal: number; monthGrandTotal: number; monthCount: number;
  byShop: { shop: string; total: number }[];
  byCategory: { category: string; total: number; products: { name: string; sku: string | null; qty: number; total: number }[] }[];
  byChannel: { channel: string; total: number }[];
  // Selected range (Axel, 2026-09-07: 'analyser sur une durée plus longue'): every breakdown
  // above is computed over rangeDays; today/month tiles are absolute.
  rangeDays: number; rangeTotal: number; rangeGrandTotal: number; rangeCount: number;
  series: { key: string; label: string; total: number }[]; // day / week / month buckets
  daily: { date: string; total: number }[];
};

export async function getOnlineAnalyticsAction(rangeDaysInput?: number): Promise<{ data?: OnlineAnalytics; error?: string }> {
  const rangeDays = [14, 30, 90, 365].includes(Number(rangeDaysInput)) ? Number(rangeDaysInput) : 14;
  const auth = await requireOnlineSession();
  if ('error' in auth) return { error: auth.error };
  const supabase = service();
  if (!supabase) return { error: 'Server not configured' };

  // Fetch enough for both the selected range and the absolute month tile.
  const since = new Date(Date.now() - Math.max(rangeDays, 60) * 86400000).toISOString();
  // Explicit limits: PostgREST caps unbounded selects at 1000 rows (see the 09-01 Lịch sử bug).
  // Axel, 2026-09-08: see the note in getMyOnlineOrdersAction -- analytics must reflect every
  // online order (imports included), not just the ones this account created.
  const oq = supabase.from('lab_online_orders').select('order_batch_id, created_by, created_at, delivery_date, source, shop_name, channel, delivery_fee').gte('created_at', since).limit(5000);
  void auth.isAdmin;
  const { data: orders } = await oq;
  const batchIds = (orders ?? []).map((o: any) => o.order_batch_id);
  const empty: OnlineAnalytics = { todayTotal: 0, todayGrandTotal: 0, todayCount: 0, monthTotal: 0, monthGrandTotal: 0, monthCount: 0, byShop: [], byCategory: [], byChannel: [], rangeDays, rangeTotal: 0, rangeGrandTotal: 0, rangeCount: 0, series: [], daily: [] };
  if (!batchIds.length) return { data: empty };

  const labIds = (orders ?? []).filter((o: any) => (o.source ?? 'lab') === 'lab').map((o: any) => o.order_batch_id);
  // sale_lines is queried for EVERY batch, not just shop_stock ones — a 'lab' order can also
  // carry extra-fee lines there (fees never touch lab_manual_cakes/production, see
  // buildFeeLineRows), so its fee lines only show up via this table regardless of source.
  const [{ data: labLines }, { data: stockLines }] = await Promise.all([
    labIds.length
      ? supabase.from('lab_manual_cakes').select('order_batch_id, qty, unit_price, shop_name, channel, product_sku, product_name_vi, cancelled_at, created_at').in('order_batch_id', labIds).is('cancelled_at', null).limit(20000)
      : Promise.resolve({ data: [] as any[] }),
    batchIds.length
      ? supabase.from('lab_online_sale_lines').select('order_batch_id, qty, unit_price, sku, category, product_name_vi, created_at, is_fee').in('order_batch_id', batchIds).limit(20000)
      : Promise.resolve({ data: [] as any[] }),
  ]);
  const orderById = new Map<string, any>();
  for (const o of orders ?? []) orderById.set(o.order_batch_id, o);
  // Normalise both line shapes: sale_lines rows take shop/channel/source from their order header
  // (they already carry a category — no fiche lookup needed) so a fee line reports under
  // whichever source its order actually is, not a hardcoded 'shop_stock'.
  const lines: any[] = [
    ...(labLines ?? []).map((l: any) => ({ ...l, source: 'lab' as const, category: null as string | null, is_fee: false })),
    ...(stockLines ?? []).map((l: any) => {
      const o = orderById.get(l.order_batch_id);
      return { order_batch_id: l.order_batch_id, qty: l.qty, unit_price: l.unit_price, shop_name: o?.shop_name ?? null, channel: o?.channel ?? null, product_sku: l.sku, product_name_vi: l.product_name_vi, created_at: l.created_at, category: l.category as string | null, is_fee: !!l.is_fee };
    }),
  ];

  const skus = Array.from(new Set((lines ?? []).map((l: any) => l.product_sku).filter(Boolean))) as string[];
  const { data: variants } = skus.length ? await supabase.from('lab_fiche_variants').select('sku, fiche_id').in('sku', skus) : { data: [] as any[] };
  const ficheIdBySku = new Map<string, string>();
  for (const v of variants ?? []) if (v.sku) ficheIdBySku.set(v.sku, v.fiche_id);
  const ficheIds = Array.from(new Set(Array.from(ficheIdBySku.values())));
  const { data: fiches } = ficheIds.length ? await supabase.from('lab_fiche_meta').select('id, category').in('id', ficheIds) : { data: [] as any[] };
  const categoryByFiche = new Map<string, string>();
  for (const f of fiches ?? []) categoryByFiche.set(f.id, f.category ?? 'Khác');

  // Bucketed by delivery_date, not created_at: a cake ordered today for delivery in 3 days is
  // revenue on the delivery day, not the order day (Axel, 2026-09-07).
  const deliveryDateByBatch = new Map<string, string>();
  for (const o of orders ?? []) deliveryDateByBatch.set(o.order_batch_id, o.delivery_date ?? o.created_at);

  const todayStr = new Date().toISOString().slice(0, 10);
  const monthStr = todayStr.slice(0, 7);
  // todayTotal/monthTotal/rangeTotal: merchandise only (is_fee lines excluded).
  // todayGrandTotal/monthGrandTotal/rangeGrandTotal: merchandise + fee-lines + delivery_fee.
  let todayTotal = 0, todayGrandTotal = 0, monthTotal = 0, monthGrandTotal = 0;
  const todayBatches = new Set<string>(), monthBatches = new Set<string>();
  const byShop = new Map<string, number>();
  const byCategory = new Map<string, number>();
  const productsByCategory = new Map<string, Map<string, { name: string; sku: string | null; qty: number; total: number }>>();
  const byChannel = new Map<string, number>();
  const byDay = new Map<string, number>();
  const rangeStart = new Date(Date.now() - (rangeDays - 1) * 86400000).toISOString().slice(0, 10);
  let rangeTotal = 0, rangeGrandTotal = 0; const rangeBatches = new Set<string>();

  for (const l of lines ?? []) {
    const lineTotal = (l.qty ?? 0) * (l.unit_price ?? 0);
    const deliveryDate = deliveryDateByBatch.get(l.order_batch_id) ?? l.created_at;
    const day = (deliveryDate ?? '').slice(0, 10);
    if (day === todayStr) { todayGrandTotal += lineTotal; todayBatches.add(l.order_batch_id); if (!l.is_fee) todayTotal += lineTotal; }
    if (day.slice(0, 7) === monthStr) { monthGrandTotal += lineTotal; monthBatches.add(l.order_batch_id); if (!l.is_fee) monthTotal += lineTotal; }
    if (day < rangeStart) continue; // breakdowns below are scoped to the selected range
    rangeGrandTotal += lineTotal; if (!l.is_fee) rangeTotal += lineTotal; rangeBatches.add(l.order_batch_id);
    const shop = l.shop_name ?? 'Khác';
    byShop.set(shop, (byShop.get(shop) ?? 0) + lineTotal);
    const ficheId = l.product_sku ? ficheIdBySku.get(l.product_sku) : null;
    const cat = l.category ?? (ficheId ? (categoryByFiche.get(ficheId) ?? 'Khác') : 'Khác');
    byCategory.set(cat, (byCategory.get(cat) ?? 0) + lineTotal);
    const pkey = l.product_sku ?? l.product_name_vi ?? '?';
    const pm = productsByCategory.get(cat) ?? new Map();
    const pe = pm.get(pkey) ?? { name: l.product_name_vi ?? l.product_sku ?? '?', sku: l.product_sku ?? null, qty: 0, total: 0 };
    pe.qty += l.qty ?? 0; pe.total += lineTotal; pm.set(pkey, pe); productsByCategory.set(cat, pm);
    const ch = (l.channel ?? '').trim() || '—';
    byChannel.set(ch, (byChannel.get(ch) ?? 0) + lineTotal);
    if (day) byDay.set(day, (byDay.get(day) ?? 0) + lineTotal);
  }

  // delivery_fee lives on the order header, once per order (not per line) -- add it to the
  // grand totals in its own pass so an order with several sale lines doesn't get it multiplied.
  // Axel, 2026-09-09: "revenue by shop" must foot to the range's grand total (with fees), not the
  // merchandise-only total -- so the fee also gets attributed to that order's shop here.
  for (const o of orders ?? []) {
    const fee = Number(o.delivery_fee ?? 0);
    if (!fee) continue;
    const day = (o.delivery_date ?? o.created_at ?? '').slice(0, 10);
    if (day === todayStr) todayGrandTotal += fee;
    if (day.slice(0, 7) === monthStr) monthGrandTotal += fee;
    if (day >= rangeStart) {
      rangeGrandTotal += fee;
      const shop = o.shop_name ?? 'Khác';
      byShop.set(shop, (byShop.get(shop) ?? 0) + fee);
    }
  }

  const daily: { date: string; total: number }[] = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    daily.push({ date: d, total: byDay.get(d) ?? 0 });
  }
  // Time series for the chart: daily up to 30 days, weekly up to 90, monthly for a year.
  // Extended forward past "today" when a delivery already booked lands later than the window's
  // end (Axel, 2026-09-07): an order taken now for a delivery next week must show up on that
  // future day instead of being invisible until it arrives.
  const futureDays = Array.from(byDay.keys()).filter(d => d > todayStr).sort();
  const seriesEnd = futureDays.length ? futureDays[futureDays.length - 1] : todayStr;
  // Don't waste chart width on empty days/weeks/months before the earliest real data (Axel,
  // 2026-09-08: "ca commence le 1er ... on pourrait exploiter plus la largeur" -- a fixed
  // 365-day lookback with all the actual data landing in the last week squeezed nearly every
  // bar to nothing and piled their labels on top of each other at the right edge). Only ever
  // trims the front, never extends past the user-selected rangeDays window.
  const earliestDataDay = Array.from(byDay.keys()).sort()[0];
  const effectiveStart = earliestDataDay && earliestDataDay > rangeStart ? earliestDataDay : rangeStart;
  const startDate = new Date(effectiveStart + 'T00:00:00Z');
  const endDate = new Date(seriesEnd + 'T00:00:00Z');
  const totalSpanDays = Math.max(1, Math.round((endDate.getTime() - startDate.getTime()) / 86400000) + 1);
  const dateAt = (i: number) => { const d = new Date(startDate); d.setUTCDate(d.getUTCDate() + i); return d.toISOString().slice(0, 10); };

  const series: { key: string; label: string; total: number }[] = [];
  const dd = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
  if (rangeDays <= 30) {
    for (let i = 0; i < totalSpanDays; i++) {
      const d = dateAt(i);
      series.push({ key: d, label: dd(d), total: byDay.get(d) ?? 0 });
    }
  } else if (rangeDays <= 90) {
    const weeks = Math.ceil(totalSpanDays / 7);
    for (let w = 0; w < weeks; w++) {
      let t = 0; let firstDay = '';
      for (let i = w * 7; i < Math.min(w * 7 + 7, totalSpanDays); i++) {
        const d = dateAt(i);
        if (!firstDay) firstDay = d;
        t += byDay.get(d) ?? 0;
      }
      series.push({ key: `w${w}`, label: dd(firstDay), total: t });
    }
  } else {
    const byMonth = new Map<string, number>();
    Array.from(byDay.entries()).forEach(([d, t]) => { if (d >= rangeStart) byMonth.set(d.slice(0, 7), (byMonth.get(d.slice(0, 7)) ?? 0) + t); });
    const now = new Date();
    const anchor = endDate > now ? endDate : now;
    // Same front-trim as day/week above, in months: never show more empty leading months than
    // the earliest real data actually needs, capped at the usual 12-month window.
    const startMonthDate = new Date(Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), 1));
    // Floor of 2 months even when all data sits in the current month -- a single bar reads as
    // broken, not as "trimmed"; a floor of 2 still gives it a neighbour for context.
    const monthsSpan = Math.min(12, Math.max(2,
      (anchor.getUTCFullYear() - startMonthDate.getUTCFullYear()) * 12 + (anchor.getUTCMonth() - startMonthDate.getUTCMonth()) + 1));
    for (let m = monthsSpan - 1; m >= 0; m--) {
      const dt = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() - m, 1));
      const key = dt.toISOString().slice(0, 7);
      series.push({ key, label: `${key.slice(5, 7)}/${key.slice(2, 4)}`, total: byMonth.get(key) ?? 0 });
    }
  }

  return {
    data: {
      todayTotal, todayGrandTotal, todayCount: todayBatches.size,
      monthTotal, monthGrandTotal, monthCount: monthBatches.size,
      byShop: Array.from(byShop.entries()).map(([shop, total]) => ({ shop, total })).sort((a, b) => b.total - a.total),
      byCategory: Array.from(byCategory.entries()).map(([category, total]) => ({
        category, total,
        products: Array.from((productsByCategory.get(category) ?? new Map()).values()).sort((a: any, b: any) => b.total - a.total),
      })).sort((a, b) => b.total - a.total),
      byChannel: Array.from(byChannel.entries()).map(([channel, total]) => ({ channel, total })).sort((a, b) => b.total - a.total),
      // Axel, 2026-09-08: "on comptabilise tout ensemble" -- one combined online-orders total
      // regardless of how an order was recorded (live app order vs backfilled excel_import
      // history). No per-source breakdown in the analytics; `source` is still tracked per-order
      // for the reconstruction feature, just not split out here.
      rangeDays, rangeTotal, rangeGrandTotal, rangeCount: rangeBatches.size, series,
      daily,
    },
  };
}

// ── Push notifications (reuses sendShopPush/sendAdminPush with a pseudo shop_name) ──
export async function subscribeOnlinePushAction(subscription: { endpoint: string; keys: { p256dh: string; auth: string } }): Promise<{ ok?: boolean; error?: string }> {
  const auth = await requireOnlineSession();
  if ('error' in auth) return { error: auth.error };
  if (!subscription?.endpoint || !subscription.keys?.p256dh || !subscription.keys?.auth) return { error: 'Invalid subscription' };
  const supabase = service();
  if (!supabase) return { error: 'Not configured' };
  const { error } = await supabase.from('lab_shop_push_subscriptions').upsert({
    shop_name: ONLINE_PUSH_KEY, endpoint: subscription.endpoint, p256dh: subscription.keys.p256dh, auth: subscription.keys.auth,
    last_seen_at: new Date().toISOString(),
  }, { onConflict: 'endpoint,shop_name' });
  if (error) return { error: error.message };
  return { ok: true };
}

export async function unsubscribeOnlinePushAction(endpoint: string): Promise<{ ok?: boolean }> {
  const auth = await requireOnlineSession();
  if ('error' in auth) return { ok: true };
  const supabase = service();
  if (!supabase || !endpoint) return { ok: true };
  await supabase.from('lab_shop_push_subscriptions').delete().eq('endpoint', endpoint).eq('shop_name', ONLINE_PUSH_KEY);
  return { ok: true };
}
