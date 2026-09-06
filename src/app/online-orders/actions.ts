'use server';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { createClient, getSafeSession } from '@/lib/supabase-server';
import { SHOP_ODOO_MAP, createOdooOrderForSelection } from '@/lib/odoo-shop-order-sync';
import { ONLINE_PUSH_KEY } from '@/lib/online-sales';
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

async function requireOnlineSession(): Promise<{ userId: string; fullName: string; isAdmin: boolean } | { error: string }> {
  const supabase = createClient();
  const { data: { session } } = await getSafeSession(supabase);
  if (!session) return { error: 'Not authenticated' };
  const { data: profile } = await supabase.from('profiles').select('role, full_name').eq('id', session.user.id).single();
  if (!profile || !['online_sales', 'admin'].includes(profile.role)) return { error: 'Not authorized' };
  return { userId: session.user.id, fullName: profile.full_name ?? '', isAdmin: profile.role === 'admin' };
}

const clean = (s: string | null | undefined, max: number) => {
  const t = (s ?? '').trim().slice(0, max);
  return t === '' ? null : t;
};

// ── Product search (session-gated twin of order/[token]/actions.ts's searchShopProductsAction) ──
export type OnlineProduct = {
  ficheId: string; variantId: string | null; sku: string | null;
  nameVi: string; imageUrl: string | null; isCake: boolean; hasTeam: boolean;
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
  const auth = await requireOnlineSession();
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
};

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
  items: OnlineOrderItem[];
}): Promise<{ ok?: boolean; orderRef?: string | null; warning?: string; error?: string }> {
  const auth = await requireOnlineSession();
  if ('error' in auth) return { error: auth.error };
  const supabase = service();
  if (!supabase) return { error: 'Server not configured' };

  if (!SHOPS.includes(input.shop)) return { error: 'Invalid shop' };
  const channel = clean(input.channel, 60);
  if (!channel) return { error: 'Missing channel' };
  const items = Array.isArray(input.items) ? input.items : [];
  if (items.length < 1 || items.length > 20) return { error: 'Invalid item count' };
  const today = new Date().toISOString().split('T')[0];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.deliveryDate ?? '') || input.deliveryDate < today) return { error: 'Invalid delivery date' };
  if (!['paid', 'unpaid', 'partial'].includes(input.paymentStatus)) return { error: 'Invalid payment status' };

  type Resolved = {
    ficheId: string; variantId: string | null; sku: string | null; team: string;
    nameVi: string; nameEn: string; imageUrl: string | null; variantLabel: string;
    qty: number; unitPrice: number; message: string | null; isCake: boolean;
    designNotes: string | null; designPhotoUrl: string | null;
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
      customer_name: customerName, customer_phone: customerPhone, notes,
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
  const odooResult = await createOdooOrderForSelection(supabase, createdCakeIds, { note: `Online order — ${channel}` });

  // ── Order-level fields (money, payment, who) ──
  const { error: ooErr } = await supabase.from('lab_online_orders').insert({
    order_batch_id: orderBatchId,
    delivery_fee: Math.max(0, Number(input.deliveryFee) || 0),
    payment_status: input.paymentStatus,
    amount_paid: Math.max(0, Number(input.amountPaid) || 0),
    created_by: auth.userId,
  });
  if (ooErr) {
    revalidatePath('/online-orders');
    return { ok: true, orderRef: odooResult.order_ref ?? null, warning: `Đơn đã lưu nhưng lỗi ghi thông tin thanh toán: ${ooErr.message}` };
  }

  revalidatePath('/online-orders');
  if (!odooResult.ok) {
    return { ok: true, orderRef: null, warning: `Đơn đã lưu, sản xuất đã lên lịch, nhưng tạo đơn Odoo thất bại (${odooResult.error}) — admin sẽ tạo thủ công.` };
  }
  return { ok: true, orderRef: odooResult.order_ref ?? null };
}

