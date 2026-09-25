'use server';
import { createClient, getSafeSession } from '@/lib/supabase-server';
import { odooExecute } from '@/lib/odoo';
import { createAndProduceOemMO, resumeOemMO } from '@/lib/odoo-oem-mo';
import { getScrapReasonTags, resolveProductsBySku, createLabScrap, createScrapAtLocation } from '@/lib/odoo-scrap';

// OEM Orders tracker — packaging entries (Axel, 2026-09-25). Assistants record what was packed
// each day (+ scrap). Only lab_mm_* tables are written; Odoo is touched only when the admin
// setting odoo_mo_enabled = 'true':
//   packed          → one MO for the finished SKU (odoo-oem-mo.ts), created + validated at once
//   scrap_finished  → stock.scrap of the finished SKU (faulty bags after packing)
//   scrap_bulk      → nothing in Odoo (the bulk was never an Odoo stock item on its own)

type Kind = 'packed' | 'scrap_bulk' | 'scrap_finished';
const STAFF = ['admin', 'lab_manager', 'assistant'];
const MANAGERS = ['admin', 'lab_manager'];

async function me() {
  const supabase = createClient();
  const { data: { session } } = await getSafeSession(supabase);
  if (!session) return { error: 'Not authenticated' as const };
  const { data: profile } = await supabase.from('profiles').select('role, full_name').eq('id', session.user.id).single();
  const role = profile?.role ?? '';
  if (!STAFF.includes(role)) return { error: 'Forbidden' as const };
  return { supabase, id: session.user.id, name: profile?.full_name ?? '', role };
}

async function odooEnabled(supabase: any): Promise<boolean> {
  const { data } = await supabase.from('lab_mm_settings').select('value').eq('key', 'odoo_mo_enabled').maybeSingle();
  return data?.value === 'true';
}

// kg of bulk used by one entry (bags × unit weight, or kg directly for cashews)
function kgOf(item: { unit: string; unit_weight_g: number }, qty: number) {
  return item.unit === 'kg' ? qty : (qty * Number(item.unit_weight_g)) / 1000;
}

async function bulkAvailableByGroup(supabase: any): Promise<Record<string, number>> {
  const [items, prod, pack] = await Promise.all([
    supabase.from('lab_mm_order_items').select('sku, group_key, unit, unit_weight_g'),
    supabase.from('lab_mm_production_log').select('group_key, weight_kg'),
    supabase.from('lab_mm_packaging_log').select('kind, sku, group_key, qty'),
  ]);
  const bySku: Record<string, any> = {};
  for (const i of items.data ?? []) bySku[i.sku] = i;
  const out: Record<string, number> = {};
  for (const r of prod.data ?? []) out[r.group_key] = (out[r.group_key] ?? 0) + Number(r.weight_kg);
  for (const r of pack.data ?? []) {
    if (r.kind === 'packed' && bySku[r.sku]) out[r.group_key] = (out[r.group_key] ?? 0) - kgOf(bySku[r.sku], Number(r.qty));
    if (r.kind === 'scrap_bulk') out[r.group_key] = (out[r.group_key] ?? 0) - Number(r.qty);
  }
  return out;
}

let brokenTagCache: number[] | null = null;
async function brokenReasonTag(): Promise<number[]> {
  if (brokenTagCache) return brokenTagCache;
  try {
    const tags = await getScrapReasonTags();
    const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    const t = tags.find(x => ['vo', 'hong', 'casse', 'broken', 'damage'].some(k => norm(x.name).includes(k)));
    brokenTagCache = t ? [t.id] : [];
  } catch { brokenTagCache = []; }
  return brokenTagCache;
}

