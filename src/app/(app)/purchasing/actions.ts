'use server';
// Purchasing space (Axel, 2026-10-08) — role 'purchasing' (storage manager + purchasing assistant) and
// admin. Phase 1: everything stays in the app; Odoo is only read (catalogue sync). The assistant still
// creates the purchase order in Odoo by hand and types its number here.
import { rawService, rawActor, isPurchasing, mapMaterial, loadLines, loadWithdrawals } from '@/lib/raw-materials-db';
import { classifyRaw, parsePacks, type RawMaterial, type PurchaseLine, type Withdrawal, type RawPack } from '@/lib/raw-materials';
import { labDayUtcRange, odooExecute } from '@/lib/odoo';

async function guard() {
  const a = await rawActor();
  if (!isPurchasing(a)) return null;
  const db = rawService();
  if (!db) return null;
  return { a, db };
}
const ids = (v: unknown) => (Array.isArray(v) ? v : []).map(String).filter(Boolean).slice(0, 500);

export type Board = { lines: PurchaseLine[]; vendors: { id: number; name: string }[]; catalogue: { tmplId: number; name: string; sku: string | null; uom: string }[] };

export async function getPurchasingBoardAction(): Promise<{ data?: Board; error?: string }> {
  const g = await guard();
  if (!g) return { error: 'Forbidden' };
  try {
    const lines = await loadLines(g.db, q => q.eq('status', 'pending').order('created_at', { ascending: true }));
    const { data: mats } = await g.db.from('lab_raw_materials').select('tmpl_id, name, sku, uom, vendors').eq('active', true).order('name').limit(3000);
    const vend = new Map<number, string>();
    for (const m of mats ?? []) for (const v of (m.vendors as any[]) ?? []) if (v?.id && !vend.has(v.id)) vend.set(v.id, v.name);
    return { data: {
      lines,
      vendors: Array.from(vend.entries()).map(([id, name]) => ({ id, name })).sort((x, y) => x.name.localeCompare(y.name)),
      catalogue: (mats ?? []).map(m => ({ tmplId: m.tmpl_id, name: m.name, sku: m.sku, uom: m.uom })),
    } };
  } catch (e: any) { return { error: e.message }; }
}

export async function setVendorAction(lineIds: string[], vendorId: number | null, vendorName: string | null) {
  const g = await guard();
  if (!g) return { error: 'Forbidden' };
  const { error } = await g.db.from('lab_purchase_request_lines').update({ vendor_id: vendorId, vendor_name: vendorId ? vendorName : null })
    .in('id', ids(lineIds)).eq('status', 'pending');
  return error ? { error: error.message } : { ok: true };
}

export async function markOrderedAction(lineIds: string[], poRef: string) {
  const g = await guard();
  if (!g) return { error: 'Forbidden' };
  const { error } = await g.db.from('lab_purchase_request_lines')
    .update({ status: 'ordered', po_ref: String(poRef ?? '').trim().slice(0, 40) || null, ordered_at: new Date().toISOString(), ordered_by_name: g.a.name || null })
    .in('id', ids(lineIds)).eq('status', 'pending');
  return error ? { error: error.message } : { ok: true };
}

// Undo a wrong tap: ordered or cancelled -> back to pending. ('received' is not used for now —
// Axel, 2026-10-08: deliveries are confirmed long after the real delivery, to be solved later.)
export async function undoLineStepAction(lineId: string) {
  const g = await guard();
  if (!g) return { error: 'Forbidden' };
  const { data: l } = await g.db.from('lab_purchase_request_lines').select('status').eq('id', lineId).maybeSingle();
  if (!l) return { error: 'Not found' };
  const patch = l.status === 'received' ? { status: 'ordered', received_at: null, received_by_name: null }
    : l.status === 'ordered' ? { status: 'pending', po_ref: null, ordered_at: null, ordered_by_name: null }
    : l.status === 'cancelled' ? { status: 'pending', cancelled_at: null, cancelled_by_name: null } : null;
  if (!patch) return { ok: true };
  const { error } = await g.db.from('lab_purchase_request_lines').update(patch).eq('id', lineId);
  return error ? { error: error.message } : { ok: true };
}

export async function cancelLinesAction(lineIds: string[]) {
  const g = await guard();
  if (!g) return { error: 'Forbidden' };
  const { error } = await g.db.from('lab_purchase_request_lines')
    .update({ status: 'cancelled', cancelled_at: new Date().toISOString(), cancelled_by_name: g.a.name || null })
    .in('id', ids(lineIds)).in('status', ['pending', 'ordered']);
  return error ? { error: error.message } : { ok: true };
}

