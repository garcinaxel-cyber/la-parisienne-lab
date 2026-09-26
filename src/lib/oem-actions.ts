'use server';
import { createClient as createServiceClient } from '@supabase/supabase-js';
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

type Kind = 'packed' | 'scrap_bulk' | 'scrap_finished' | 'found';
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
    supabase.from('lab_mm_production_log').select('group_key, status, received_kg'),
    supabase.from('lab_mm_packaging_log').select('kind, sku, group_key, qty'),
  ]);
  const bySku: Record<string, any> = {};
  for (const i of items.data ?? []) bySku[i.sku] = i;
  const out: Record<string, number> = {};
  // v2: only RECEIVED kg are packable (Hung's declared batches wait for an assistant's reception)
  for (const r of prod.data ?? []) if (r.status === 'received') out[r.group_key] = (out[r.group_key] ?? 0) + Number(r.received_kg ?? 0);
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
  if (row.kind === 'scrap_bulk' || row.kind === 'found') return { status: 'skipped' };
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
    if (it.unit === 'bag' && !Number.isInteger(q)) return { error: 'integer' };
    rows.push({ kind: 'packed' as Kind, sku: p.sku, group_key: it.group_key, qty: q, bags_count: p.bags_count ?? null });
  }
  for (const s of input.scraps ?? []) {
    const it = bySku[s.sku]; const q = Number(s.qty);
    if (!it || !(q > 0) || !['scrap_bulk', 'scrap_finished'].includes(s.kind)) continue;
    if (s.kind === 'scrap_finished' && it.unit === 'bag' && !Number.isInteger(q)) return { error: 'integer' };
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
  if (row.source === 'inventory') return { error: 'locked-inventory' };
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
  if (e.row.kind !== 'scrap_bulk') {
    const { data: u } = await auth.supabase.from('lab_mm_order_items').select('unit').eq('sku', e.row.sku).single();
    if (u?.unit === 'bag' && !Number.isInteger(q)) return { error: 'integer' };
  }
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

// ─────────────────────────────── v2 (Axel, 2026-09-26) ───────────────────────────────

function service() {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return null;
  return createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
}

// Reception of one of Hung's batches: the assistant confirms it (full weight) or records less
// (never more) with a reason. From then on the batch is theirs: packable, and locked for Hung.
// Written with the service key because assistants have no UPDATE right on the production log.
export async function receiveProductionAction(id: string, receivedKg: number | null, note: string | null): Promise<{ ok?: boolean; error?: string }> {
  const auth = await me();
  if ('error' in auth) return { error: auth.error };
  const svc = service();
  if (!svc) return { error: 'Server not configured' };
  const { data: row } = await svc.from('lab_mm_production_log').select('id, status, weight_kg').eq('id', id).single();
  if (!row) return { error: 'Batch not found' };
  if (row.status === 'received') return { error: 'already-received' };
  const declared = Number(row.weight_kg);
  const kg = receivedKg == null ? declared : Math.round(Number(receivedKg) * 1000) / 1000;
  if (!(kg >= 0) || kg > declared + 0.0005) return { error: 'more-than-declared' };
  if (kg < declared - 0.0005 && !(note ?? '').trim()) return { error: 'reason-required' };
  const { error } = await svc.from('lab_mm_production_log').update({
    status: 'received', received_kg: Math.min(kg, declared), received_at: new Date().toISOString(),
    received_by: auth.id, received_by_name: auth.name, receive_note: (note ?? '').trim().slice(0, 300) || null,
  }).eq('id', id).eq('status', 'pending');
  return error ? { error: error.message } : { ok: true };
}

// theoretical finished stock per SKU, computed server-side (same rule as model.ts derive)
async function fgTheoBySku(supabase: any): Promise<Record<string, number>> {
  const [pack, deliv] = await Promise.all([
    supabase.from('lab_mm_packaging_log').select('kind, sku, qty'),
    supabase.rpc('lab_mm_deliveries'),
  ]);
  const t: Record<string, number> = {};
  for (const r of pack.data ?? []) {
    const q = Number(r.qty);
    if (r.kind === 'packed' || r.kind === 'found') t[r.sku] = (t[r.sku] ?? 0) + q;
    if (r.kind === 'scrap_finished') t[r.sku] = (t[r.sku] ?? 0) - q;
  }
  for (const x of deliv.data ?? []) if (x.order_status === 'validated' && !x.not_delivered && x.qty_checked != null) t[x.sku] = (t[x.sku] ?? 0) - Number(x.qty_checked);
  return t;
}

function needsAdmin(gap: number, theo: number, unit: string) {
  const abs = Math.abs(gap);
  return abs > (unit === 'kg' ? 2 : 20) || (theo > 0 && abs / theo > 0.02);
}

// Apply a count gap. Negative → loss line (re-made by Hung, Odoo scrap when sync is on).
// Positive → packing that was never recorded: consumes the received bulk (Odoo MO when on);
// what no bulk can explain is either refused (auto path → admin) or, on admin approval, booked as 'found'.
async function applyGap(supabase: any, auth: { id: string; name: string }, count: { id: string; sku: string; gap: number; count_date: string },
  item: { sku: string; group_key: string; unit: string; unit_weight_g: number }, allowFound: boolean): Promise<{ ok?: boolean; escalate?: boolean; error?: string }> {
  const gap = Math.round(count.gap * 1000) / 1000;
  if (Math.abs(gap) < 0.0005) return { ok: true };
  const base = { pack_date: count.count_date, sku: item.sku, group_key: item.group_key, source: 'inventory', fg_count_id: count.id, created_by: auth.id, created_by_name: auth.name, note: 'inventory gap' };
  const rows: any[] = [];
  if (gap < 0) rows.push({ ...base, kind: 'scrap_finished', qty: -gap, odoo_status: 'pending' });
  else {
    const avail = Math.max(0, (await bulkAvailableByGroup(supabase))[item.group_key] ?? 0);
    const availUnits = item.unit === 'kg' ? Math.floor(avail * 1000) / 1000 : Math.floor((avail * 1000) / Number(item.unit_weight_g));
    const explained = Math.min(gap, availUnits);
    const rest = Math.round((gap - explained) * 1000) / 1000;
    if (rest > 0.0005 && !allowFound) return { escalate: true };
    if (explained > 0) rows.push({ ...base, kind: 'packed', qty: explained, odoo_status: 'pending', note: 'packing found at inventory' });
    if (rest > 0.0005) rows.push({ ...base, kind: 'found', qty: rest, odoo_status: 'skipped', note: 'surplus accepted by admin' });
  }
  const { data: ins, error } = await supabase.from('lab_mm_packaging_log').insert(rows).select('id, kind');
  if (error) return { error: error.message };
  if (await odooEnabled(supabase)) for (const r of ins ?? []) if (r.kind !== 'found') await syncRow(supabase, r.id);
  return { ok: true };
}

// Finished-goods count: every product of the client must be counted (0 typed explicitly).
export async function saveFgCountAction(input: { count_date: string; client: string; counts: { sku: string; qty: number }[] }):
  Promise<{ ok?: boolean; error?: string; applied?: number; pending?: number }> {
  const auth = await me();
  if ('error' in auth) return { error: auth.error };
  const { supabase } = auth;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.count_date)) return { error: 'Invalid date' };
  const { data: items } = await supabase.from('lab_mm_order_items').select('sku, group_key, unit, unit_weight_g, client_name').eq('is_active', true);
  const clientItems = (items ?? []).filter((i: any) => (i.client_name || 'Maison Mooncake') === input.client);
  const bySku: Record<string, any> = Object.fromEntries(clientItems.map((i: any) => [i.sku, i]));
  const given = new Map(input.counts.map(c => [c.sku, Number(c.qty)]));
  if (!clientItems.length || clientItems.some((i: any) => !given.has(i.sku))) return { error: 'incomplete' };
  for (const [sku, q] of Array.from(given.entries())) {
    const it = bySku[sku];
    if (!it || !(q >= 0) || (it.unit === 'bag' && !Number.isInteger(q))) return { error: 'integer' };
  }
  const { data: existing } = await supabase.from('lab_mm_fg_counts').select('sku').eq('count_date', input.count_date).neq('status', 'rejected').in('sku', clientItems.map((i: any) => i.sku));
  if ((existing ?? []).length) return { error: 'already-counted' };

  const theo = await fgTheoBySku(supabase);
  let applied = 0, pending = 0;
  for (const it of clientItems) {
    const q = given.get(it.sku)!; const t = Math.round((theo[it.sku] ?? 0) * 1000) / 1000; const gap = Math.round((q - t) * 1000) / 1000;
    const status = Math.abs(gap) > 0.0005 && needsAdmin(gap, t, it.unit) ? 'pending_admin' : 'applied';
    const { data: row, error } = await supabase.from('lab_mm_fg_counts').insert({
      count_date: input.count_date, sku: it.sku, qty_counted: q, qty_theoretical: t, gap, status, created_by: auth.id, created_by_name: auth.name,
    }).select('id, sku, gap, count_date').single();
    if (error || !row) return { error: error?.message ?? 'insert failed' };
    if (status === 'pending_admin') { pending++; continue; }
    const r = await applyGap(supabase, auth, { ...row, gap: Number(row.gap) }, it, false);
    if (r.escalate) { await supabase.from('lab_mm_fg_counts').update({ status: 'pending_admin' }).eq('id', row.id); pending++; }
    else if (r.error) return { error: r.error };
    else applied++;
  }
  return { ok: true, applied, pending };
}