async function pushRowToOdoo(supabase: any, row: any): Promise<{ status: string; ref?: string | null; error?: string | null; moId?: number | null }> {
  if (row.kind === 'scrap_bulk') return { status: 'skipped' };
  if (row.kind === 'packed') {
    const r = row.odoo_mo_id ? await resumeOemMO(Number(row.odoo_mo_id)) : await createAndProduceOemMO(row.sku, Number(row.qty), row.pack_date);
    return { status: r.ok ? 'done' : 'error', ref: r.moName ?? null, error: r.ok ? null : (r.error ?? 'Odoo error'), moId: r.moId ?? row.odoo_mo_id ?? null };
  }
  // scrap_finished — take the bags out of the location where the OEM MOs put them.
  try {
    const prods = await resolveProductsBySku([row.sku]);
    const p = prods[row.sku];
    if (!p) return { status: 'error', error: `SKU ${row.sku} not found in Odoo` };
    const input = { productId: p.id, uomId: p.uom_id, qty: Number(row.qty), reasonTagIds: await brokenReasonTag(), origin: `OEM scrap ${row.pack_date}` };
    const lastMo = await odooExecute<any[]>('mrp.production', 'search_read',
      [[['product_id', '=', p.id], ['origin', '=like', 'OEM %'], ['state', '=', 'done']]], { fields: ['location_dest_id'], limit: 1, order: 'id desc' });
    const locId = lastMo[0]?.location_dest_id ? (Array.isArray(lastMo[0].location_dest_id) ? lastMo[0].location_dest_id[0] : lastMo[0].location_dest_id) : null;
    const r = locId ? await createScrapAtLocation(locId, input) : await createLabScrap(input);
    return { status: r.ok ? 'done' : 'error', ref: r.scrapId ? `scrap #${r.scrapId}` : null, error: r.ok ? null : (r.error ?? 'Odoo error') };
  } catch (e: any) {
    return { status: 'error', error: String(e?.message ?? e) };
  }
}

async function syncRow(supabase: any, id: string) {
  const { data: row } = await supabase.from('lab_mm_packaging_log').select('*').eq('id', id).single();
  if (!row) return { status: 'error', error: 'Entry not found' };
  const r = await pushRowToOdoo(supabase, row);
  await supabase.from('lab_mm_packaging_log').update({
    odoo_status: r.status, odoo_ref: r.ref ?? row.odoo_ref ?? null, odoo_error: r.error ?? null,
    ...(r.moId ? { odoo_mo_id: r.moId } : {}),
  }).eq('id', id);
  return { status: r.status, error: r.error ?? undefined };
}

export type PackEntry = { sku: string; qty: number; bags_count?: number | null };
export type ScrapEntry = { kind: 'scrap_bulk' | 'scrap_finished'; sku: string; qty: number };

export async function savePackagingAction(input: { pack_date: string; packed: PackEntry[]; scraps: ScrapEntry[]; note?: string | null }):
  Promise<{ ok?: boolean; error?: string; odoo?: { sent: number; failed: number; off: boolean } }> {
  const auth = await me();
  if ('error' in auth) return { error: auth.error };
  const { supabase } = auth;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.pack_date)) return { error: 'Invalid date' };

  const { data: items } = await supabase.from('lab_mm_order_items').select('sku, group_key, unit, unit_weight_g');
  const bySku: Record<string, any> = {};
  for (const i of items ?? []) bySku[i.sku] = i;

  const rows: any[] = [];
  for (const p of input.packed ?? []) {
    const it = bySku[p.sku]; const q = Number(p.qty);
    if (!it || !(q > 0)) continue;
    rows.push({ kind: 'packed' as Kind, sku: p.sku, group_key: it.group_key, qty: q, bags_count: p.bags_count ?? null });
  }
  for (const s of input.scraps ?? []) {
    const it = bySku[s.sku]; const q = Number(s.qty);
    if (!it || !(q > 0) || !['scrap_bulk', 'scrap_finished'].includes(s.kind)) continue;
    rows.push({ kind: s.kind, sku: s.sku, group_key: it.group_key, qty: q, bags_count: null });
  }
  if (!rows.length) return { error: 'Nothing to save' };

  // Never pack (or scrap as bulk) more than the bulk Hung has actually logged.
  const avail = await bulkAvailableByGroup(supabase);
  const need: Record<string, number> = {};
  for (const r of rows) {
    if (r.kind === 'packed') need[r.group_key] = (need[r.group_key] ?? 0) + kgOf(bySku[r.sku], r.qty);
    if (r.kind === 'scrap_bulk') need[r.group_key] = (need[r.group_key] ?? 0) + r.qty;
  }
  for (const [g, kg] of Object.entries(need)) {
    if (kg > (avail[g] ?? 0) + 0.0005) return { error: `bulk:${g}:${(avail[g] ?? 0).toFixed(2)}` };
  }

  const on = await odooEnabled(supabase);
  const { data: inserted, error } = await supabase.from('lab_mm_packaging_log').insert(rows.map(r => ({
    ...r, pack_date: input.pack_date, note: input.note?.trim()?.slice(0, 300) || null,
    odoo_status: r.kind === 'scrap_bulk' ? 'skipped' : 'pending',
    created_by: auth.id, created_by_name: auth.name,
  }))).select('id, kind');
  if (error) return { error: error.message };

  let sent = 0, failed = 0;
  if (on) {
    for (const r of inserted ?? []) {
      if (r.kind === 'scrap_bulk') continue;
      const res = await syncRow(supabase, r.id);
      if (res.status === 'done') sent++; else failed++;
    }
  }
  return { ok: true, odoo: { sent, failed, off: !on } };
}

