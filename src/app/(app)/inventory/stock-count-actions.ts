'use server';
// Lab inventory of raw materials and packaging (Axel, 2026-11-09). App tables only while the team
// counts — Odoo is read when a count is opened (scope) and on the recap (theoretical at each line's
// count time), and written once on send (one draft sheet). See lib/stock-count-odoo.ts.
import { waitUntil } from '@vercel/functions';
import { revalidateTag } from 'next/cache';
import { rawActor, rawService, purchasingUserIds, type RawActor } from '@/lib/raw-materials-db';
import { addItemPhoto } from '@/lib/item-photos';
import { sendUsersPush, awaitPush } from '@/lib/push-notify';
import { scopeAtLab, theoreticals, createDraftSheet, productCosts } from '@/lib/stock-count-odoo';

export type CountKind = 'raw' | 'packaging';
export type CountItem = {
  tmplId: number; productId: number | null; sku: string | null; name: string; nameVi: string | null; uom: string;
  type: string; sub: string; packs: { label: string; factor: number }[]; brands: string[]; price: number | null;
};
export type CountLine = {
  tmplId: number; inScope: boolean; qty: number | null; entry: any; notFound: boolean;
  countedAt: string | null; countedBy: string | null;
};
export type Unknown = {
  id: string; photoUrl: string | null; qty: number | null; unit: string | null; note: string | null; zone: string | null;
  createdBy: string | null; createdAt: string; status: string; tmplId: number | null;
};
export type CountHeader = {
  id: string; kind: CountKind; countDate: string; status: string; createdBy: string | null; createdAt: string;
  submittedAt: string | null; submittedBy: string | null; odooInventoryId: number | null; pushStatus: string | null; pushError: string | null;
};

// Admin, lab manager, assistants and purchasing (storage) — Axel, 2026-11-09.
function canCount(a: RawActor | null): a is RawActor {
  return !!a && (['admin', 'lab_manager', 'assistant', 'purchasing'].includes(a.role) || a.canPurchase);
}
function vnToday(): string { return new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10); }
const mapHeader = (c: any): CountHeader => ({
  id: c.id, kind: c.kind, countDate: c.count_date, status: c.status, createdBy: c.created_by_name, createdAt: c.created_at,
  submittedAt: c.submitted_at, submittedBy: c.submitted_by_name, odooInventoryId: c.odoo_inventory_id, pushStatus: c.push_status, pushError: c.push_error,
});

async function catalog(db: NonNullable<ReturnType<typeof rawService>>, kind: CountKind): Promise<any[]> {
  const { data } = await db.from('lab_raw_materials')
    .select('tmpl_id, product_id, sku, name, name_vi, uom, type, sub, packs, brands').eq('kind', kind).eq('active', true).limit(3000);
  return data ?? [];
}

export async function listCountsAction(): Promise<{ counts?: (CountHeader & { counted: number; scope: number; unknownOpen: number })[]; error?: string }> {
  const a = await rawActor();
  if (!canCount(a)) return { error: 'Forbidden' };
  const db = rawService(); if (!db) return { error: 'Server not configured' };
  const { data } = await db.from('lab_stock_counts').select('*').order('created_at', { ascending: false }).limit(20);
  const out = [];
  for (const c of data ?? []) {
    const [{ count: scope }, { count: counted }, { count: unknownOpen }] = await Promise.all([
      db.from('lab_stock_count_lines').select('*', { count: 'exact', head: true }).eq('count_id', c.id).eq('in_scope', true),
      db.from('lab_stock_count_lines').select('*', { count: 'exact', head: true }).eq('count_id', c.id).or('qty.not.is.null,not_found.eq.true'),
      db.from('lab_stock_count_unknowns').select('*', { count: 'exact', head: true }).eq('count_id', c.id).eq('status', 'open'),
    ]);
    out.push({ ...mapHeader(c), scope: scope ?? 0, counted: counted ?? 0, unknownOpen: unknownOpen ?? 0 });
  }
  return { counts: out };
}