// Admin decision on a gap: approve (apply, surplus without bulk booked as 'found') or reject (recount).
export async function decideFgCountAction(id: string, decision: 'approve' | 'reject'): Promise<{ ok?: boolean; error?: string }> {
  const auth = await me();
  if ('error' in auth) return { error: auth.error };
  if (auth.role !== 'admin') return { error: 'Forbidden' };
  const { supabase } = auth;
  const { data: c } = await supabase.from('lab_mm_fg_counts').select('id, sku, gap, count_date, status').eq('id', id).single();
  if (!c || c.status !== 'pending_admin') return { error: 'Not pending' };
  if (decision === 'approve') {
    const { data: it } = await supabase.from('lab_mm_order_items').select('sku, group_key, unit, unit_weight_g').eq('sku', c.sku).single();
    if (!it) return { error: 'Product not found' };
    const r = await applyGap(supabase, auth, { id: c.id, sku: c.sku, gap: Number(c.gap), count_date: c.count_date }, it, true);
    if (r.error) return { error: r.error };
  }
  const { error } = await supabase.from('lab_mm_fg_counts').update({
    status: decision === 'approve' ? 'applied' : 'rejected', decided_at: new Date().toISOString(), decided_by_name: auth.name,
  }).eq('id', id);
  return error ? { error: error.message } : { ok: true };
}