// Push one pending / failed entry to Odoo (resumes an MO already created instead of duplicating it).
export async function pushPackagingToOdooAction(id: string): Promise<{ ok?: boolean; error?: string }> {
  const auth = await me();
  if ('error' in auth) return { error: auth.error };
  if (!(await odooEnabled(auth.supabase))) return { error: 'Odoo sync is off (Order settings)' };
  const r = await syncRow(auth.supabase, id);
  return r.status === 'done' ? { ok: true } : { error: r.error ?? 'Odoo error' };
}

async function editable(auth: { supabase: any; id: string; role: string }, id: string) {
  const { data: row } = await auth.supabase.from('lab_mm_packaging_log').select('*').eq('id', id).single();
  if (!row) return { error: 'Entry not found' };
  if (row.odoo_status === 'done' || row.odoo_mo_id) return { error: 'locked-odoo' };
  const own = row.created_by === auth.id && Date.now() - new Date(row.created_at).getTime() < 24 * 3600 * 1000;
  if (!own && !MANAGERS.includes(auth.role)) return { error: 'locked-24h' };
  return { row };
}

export async function updatePackagingAction(id: string, qty: number, note: string | null): Promise<{ ok?: boolean; error?: string }> {
  const auth = await me();
  if ('error' in auth) return { error: auth.error };
  const e = await editable(auth, id);
  if ('error' in e) return { error: e.error };
  const q = Number(qty);
  if (!(q > 0)) return { error: 'Quantity must be > 0' };
  if (e.row.kind !== 'scrap_finished') {
    const { data: it } = await auth.supabase.from('lab_mm_order_items').select('unit, unit_weight_g').eq('sku', e.row.sku).single();
    const avail = await bulkAvailableByGroup(auth.supabase);
    const unitKg = e.row.kind === 'scrap_bulk' ? 1 : kgOf(it ?? { unit: 'bag', unit_weight_g: 0 }, 1);
    const extra = (q - Number(e.row.qty)) * unitKg;
    if (extra > (avail[e.row.group_key] ?? 0) + 0.0005) return { error: `bulk:${e.row.group_key}:${(avail[e.row.group_key] ?? 0).toFixed(2)}` };
  }
  const { error } = await auth.supabase.from('lab_mm_packaging_log').update({
    qty: q, note: note?.trim()?.slice(0, 300) || null, updated_at: new Date().toISOString(), updated_by_name: auth.name,
  }).eq('id', id);
  return error ? { error: error.message } : { ok: true };
}

export async function deletePackagingAction(id: string): Promise<{ ok?: boolean; error?: string }> {
  const auth = await me();
  if ('error' in auth) return { error: auth.error };
  const e = await editable(auth, id);
  if ('error' in e) return { error: e.error };
  const { error } = await auth.supabase.from('lab_mm_packaging_log').delete().eq('id', id);
  return error ? { error: error.message } : { ok: true };
}