// A chef's "new product" turns out to exist already: the line becomes a normal line on that product.
export async function linkNewProductAction(lineId: string, tmplId: number) {
  const g = await guard();
  if (!g) return { error: 'Forbidden' };
  const { data: m } = await g.db.from('lab_raw_materials').select('tmpl_id, sku, name, uom, vendor_id, vendor_name').eq('tmpl_id', tmplId).maybeSingle();
  if (!m) return { error: 'Unknown raw material' };
  const { data: l } = await g.db.from('lab_purchase_request_lines').select('name, note').eq('id', lineId).maybeSingle();
  if (!l) return { error: 'Not found' };
  const note = [`Chef: ${l.name}`, l.note].filter(Boolean).join(' · ').slice(0, 400);
  const { error } = await g.db.from('lab_purchase_request_lines').update({
    tmpl_id: m.tmpl_id, sku: m.sku, name: m.name, uom: m.uom, note, new_state: 'linked', vendor_id: m.vendor_id, vendor_name: m.vendor_name,
  }).eq('id', lineId);
  return error ? { error: error.message } : { ok: true };
}

export async function markNewToCreateAction(lineId: string) {
  const g = await guard();
  if (!g) return { error: 'Forbidden' };
  const { error } = await g.db.from('lab_purchase_request_lines').update({ new_state: 'to_create' }).eq('id', lineId).eq('is_new', true);
  return error ? { error: error.message } : { ok: true };
}

export async function getWithdrawalsDayAction(date: string): Promise<{ items?: Withdrawal[]; error?: string }> {
  const g = await guard();
  if (!g) return { error: 'Forbidden' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: 'Bad date' };
  const { start, end } = labDayUtcRange(date);
  try {
    return { items: await loadWithdrawals(g.db, q => q.gte('created_at', start).lt('created_at', end).order('created_at', { ascending: false })) };
  } catch (e: any) { return { error: e.message }; }
}

export async function correctWithdrawalLineAction(lineId: string, qty: number | null) {
  const g = await guard();
  if (!g) return { error: 'Forbidden' };
  const v = qty == null ? null : Math.max(0, Math.round(Number(qty) * 1000) / 1000);
  const { error } = await g.db.from('lab_raw_withdrawal_lines').update(v == null
    ? { corrected_qty: null, corrected_by_name: null, corrected_at: null }
    : { corrected_qty: v, corrected_by_name: g.a.name || null, corrected_at: new Date().toISOString() }).eq('id', lineId);
  return error ? { error: error.message } : { ok: true };
}

// History: every line created in the given lab-local month ('YYYY-MM'), all statuses.
export async function getHistoryAction(month: string): Promise<{ items?: PurchaseLine[]; error?: string }> {
  const g = await guard();
  if (!g) return { error: 'Forbidden' };
  if (!/^\d{4}-\d{2}$/.test(month)) return { error: 'Bad month' };
  const [y, m] = month.split('-').map(Number);
  const start = labDayUtcRange(`${month}-01`).start;
  const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  const end = labDayUtcRange(next).start;
  try {
    // Lines still waiting for the team lead, or turned down by him, never reached purchasing.
    return { items: await loadLines(g.db, q => q.gte('created_at', start).lt('created_at', end).neq('status', 'to_approve').eq('rejected_by_lead', false).order('created_at', { ascending: false })) };
  } catch (e: any) { return { error: e.message }; }
}

// ---------------- catalogue ----------------
export async function getCatalogueAction(): Promise<{ items?: RawMaterial[]; syncedAt?: string | null; error?: string }> {
  const g = await guard();
  if (!g) return { error: 'Forbidden' };
  const { data, error } = await g.db.from('lab_raw_materials').select('*').eq('active', true).order('name').limit(3000);
  if (error) return { error: error.message };
  const syncedAt = (data ?? []).reduce<string | null>((mx, r: any) => (!mx || r.synced_at > mx ? r.synced_at : mx), null);
  return { items: (data ?? []).map(mapMaterial), syncedAt };
}

const RAW_MATERIAL_CATEG_ID = 18; // Odoo "All / Raw Material (nguyên liệu)" — packaging is a separate category, left out on purpose