// ── Suivi (tracking) ──
export type OnlineOrderSummary = {
  orderBatchId: string; shopName: string; channel: string | null; orderRef: string | null;
  createdAt: string; deliveryDate: string;
  customerName: string | null; customerPhone: string | null;
  items: { nameVi: string; qty: number; unitPrice: number | null }[];
  total: number; deliveryFee: number; paymentStatus: 'paid' | 'unpaid' | 'partial'; amountPaid: number;
  labDelivered: boolean; shopDelivered: boolean; cancelled: boolean;
};

export async function getMyOnlineOrdersAction(): Promise<{ orders?: OnlineOrderSummary[]; error?: string }> {
  const auth = await requireOnlineSession();
  if ('error' in auth) return { error: auth.error };
  const supabase = service();
  if (!supabase) return { error: 'Server not configured' };

  let oq = supabase.from('lab_online_orders').select('*').order('created_at', { ascending: false }).limit(200);
  if (!auth.isAdmin) oq = oq.eq('created_by', auth.userId);
  const { data: orders } = await oq;
  if (!orders?.length) return { orders: [] };

  const batchIds = orders.map((o: any) => o.order_batch_id);
  const { data: lines } = await supabase.from('lab_manual_cakes')
    .select('order_batch_id, product_name_vi, qty, unit_price, shop_name, channel, delivery_date, customer_name, customer_phone, matched_order_ref, cancelled_at, created_at')
    .in('order_batch_id', batchIds);

  const linesByBatch = new Map<string, any[]>();
  for (const l of lines ?? []) {
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

  const result: OnlineOrderSummary[] = orders.map((o: any) => {
    const ls = linesByBatch.get(o.order_batch_id) ?? [];
    const first = ls[0];
    const total = ls.reduce((s: number, l: any) => s + (l.qty ?? 0) * (l.unit_price ?? 0), 0);
    const orderRef = ls.find((l: any) => l.matched_order_ref && l.matched_order_ref !== '__pending_create__')?.matched_order_ref ?? null;
    return {
      orderBatchId: o.order_batch_id, shopName: first?.shop_name ?? '', channel: first?.channel ?? null,
      orderRef, createdAt: o.created_at, deliveryDate: first?.delivery_date ?? '',
      customerName: first?.customer_name ?? null, customerPhone: first?.customer_phone ?? null,
      items: ls.map((l: any) => ({ nameVi: l.product_name_vi, qty: l.qty, unitPrice: l.unit_price })),
      total, deliveryFee: o.delivery_fee ?? 0, paymentStatus: o.payment_status, amountPaid: o.amount_paid ?? 0,
      labDelivered: orderRef ? labDeliveredRefs.has(orderRef) : false,
      shopDelivered: o.shop_delivered, cancelled: ls.length > 0 && ls.every((l: any) => l.cancelled_at),
    };
  });
  return { orders: result };
}

async function assertOwnsOrder(supabase: NonNullable<ReturnType<typeof service>>, orderBatchId: string, auth: { userId: string; isAdmin: boolean }): Promise<string | null> {
  if (auth.isAdmin) return null;
  const { data: row } = await supabase.from('lab_online_orders').select('created_by').eq('order_batch_id', orderBatchId).maybeSingle();
  if (!row || row.created_by !== auth.userId) return 'Not found';
  return null;
}

export async function setShopDeliveredAction(orderBatchId: string, delivered: boolean): Promise<{ ok?: boolean; error?: string }> {
  const auth = await requireOnlineSession();
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

export async function setPaymentStatusAction(orderBatchId: string, status: 'paid' | 'unpaid' | 'partial', amountPaid: number): Promise<{ ok?: boolean; error?: string }> {
  const auth = await requireOnlineSession();
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

// ── Analytic ──
export type OnlineAnalytics = {
  todayTotal: number; todayCount: number; monthTotal: number; monthCount: number;
  byShop: { shop: string; total: number }[];
  byCategory: { category: string; total: number }[];
  daily: { date: string; total: number }[];
};

export async function getOnlineAnalyticsAction(): Promise<{ data?: OnlineAnalytics; error?: string }> {
  const auth = await requireOnlineSession();
  if ('error' in auth) return { error: auth.error };
  const supabase = service();
  if (!supabase) return { error: 'Server not configured' };

  const since = new Date(Date.now() - 60 * 86400000).toISOString();
  let oq = supabase.from('lab_online_orders').select('order_batch_id, created_by, created_at').gte('created_at', since);
  if (!auth.isAdmin) oq = oq.eq('created_by', auth.userId);
  const { data: orders } = await oq;
  const batchIds = (orders ?? []).map((o: any) => o.order_batch_id);
  const empty: OnlineAnalytics = { todayTotal: 0, todayCount: 0, monthTotal: 0, monthCount: 0, byShop: [], byCategory: [], daily: [] };
  if (!batchIds.length) return { data: empty };

  const { data: lines } = await supabase.from('lab_manual_cakes')
    .select('order_batch_id, qty, unit_price, shop_name, product_sku, cancelled_at, created_at')
    .in('order_batch_id', batchIds).is('cancelled_at', null);

  const skus = Array.from(new Set((lines ?? []).map((l: any) => l.product_sku).filter(Boolean))) as string[];
  const { data: variants } = skus.length ? await supabase.from('lab_fiche_variants').select('sku, fiche_id').in('sku', skus) : { data: [] as any[] };
  const ficheIdBySku = new Map<string, string>();
  for (const v of variants ?? []) if (v.sku) ficheIdBySku.set(v.sku, v.fiche_id);
  const ficheIds = Array.from(new Set(Array.from(ficheIdBySku.values())));
  const { data: fiches } = ficheIds.length ? await supabase.from('lab_fiche_meta').select('id, category').in('id', ficheIds) : { data: [] as any[] };
  const categoryByFiche = new Map<string, string>();
  for (const f of fiches ?? []) categoryByFiche.set(f.id, f.category ?? 'Khác');

  const createdAtByBatch = new Map<string, string>();
  for (const o of orders ?? []) createdAtByBatch.set(o.order_batch_id, o.created_at);

  const todayStr = new Date().toISOString().slice(0, 10);
  const monthStr = todayStr.slice(0, 7);
  let todayTotal = 0, monthTotal = 0;
  const todayBatches = new Set<string>(), monthBatches = new Set<string>();
  const byShop = new Map<string, number>();
  const byCategory = new Map<string, number>();
  const byDay = new Map<string, number>();

  for (const l of lines ?? []) {
    const lineTotal = (l.qty ?? 0) * (l.unit_price ?? 0);
    const createdAt = createdAtByBatch.get(l.order_batch_id) ?? l.created_at;
    const day = (createdAt ?? '').slice(0, 10);
    if (day === todayStr) { todayTotal += lineTotal; todayBatches.add(l.order_batch_id); }
    if (day.slice(0, 7) === monthStr) { monthTotal += lineTotal; monthBatches.add(l.order_batch_id); }
    const shop = l.shop_name ?? 'Khác';
    byShop.set(shop, (byShop.get(shop) ?? 0) + lineTotal);
    const ficheId = l.product_sku ? ficheIdBySku.get(l.product_sku) : null;
    const cat = ficheId ? (categoryByFiche.get(ficheId) ?? 'Khác') : 'Khác';
    byCategory.set(cat, (byCategory.get(cat) ?? 0) + lineTotal);
    if (day) byDay.set(day, (byDay.get(day) ?? 0) + lineTotal);
  }

  const daily: { date: string; total: number }[] = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    daily.push({ date: d, total: byDay.get(d) ?? 0 });
  }

  return {
    data: {
      todayTotal, todayCount: todayBatches.size, monthTotal, monthCount: monthBatches.size,
      byShop: Array.from(byShop.entries()).map(([shop, total]) => ({ shop, total })).sort((a, b) => b.total - a.total),
      byCategory: Array.from(byCategory.entries()).map(([category, total]) => ({ category, total })).sort((a, b) => b.total - a.total),
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