// Open the current count of this kind, or start one: the list to count = products of the category
// with stock or a move at LAB/Stock in the last 90 days (one Odoo read, here only).
export async function startCountAction(kind: CountKind, countDate?: string): Promise<{ id?: string; error?: string }> {
  const a = await rawActor();
  if (!canCount(a)) return { error: 'Forbidden' };
  if (kind !== 'raw' && kind !== 'packaging') return { error: 'Bad kind' };
  const db = rawService(); if (!db) return { error: 'Server not configured' };
  const { data: open } = await db.from('lab_stock_counts').select('id').eq('kind', kind).eq('status', 'draft').maybeSingle();
  if (open) return { id: open.id };
  const items = await catalog(db, kind);
  let scope: Set<number>;
  try { scope = await scopeAtLab(items.map(i => i.product_id).filter(Boolean)); }
  catch (e: any) { return { error: `Odoo: ${String(e?.message ?? e).slice(0, 200)}` }; }
  const { data: c, error } = await db.from('lab_stock_counts').insert({
    kind, count_date: countDate || vnToday(), created_by: a.userId, created_by_name: a.name || null,
  }).select('id').single();
  if (error || !c) return { error: error?.message ?? 'Insert failed' };
  const rows = items.filter(i => i.product_id && scope.has(i.product_id)).map(i => ({ count_id: c.id, tmpl_id: i.tmpl_id, product_id: i.product_id, in_scope: true }));
  for (let k = 0; k < rows.length; k += 500) await db.from('lab_stock_count_lines').insert(rows.slice(k, k + 500));
  return { id: c.id };
}

// Everything the count screen needs, in one load: header, catalogue of the kind, lines, unknown photos, aliases.
export async function getCountAction(id: string): Promise<{ header?: CountHeader; items?: CountItem[]; lines?: CountLine[]; unknowns?: Unknown[]; aliases?: [number, string][]; error?: string }> {
  const a = await rawActor();
  if (!canCount(a)) return { error: 'Forbidden' };
  const db = rawService(); if (!db) return { error: 'Server not configured' };
  const { data: c } = await db.from('lab_stock_counts').select('*').eq('id', id).maybeSingle();
  if (!c) return { error: 'Not found' };
  const [items, { data: lines }, { data: unk }, { data: al }] = await Promise.all([
    catalog(db, c.kind),
    db.from('lab_stock_count_lines').select('tmpl_id, in_scope, qty, entry, not_found, counted_at, counted_by_name').eq('count_id', id).limit(3000),
    db.from('lab_stock_count_unknowns').select('*').eq('count_id', id).order('created_at'),
    db.from('lab_raw_aliases').select('tmpl_id, alias').limit(5000),
  ]);
  return {
    header: mapHeader(c),
    items: items.map(i => ({
      tmplId: i.tmpl_id, productId: i.product_id ?? null, sku: i.sku ?? null, name: i.name, nameVi: i.name_vi ?? null, uom: i.uom ?? '',
      type: i.type ?? 'dry', sub: i.sub ?? 'other', packs: Array.isArray(i.packs) ? i.packs : [],
      brands: Array.isArray(i.brands) ? i.brands.filter((b: any) => typeof b === 'string' && b.trim()) : [], price: null,
    })),
    lines: (lines ?? []).map((l: any) => ({ tmplId: l.tmpl_id, inScope: !!l.in_scope, qty: l.qty == null ? null : Number(l.qty), entry: l.entry ?? null,
      notFound: !!l.not_found, countedAt: l.counted_at, countedBy: l.counted_by_name })),
    unknowns: (unk ?? []).map((u: any) => ({ id: u.id, photoUrl: u.photo_url, qty: u.qty == null ? null : Number(u.qty), unit: u.unit, note: u.note, zone: u.zone,
      createdBy: u.created_by_name, createdAt: u.created_at, status: u.status, tmplId: u.tmpl_id })),
    aliases: (al ?? []).map((r: any) => [Number(r.tmpl_id), String(r.alias)] as [number, string]),
  };
}

