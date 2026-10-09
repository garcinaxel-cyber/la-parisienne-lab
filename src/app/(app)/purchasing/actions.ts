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

export type DraftPo = { id: number; name: string; vendorId: number | null; vendorName: string | null; state: string; amountTotal: number };
export type Board = {
  lines: PurchaseLine[]; vendors: { id: number; name: string }[];
  catalogue: { tmplId: number; name: string; sku: string | null; uom: string; vendorIds: number[] }[];
  drafts: DraftPo[];
};

// Phase 2 (Axel, 2026-10-09): follow the draft POs created from the app. Confirmed in Odoo ->
// the lines become 'ordered'; cancelled -> back to the queue; still a draft -> vendor/amount refreshed.
// Best effort: if Odoo cannot be read, the board simply shows what it knew.
async function refreshDraftPos(db: NonNullable<ReturnType<typeof rawService>>): Promise<DraftPo[]> {
  const { data: rows } = await db.from('lab_purchase_request_lines').select('id, po_odoo_id').eq('status', 'pending').not('po_odoo_id', 'is', null).limit(2000);
  const poIds = Array.from(new Set((rows ?? []).map(r => Number(r.po_odoo_id))));
  if (!poIds.length) return [];
  let pos: any[] = [];
  try {
    pos = await odooExecute<any[]>('purchase.order', 'search_read', [[['id', 'in', poIds]]],
      { fields: ['id', 'name', 'state', 'partner_id', 'amount_total', 'date_approve'], context: { active_test: false } });
  } catch { return []; }
  const byId = new Map(pos.map(p => [p.id, p]));
  const drafts: DraftPo[] = [];
  for (const id of poIds) {
    const p = byId.get(id);
    if (!p || p.state === 'cancel') {
      // Gone or cancelled in Odoo: the lines go back to the purchasing queue.
      await db.from('lab_purchase_request_lines').update({ po_odoo_id: null, po_ref: null, po_created_at: null, po_created_by_name: null })
        .eq('po_odoo_id', id).eq('status', 'pending');
      continue;
    }
    if (p.state === 'purchase' || p.state === 'done') {
      await db.from('lab_purchase_request_lines').update({
        status: 'ordered', po_ref: p.name, ordered_at: p.date_approve || new Date().toISOString(), ordered_by_name: 'Odoo',
        ...(p.partner_id ? { vendor_id: p.partner_id[0], vendor_name: p.partner_id[1] } : {}),
      }).eq('po_odoo_id', id).eq('status', 'pending');
      continue;
    }
    drafts.push({ id, name: p.name, vendorId: p.partner_id ? p.partner_id[0] : null, vendorName: p.partner_id ? p.partner_id[1] : null, state: p.state, amountTotal: Number(p.amount_total) || 0 });
  }
  return drafts;
}