export async function syncCatalogueAction(): Promise<{ added?: number; updated?: number; removed?: number; error?: string }> {
  const g = await guard();
  if (!g) return { error: 'Forbidden' };
  try {
    const tmpls = await odooExecute<any[]>('product.template', 'search_read', [[['categ_id', '=', RAW_MATERIAL_CATEG_ID], ['active', '=', true]]],
      { fields: ['id', 'default_code', 'name', 'uom_id', 'purchased_product_qty', 'product_variant_id'], limit: 3000 });
    const tmplIds = tmpls.map(t => t.id);
    // Vietnamese names (Odoo vi_VN translation) for the chefs' screen. Never blocks the sync.
    const viName = new Map<number, string>();
    try {
      for (let i = 0; i < tmplIds.length; i += 300) {
        const rows = await odooExecute<any[]>('product.template', 'read', [tmplIds.slice(i, i + 300), ['name']], { context: { lang: 'vi_VN' } });
        for (const r of rows) if (r?.name) viName.set(r.id, String(r.name).replace(/\s+/g, ' ').trim());
      }
    } catch { /* keep the names we have */ }
    const vendorsByTmpl = new Map<number, { id: number; name: string }[]>();
    for (let i = 0; i < tmplIds.length; i += 300) {
      const sup = await odooExecute<any[]>('product.supplierinfo', 'search_read', [[['product_tmpl_id', 'in', tmplIds.slice(i, i + 300)]]],
        { fields: ['partner_id', 'product_tmpl_id', 'sequence'], order: 'sequence asc, id asc', limit: 5000 });
      for (const s of sup) {
        const t = s.product_tmpl_id?.[0]; const p = s.partner_id;
        if (!t || !p) continue;
        const arr = vendorsByTmpl.get(t) ?? [];
        if (!arr.some(v => v.id === p[0])) arr.push({ id: p[0], name: p[1] });
        vendorsByTmpl.set(t, arr);
      }
    }
    const { data: existing } = await g.db.from('lab_raw_materials').select('tmpl_id').limit(5000);
    const have = new Set((existing ?? []).map(r => r.tmpl_id));
    const now = new Date().toISOString();
    let added = 0, updated = 0;
    const normUom = (u: string) => (/^unit|^unité|^quả|^cái/i.test(u) ? 'Unit' : u);
    for (let i = 0; i < tmpls.length; i += 200) {
      const chunk = tmpls.slice(i, i + 200);
      const fresh = chunk.filter(t => !have.has(t.id)).map(t => {
        const uom = normUom(t.uom_id?.[1] ?? 'kg'); const vend = vendorsByTmpl.get(t.id) ?? []; const c = classifyRaw(t.name);
        return { tmpl_id: t.id, product_id: t.product_variant_id?.[0] ?? null, sku: t.default_code || null, name: String(t.name).trim(), name_vi: viName.get(t.id) ?? null, uom,
          type: c.type, sub: c.sub, packs: parsePacks(t.name, uom), visible: Number(t.purchased_product_qty) > 0, checked: false,
          purchased: Number(t.purchased_product_qty) > 0, vendor_id: vend[0]?.id ?? null, vendor_name: vend[0]?.name ?? null, vendors: vend,
          active: true, synced_at: now };
      });
      if (fresh.length) { const { error } = await g.db.from('lab_raw_materials').insert(fresh); if (error) return { error: error.message }; added += fresh.length; }
      for (const t of chunk.filter(t => have.has(t.id))) {
        const vend = vendorsByTmpl.get(t.id) ?? [];
        const { error } = await g.db.from('lab_raw_materials').update({
          product_id: t.product_variant_id?.[0] ?? null, sku: t.default_code || null, name: String(t.name).trim(), uom: normUom(t.uom_id?.[1] ?? 'kg'),
          ...(viName.has(t.id) ? { name_vi: viName.get(t.id) } : {}),
          purchased: Number(t.purchased_product_qty) > 0, vendor_id: vend[0]?.id ?? null, vendor_name: vend[0]?.name ?? null, vendors: vend,
          active: true, synced_at: now,
        }).eq('tmpl_id', t.id);
        if (error) return { error: error.message };
        updated++;
      }
    }
    const gone = Array.from(have).filter(id => !tmplIds.includes(id));
    if (gone.length) await g.db.from('lab_raw_materials').update({ active: false, synced_at: now }).in('tmpl_id', gone);
    return { added, updated, removed: gone.length };
  } catch (e: any) { return { error: e?.message ?? 'Odoo error' }; }
}

export async function updateMaterialAction(tmplId: number, patch: { type?: string; sub?: string; visible?: boolean; checked?: boolean; packs?: RawPack[] }) {
  const g = await guard();
  if (!g) return { error: 'Forbidden' };
  const p: Record<string, unknown> = { updated_at: new Date().toISOString(), updated_by_name: g.a.name || null };
  if (patch.type && ['dry', 'fresh', 'frozen'].includes(patch.type)) p.type = patch.type;
  if (typeof patch.sub === 'string' && /^[a-z]{2,12}$/.test(patch.sub)) p.sub = patch.sub;
  if (typeof patch.visible === 'boolean') p.visible = patch.visible;
  if (typeof patch.checked === 'boolean') p.checked = patch.checked;
  if (Array.isArray(patch.packs)) p.packs = patch.packs
    .map(x => ({ label: String(x.label ?? '').trim().slice(0, 30), factor: Number(x.factor) }))
    .filter(x => x.label && x.factor > 0).slice(0, 5);
  const { error } = await g.db.from('lab_raw_materials').update(p).eq('tmpl_id', tmplId);
  return error ? { error: error.message } : { ok: true };
}

export async function checkMaterialsAction(tmplIds: number[]) {
  const g = await guard();
  if (!g) return { error: 'Forbidden' };
  const list = (Array.isArray(tmplIds) ? tmplIds : []).map(Number).filter(Boolean).slice(0, 3000);
  const { error } = await g.db.from('lab_raw_materials').update({ checked: true, updated_at: new Date().toISOString(), updated_by_name: g.a.name || null }).in('tmpl_id', list);
  return error ? { error: error.message } : { ok: true };
}