// One saved line (debounced on the phone). The count time is the FIRST time it was counted: a typo
// fixed later does not move it. qty null + notFound false = back to "not counted".
export async function saveCountLineAction(countId: string, tmplId: number, v: { qty: number | null; entry?: any; notFound?: boolean })
  : Promise<{ ok?: boolean; countedAt?: string | null; error?: string }> {
  const a = await rawActor();
  if (!canCount(a)) return { error: 'Forbidden' };
  const db = rawService(); if (!db) return { error: 'Server not configured' };
  if (v.qty != null && (!Number.isFinite(v.qty) || v.qty < 0 || v.qty > 1e7)) return { error: 'Số lượng không hợp lệ / Quantité invalide' };
  const { data: c } = await db.from('lab_stock_counts').select('status').eq('id', countId).maybeSingle();
  if (!c) return { error: 'Not found' };
  if (c.status !== 'draft') return { error: 'Đã gửi / Déjà envoyé' };
  const { data: prev } = await db.from('lab_stock_count_lines').select('id, counted_at').eq('count_id', countId).eq('tmpl_id', tmplId).maybeSingle();
  const counted = v.qty != null || !!v.notFound;
  const countedAt = counted ? (prev?.counted_at ?? new Date().toISOString()) : null;
  const row: any = { qty: v.qty, entry: v.entry ?? null, not_found: !!v.notFound, counted_at: countedAt, counted_by_name: counted ? (a.name || null) : null, updated_at: new Date().toISOString() };
  if (prev) {
    const { error } = await db.from('lab_stock_count_lines').update(row).eq('id', prev.id);
    if (error) return { error: error.message };
  } else {
    const { data: m } = await db.from('lab_raw_materials').select('product_id').eq('tmpl_id', tmplId).maybeSingle();
    const { error } = await db.from('lab_stock_count_lines').insert({ ...row, count_id: countId, tmpl_id: tmplId, product_id: m?.product_id ?? null, in_scope: false });
    if (error) return { error: error.message };
  }
  return { ok: true, countedAt };
}

// "Je ne trouve pas": photo + quantity + a word; the assistant puts the SKU later.
export async function addUnknownAction(form: FormData): Promise<{ unknown?: Unknown; error?: string }> {
  const a = await rawActor();
  if (!canCount(a)) return { error: 'Forbidden' };
  const db = rawService(); if (!db) return { error: 'Server not configured' };
  const countId = String(form.get('countId') ?? '');
  const file = form.get('file');
  const qtyRaw = String(form.get('qty') ?? '').replace(',', '.');
  const qty = qtyRaw ? Number(qtyRaw) : null;
  if (qty != null && (!Number.isFinite(qty) || qty < 0)) return { error: 'Số lượng không hợp lệ / Quantité invalide' };
  const { data: c } = await db.from('lab_stock_counts').select('status').eq('id', countId).maybeSingle();
  if (!c || c.status !== 'draft') return { error: 'Not found' };
  let path: string | null = null, url: string | null = null;
  if (file instanceof Blob && file.size > 0) {
    if (file.size > 8_000_000) return { error: 'Ảnh quá lớn / Photo trop lourde' };
    path = `inventory/unknown/${countId}/${Date.now()}.jpg`;
    const { error } = await db.storage.from('lab-images').upload(path, Buffer.from(await file.arrayBuffer()), { contentType: 'image/jpeg', upsert: true });
    if (error) return { error: error.message };
    url = db.storage.from('lab-images').getPublicUrl(path).data.publicUrl;
  }
  const { data: u, error } = await db.from('lab_stock_count_unknowns').insert({
    count_id: countId, photo_path: path, photo_url: url, qty, unit: String(form.get('unit') ?? '') || null,
    note: String(form.get('note') ?? '').slice(0, 200) || null, zone: String(form.get('zone') ?? '') || null, created_by_name: a.name || null,
  }).select('*').single();
  if (error || !u) return { error: error?.message ?? 'Insert failed' };
  return { unknown: { id: u.id, photoUrl: u.photo_url, qty: u.qty == null ? null : Number(u.qty), unit: u.unit, note: u.note, zone: u.zone, createdBy: u.created_by_name, createdAt: u.created_at, status: u.status, tmplId: null } };
}