export async function getPurchasingBoardAction(): Promise<{ data?: Board; error?: string }> {
  const g = await guard();
  if (!g) return { error: 'Forbidden' };
  try {
    const drafts = await refreshDraftPos(g.db);
    const lines = await loadLines(g.db, q => q.eq('status', 'pending').order('created_at', { ascending: true }));
    const { data: mats } = await g.db.from('lab_raw_materials').select('tmpl_id, name, sku, uom, vendors').eq('active', true).order('name').limit(3000);
    const vend = new Map<number, string>();
    for (const m of mats ?? []) for (const v of (m.vendors as any[]) ?? []) if (v?.id && !vend.has(v.id)) vend.set(v.id, v.name);
    return { data: {
      lines,
      vendors: Array.from(vend.entries()).map(([id, name]) => ({ id, name })).sort((x, y) => x.name.localeCompare(y.name)),
      catalogue: (mats ?? []).map(m => ({ tmplId: m.tmpl_id, name: m.name, sku: m.sku, uom: m.uom, vendorIds: ((m.vendors as any[]) ?? []).map(v => Number(v?.id)).filter(Boolean) })),
      drafts,
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
    // How many active Odoo BOM lines use each raw material (Axel, 2026-10-09: off-recipe alert at the
    // station). Best effort: if Odoo refuses, the counts already stored stay as they are.
    let bomByProduct: Map<number, number> | null = new Map();
    try {
      for (let off = 0; off < 20000; off += 2000) {
        const ls = await odooExecute<any[]>('mrp.bom.line', 'search_read', [[['product_id.categ_id', '=', RAW_MATERIAL_CATEG_ID], ['bom_id.active', '=', true]]],
          { fields: ['product_id'], limit: 2000, offset: off });
        for (const l of ls) { const pid = l.product_id?.[0]; if (pid) bomByProduct.set(pid, (bomByProduct.get(pid) ?? 0) + 1); }
        if (ls.length < 2000) break;
      }
    } catch { bomByProduct = null; }
    const bomOf = (t: any) => (bomByProduct ? { bom_count: bomByProduct.get(t.product_variant_id?.[0]) ?? 0 } : {});
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
          active: true, synced_at: now, ...bomOf(t) };
      });
      if (fresh.length) { const { error } = await g.db.from('lab_raw_materials').insert(fresh); if (error) return { error: error.message }; added += fresh.length; }
      for (const t of chunk.filter(t => have.has(t.id))) {
        const vend = vendorsByTmpl.get(t.id) ?? [];
        const { error } = await g.db.from('lab_raw_materials').update({
          product_id: t.product_variant_id?.[0] ?? null, sku: t.default_code || null, name: String(t.name).trim(), uom: normUom(t.uom_id?.[1] ?? 'kg'),
          ...(viName.has(t.id) ? { name_vi: viName.get(t.id) } : {}),
          purchased: Number(t.purchased_product_qty) > 0, vendor_id: vend[0]?.id ?? null, vendor_name: vend[0]?.name ?? null, vendors: vend,
          active: true, synced_at: now, ...bomOf(t),
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

export async function updateMaterialAction(tmplId: number, patch: { type?: string; sub?: string; visible?: boolean; checked?: boolean; packs?: RawPack[]; noRecipeNeeded?: boolean }) {
  const g = await guard();
  if (!g) return { error: 'Forbidden' };
  const p: Record<string, unknown> = { updated_at: new Date().toISOString(), updated_by_name: g.a.name || null };
  if (patch.type && ['dry', 'fresh', 'frozen'].includes(patch.type)) p.type = patch.type;
  if (typeof patch.sub === 'string' && /^[a-z]{2,12}$/.test(patch.sub)) p.sub = patch.sub;
  if (typeof patch.visible === 'boolean') p.visible = patch.visible;
  if (typeof patch.checked === 'boolean') p.checked = patch.checked;
  if (typeof patch.noRecipeNeeded === 'boolean') p.no_recipe_needed = patch.noRecipeNeeded;
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


// Phase 2 (Axel, 2026-10-09): one draft purchase order in Odoo for the lines the assistant ticked —
// any lines, whatever vendor the app suggested ("le deuxième produit peut s'acheter chez le même
// fournisseur"). The vendor is optional: Odoo saves a PO without one; it just must not be confirmed
// without one (the assistant confirms in Odoo). Same product twice -> one PO line, quantities summed.
// Price, taxes and planned date are left to Odoo (vendor price list). Never confirms anything.
export async function createDraftPoAction(lineIds: string[], vendorId: number | null): Promise<{ ok?: boolean; poName?: string; error?: string }> {
  const g = await guard();
  if (!g) return { error: 'Forbidden' };
  const want = ids(lineIds);
  if (!want.length) return { error: 'Empty' };
  const { data: ls, error } = await g.db.from('lab_purchase_request_lines')
    .select('id, request_id, tmpl_id, name, uom, qty, brand, brand_strict, note, status, po_odoo_id').in('id', want);
  if (error) return { error: error.message };
  const lines = (ls ?? []).filter(l => l.status === 'pending' && !l.po_odoo_id && l.tmpl_id);
  if (!lines.length) return { error: 'Không có dòng hợp lệ (đã có PO hoặc sản phẩm chưa có trong Odoo)' };
  const tmplIds = Array.from(new Set(lines.map(l => l.tmpl_id)));
  const { data: mats } = await g.db.from('lab_raw_materials').select('tmpl_id, product_id').in('tmpl_id', tmplIds);
  const productOf = new Map((mats ?? []).map(m => [m.tmpl_id, m.product_id as number | null]));
  if (lines.some(l => !productOf.get(l.tmpl_id))) return { error: 'Sản phẩm chưa đồng bộ với Odoo — bấm "Đồng bộ" trong Danh mục' };
  const reqIds = Array.from(new Set(lines.map(l => l.request_id)));
  const { data: reqs } = await g.db.from('lab_purchase_requests').select('id, no, team').in('id', reqIds);
  const reqNo = new Map((reqs ?? []).map(r => [r.id, r]));
  try {
    const productIds = Array.from(new Set(lines.map(l => productOf.get(l.tmpl_id)!)));
    const prods = await odooExecute<any[]>('product.product', 'read', [productIds, ['display_name', 'uom_id']], { context: { lang: 'vi_VN' } });
    const prodById = new Map(prods.map(p => [p.id, p]));
    // One PO line per product.
    const byProduct = new Map<number, { qty: number; notes: string[] }>();
    for (const l of lines) {
      const pid = productOf.get(l.tmpl_id)!;
      const e = byProduct.get(pid) ?? { qty: 0, notes: [] };
      e.qty += Number(l.qty);
      const r: any = reqNo.get(l.request_id);
      const bits = [l.brand ? `${l.brand}${l.brand_strict ? ' (bắt buộc)' : ' (nếu có)'}` : '', l.note ?? ''].filter(Boolean).join(' · ');
      e.notes.push(`#${r?.no ?? '?'}${r?.team ? ` ${r.team}` : ''}: ${Number(l.qty)} ${l.uom}${bits ? ` — ${bits}` : ''}`);
      byProduct.set(pid, e);
    }
    const orderLines = Array.from(byProduct.entries()).map(([pid, e]) => {
      const p = prodById.get(pid);
      return [0, 0, {
        product_id: pid, product_qty: Math.round(e.qty * 1000) / 1000,
        ...(p?.uom_id ? { product_uom: p.uom_id[0] } : {}),
        name: [p?.display_name ?? '', ...e.notes].filter(Boolean).join('\n'),
      }];
    });
    const origin = 'App ' + Array.from(new Set((reqs ?? []).map(r => `#${r.no}`))).join(' ');
    const poId = await odooExecute<number>('purchase.order', 'create', [{
      ...(vendorId ? { partner_id: vendorId } : {}), origin: origin.slice(0, 120), order_line: orderLines,
    }]);
    const [po] = await odooExecute<any[]>('purchase.order', 'read', [[poId], ['name', 'partner_id']]);
    const now = new Date().toISOString();
    const { error: uErr } = await g.db.from('lab_purchase_request_lines').update({
      po_odoo_id: poId, po_ref: po?.name ?? null, po_created_at: now, po_created_by_name: g.a.name || null,
      ...(po?.partner_id ? { vendor_id: po.partner_id[0], vendor_name: po.partner_id[1] } : {}),
    }).in('id', lines.map(l => l.id)).eq('status', 'pending');
    if (uErr) return { error: `PO ${po?.name ?? poId} đã tạo trên Odoo nhưng chưa lưu được vào app: ${uErr.message}` };
    return { ok: true, poName: po?.name ?? String(poId) };
  } catch (e: any) {
    return { error: e?.message ?? 'Odoo error' };
  }
}