// The assistant puts the SKU on a photo: its quantity (in the product unit) is ADDED to the product's
// line at the photo's time, the team's word becomes a search name, and the photo becomes the product
// photo when it had none (app + Odoo).
export async function resolveUnknownAction(unknownId: string, v: { status: 'matched' | 'absent' | 'ignored'; tmplId?: number; qty?: number; usePhoto?: boolean })
  : Promise<{ ok?: boolean; error?: string }> {
  const a = await rawActor();
  if (!canCount(a)) return { error: 'Forbidden' };
  const db = rawService(); if (!db) return { error: 'Server not configured' };
  const { data: u } = await db.from('lab_stock_count_unknowns').select('*').eq('id', unknownId).maybeSingle();
  if (!u) return { error: 'Not found' };
  if (u.status !== 'open') return { error: 'Đã xử lý / Déjà traité' };
  const now = new Date().toISOString();
  if (v.status === 'matched') {
    if (!v.tmplId || v.qty == null || !Number.isFinite(v.qty) || v.qty < 0) return { error: 'Produit et quantité requis' };
    const { data: line } = await db.from('lab_stock_count_lines').select('id, qty, counted_at').eq('count_id', u.count_id).eq('tmpl_id', v.tmplId).maybeSingle();
    if (line) {
      await db.from('lab_stock_count_lines').update({ qty: Number(line.qty ?? 0) + v.qty, not_found: false, counted_at: line.counted_at ?? u.created_at, counted_by_name: u.created_by_name, updated_at: now }).eq('id', line.id);
    } else {
      const { data: m } = await db.from('lab_raw_materials').select('product_id').eq('tmpl_id', v.tmplId).maybeSingle();
      await db.from('lab_stock_count_lines').insert({ count_id: u.count_id, tmpl_id: v.tmplId, product_id: m?.product_id ?? null, in_scope: false,
        qty: v.qty, counted_at: u.created_at, counted_by_name: u.created_by_name });
    }
    const alias = (u.note ?? '').trim();
    if (alias.length >= 2) await db.from('lab_raw_aliases').insert({ tmpl_id: v.tmplId, alias, created_by_name: a.name || null }).then(() => null, () => null);
    if (v.usePhoto !== false && u.photo_path) {
      const { data: has } = await db.from('lab_item_photos').select('tmpl_id').eq('tmpl_id', v.tmplId).maybeSingle();
      if (!has) {
        const { data: blob } = await db.storage.from('lab-images').download(u.photo_path);
        const { data: m } = await db.from('lab_raw_materials').select('sku').eq('tmpl_id', v.tmplId).maybeSingle();
        if (blob) {
          const res = await addItemPhoto({ tmplId: v.tmplId, sku: m?.sku ?? null, data: Buffer.from(await blob.arrayBuffer()), byName: a.name || 'staff' });
          if (res.ok) { revalidateTag('item-photos'); const p = res.odoo(); try { waitUntil(p); } catch { await p; } }
        }
      }
    }
  }
  await db.from('lab_stock_count_unknowns').update({ status: v.status, tmpl_id: v.tmplId ?? null, resolved_qty: v.qty ?? null, resolved_by_name: a.name || null, resolved_at: now }).eq('id', unknownId);
  return { ok: true };
}

export type RecapLine = { tmplId: number; qty: number; theoretical: number; diff: number; value: number | null; alert: 'unit' | null };

// Recap: theoretical of every counted line at its own count time (Odoo read, once per recap).
export async function recapCountAction(countId: string): Promise<{ lines?: RecapLine[]; error?: string }> {
  const a = await rawActor();
  if (!canCount(a)) return { error: 'Forbidden' };
  const db = rawService(); if (!db) return { error: 'Server not configured' };
  const { data: ls } = await db.from('lab_stock_count_lines').select('id, tmpl_id, product_id, qty, counted_at').eq('count_id', countId).not('qty', 'is', null).limit(3000);
  const lines = (ls ?? []).filter((l: any) => l.product_id && l.counted_at);
  let theo: Record<number, number>;
  try { theo = await theoreticals(lines.map((l: any) => ({ productId: l.product_id, countedAt: new Date(l.counted_at) }))); }
  catch (e: any) { return { error: `Odoo: ${String(e?.message ?? e).slice(0, 200)}` }; }
  let priceBy = new Map<number, number>();
  try { priceBy = await productCosts(lines.map((l: any) => l.product_id)); } catch { /* value column stays empty */ }
  const out: RecapLine[] = lines.map((l: any) => {
    const t = theo[l.product_id] ?? 0, q = Number(l.qty);
    const ratio = t > 0 && q > 0 ? q / t : 1;
    const alert = t > 0.5 && q > 0 && (ratio >= 8 || ratio <= 1 / 8) ? 'unit' as const : null;
    const price = priceBy.get(l.product_id);
    return { tmplId: l.tmpl_id, qty: q, theoretical: t, diff: q - t, value: price != null ? Math.round((q - t) * price) : null, alert };
  });
  await Promise.all(lines.map((l: any) => db.from('lab_stock_count_lines').update({ theoretical: theo[l.product_id] ?? 0 }).eq('id', l.id)));
  return { lines: out };
}

// Send: one draft count sheet in Odoo (never applied here). Blocked while photos remain to identify.
export async function submitCountAction(countId: string): Promise<{ ok?: boolean; inventoryId?: number; lines?: number; error?: string }> {
  const a = await rawActor();
  if (!canCount(a)) return { error: 'Forbidden' };
  const db = rawService(); if (!db) return { error: 'Server not configured' };
  const { data: c } = await db.from('lab_stock_counts').select('*').eq('id', countId).maybeSingle();
  if (!c) return { error: 'Not found' };
  if (c.status !== 'draft') return { error: 'Đã gửi / Déjà envoyé' };
  const { count: open } = await db.from('lab_stock_count_unknowns').select('*', { count: 'exact', head: true }).eq('count_id', countId).eq('status', 'open');
  if (open) return { error: `Còn ${open} ảnh cần xác định / Encore ${open} photo(s) à identifier` };
  const { data: ls } = await db.from('lab_stock_count_lines').select('id, tmpl_id, product_id, qty, counted_at').eq('count_id', countId).not('qty', 'is', null).limit(3000);
  const lines = (ls ?? []).filter((l: any) => l.product_id && l.counted_at);
  if (!lines.length) return { error: 'Aucune ligne comptée' };
  // one row per product (two catalogue entries can share an Odoo product): sum, earliest count time
  const byP = new Map<number, { qty: number; at: number; ids: string[] }>();
  for (const l of lines) {
    const t = Date.parse(l.counted_at), cur = byP.get(l.product_id);
    if (cur) { cur.qty += Number(l.qty); cur.at = Math.min(cur.at, t); cur.ids.push(l.id); }
    else byP.set(l.product_id, { qty: Number(l.qty), at: t, ids: [l.id] });
  }
  const entries = Array.from(byP.entries());
  let theo: Record<number, number>;
  try { theo = await theoreticals(entries.map(([pid, v]) => ({ productId: pid, countedAt: new Date(v.at) }))); }
  catch (e: any) { return { error: `Odoo: ${String(e?.message ?? e).slice(0, 200)}` }; }
  const label = c.kind === 'raw' ? 'Nguyên liệu (NVL)' : 'Bao bì (Packaging)';
  const res = await createDraftSheet({
    name: `Kiểm kê LAB — ${c.count_date} — ${label}`, countDate: c.count_date,
    firstCountAt: new Date(Math.min(...entries.map(([, v]) => v.at))),
    lines: entries.map(([pid, v]) => ({ productId: pid, theoretical: theo[pid] ?? 0, counted: Math.round(v.qty * 100000) / 100000 })),
  });
  if (!res.ok) {
    await db.from('lab_stock_counts').update({ push_status: 'error', push_error: res.error, updated_at: new Date().toISOString() }).eq('id', countId);
    return { error: res.error };
  }
  await Promise.all(entries.flatMap(([pid, v]) => v.ids.map(id =>
    db.from('lab_stock_count_lines').update({ theoretical: theo[pid] ?? 0, odoo_line_id: res.lineIds[pid] ?? null }).eq('id', id))));
  await db.from('lab_stock_counts').update({ status: 'submitted', submitted_at: new Date().toISOString(), submitted_by_name: a.name || null,
    odoo_inventory_id: res.inventoryId, push_status: 'success', push_error: null, updated_at: new Date().toISOString() }).eq('id', countId);
  return { ok: true, inventoryId: res.inventoryId, lines: entries.length };
}

// ---- Photos missing before an inventory (Axel, 2026-11-09) --------------------------------------
export type PhotoTodo = { tmplId: number; sku: string | null; name: string; nameVi: string | null; kind: CountKind; type: string; sub: string; status: 'open' | 'not_in_stock' | null };

// Items of the open counts' lists (or, without an open count, of both catalogues) that have no photo.
export async function missingPhotosAction(): Promise<{ items?: PhotoTodo[]; requested?: boolean; error?: string }> {
  const a = await rawActor();
  if (!canCount(a)) return { error: 'Forbidden' };
  const db = rawService(); if (!db) return { error: 'Server not configured' };
  const [{ data: mats }, { data: photos }, { data: reqs }, { data: drafts }] = await Promise.all([
    db.from('lab_raw_materials').select('tmpl_id, sku, name, name_vi, kind, type, sub').in('kind', ['raw', 'packaging']).eq('active', true).limit(3000),
    db.from('lab_item_photos').select('tmpl_id').limit(5000),
    db.from('lab_photo_requests').select('tmpl_id, status').limit(5000),
    db.from('lab_stock_counts').select('id').eq('status', 'draft'),
  ]);
  const has = new Set((photos ?? []).map((p: any) => Number(p.tmpl_id)));
  const st = new Map<number, string>((reqs ?? []).map((r: any) => [Number(r.tmpl_id), r.status]));
  let inScope: Set<number> | null = null;
  if (drafts?.length) {
    const { data: ls } = await db.from('lab_stock_count_lines').select('tmpl_id').in('count_id', drafts.map((d: any) => d.id)).eq('in_scope', true).limit(5000);
    inScope = new Set((ls ?? []).map((l: any) => Number(l.tmpl_id)));
  }
  const items = (mats ?? []).filter((m: any) => !has.has(m.tmpl_id) && (!inScope || inScope.has(m.tmpl_id)))
    .map((m: any) => ({ tmplId: m.tmpl_id, sku: m.sku ?? null, name: m.name, nameVi: m.name_vi ?? null, kind: m.kind, type: m.type ?? 'dry', sub: m.sub ?? 'other',
      status: (st.get(m.tmpl_id) as any) ?? null }));
  return { items, requested: items.some(i => i.status) };
}

// "Demander": every missing photo becomes a request; purchasing (storage) gets a push.
export async function requestPhotosAction(tmplIds: number[]): Promise<{ ok?: boolean; error?: string }> {
  const a = await rawActor();
  if (!canCount(a)) return { error: 'Forbidden' };
  const db = rawService(); if (!db) return { error: 'Server not configured' };
  const now = new Date().toISOString();
  const rows = tmplIds.filter(Number.isInteger).map(t => ({ tmpl_id: t, status: 'open', requested_at: now, requested_by_name: a.name || null, updated_at: now }));
  for (let k = 0; k < rows.length; k += 500) await db.from('lab_photo_requests').upsert(rows.slice(k, k + 500), { onConflict: 'tmpl_id' });
  const ids = await purchasingUserIds(db);
  await awaitPush(sendUsersPush(db, ids,
    { title: 'La Parisienne Lab', body: `📷 ${rows.length} sản phẩm chưa có ảnh — chụp trước kiểm kê`, url: '/inventory/photos', tag: 'photo-requests' },
    { title: 'La Parisienne Lab', body: `📷 ${rows.length} items without a photo — take them before the inventory`, url: '/inventory/photos', tag: 'photo-requests' }));
  return { ok: true };
}

export async function setPhotoStatusAction(tmplId: number, status: 'open' | 'not_in_stock'): Promise<{ ok?: boolean; error?: string }> {
  const a = await rawActor();
  if (!canCount(a)) return { error: 'Forbidden' };
  const db = rawService(); if (!db) return { error: 'Server not configured' };
  const { error } = await db.from('lab_photo_requests').upsert({ tmpl_id: tmplId, status, updated_at: new Date().toISOString(), updated_by_name: a.name || null }, { onConflict: 'tmpl_id' });
  return error ? { error: error.message } : { ok: true };
}
