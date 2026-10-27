'use server';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { createClient, getSafeSession } from '@/lib/supabase-server';
import { odooExecute } from '@/lib/odoo';
import { createAndProduceOemMO, resumeOemMO } from '@/lib/odoo-oem-mo';
import { getScrapReasonTags, resolveProductsBySku, createLabScrap, createScrapAtLocation } from '@/lib/odoo-scrap';
import { PROD_EDITORS_KEY, editorIds } from '@/components/oem/plan';
import { cartonBestBefore } from '@/components/oem/labelRules';

// OEM Orders tracker — packaging entries (Axel, 2026-09-25). Assistants record what was packed
// each day (+ scrap). Only lab_mm_* tables are written; Odoo is touched only when the admin
// setting odoo_mo_enabled = 'true':
//   packed          → one MO for the finished SKU (odoo-oem-mo.ts), created + validated at once
//   scrap_finished  → stock.scrap of the finished SKU (faulty bags after packing)
//   scrap_bulk      → nothing in Odoo (the bulk was never an Odoo stock item on its own)

type Kind = 'packed' | 'scrap_bulk' | 'scrap_finished' | 'found';
// 'purchasing' (Hiền) works on OEM exactly like an assistant (Axel, 2026-10-12, lab_v119).
const STAFF = ['admin', 'lab_manager', 'assistant', 'purchasing'];
const MANAGERS = ['admin', 'lab_manager'];
const RECEIVERS = STAFF;

async function me(allowed: string[] = STAFF) {
  const supabase = createClient();
  const { data: { session } } = await getSafeSession(supabase);
  if (!session) return { error: 'Not authenticated' as const };
  const { data: profile } = await supabase.from('profiles').select('role, full_name').eq('id', session.user.id).single();
  const role = profile?.role ?? '';
  if (!allowed.includes(role)) return { error: 'Forbidden' as const };
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
  const auth = await me(RECEIVERS);
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

// Team-lead corrections (Axel, 2026-10-07): the accounts the admin ticked in Settings (key
// prod_editors: Hung only, never his staff) may change the kg of a baked batch or cancel it, as
// long as no assistant has received it. Chefs have no UPDATE/DELETE right on the production log
// (RLS) and cannot write lab_mm_settings, so this action is the only way in; the caller is checked
// here on the server, whatever the screen shows. Every correction is kept in lab_mm_production_audit.
// newKg = null cancels the batch.
export async function fixProductionAction(id: string, newKg: number | null, reason: string | null): Promise<{ ok?: boolean; error?: string }> {
  const supabase = createClient();
  const { data: { session } } = await getSafeSession(supabase);
  if (!session) return { error: 'Not authenticated' };
  const svc = service();
  if (!svc) return { error: 'Server not configured' };
  const uid = session.user.id;
  const { data: st } = await svc.from('lab_mm_settings').select('value').eq('key', PROD_EDITORS_KEY).maybeSingle();
  if (!editorIds(st?.value).includes(uid)) return { error: 'Forbidden' };
  const { data: row } = await svc.from('lab_mm_production_log')
    .select('id, status, weight_kg, group_key, sku, prod_date, plan_seq, created_by, created_by_name').eq('id', id).maybeSingle();
  if (!row) return { error: 'Batch not found' };
  if (row.status !== 'pending') return { error: 'already-received' };
  // only his own batches and those of his own team
  if (row.created_by !== uid) {
    const { data: teams } = await svc.from('lab_profiles').select('id, team').in('id', [uid, row.created_by].filter(Boolean));
    const teamOf = (x: string | null) => (teams ?? []).find(r => r.id === x)?.team ?? null;
    if (!teamOf(uid) || teamOf(uid) !== teamOf(row.created_by)) return { error: 'not-your-team' };
  }
  const old = Number(row.weight_kg);
  let kg: number | null = null;
  if (newKg != null) {
    kg = Math.round(Number(newKg) * 1000) / 1000;
    if (!(kg > 0) || kg > 2000) return { error: 'bad-kg' };
    if (Math.abs(kg - old) < 0.0005) return { ok: true };
    // .eq('status','pending'): if an assistant receives it at the same moment, the reception wins
    const { data: done, error } = await svc.from('lab_mm_production_log').update({ weight_kg: kg }).eq('id', id).eq('status', 'pending').select('id');
    if (error) return { error: error.message };
    if (!done?.length) return { error: 'already-received' };
  } else {
    const { data: done, error } = await svc.from('lab_mm_production_log').delete().eq('id', id).eq('status', 'pending').select('id');
    if (error) return { error: error.message };
    if (!done?.length) return { error: 'already-received' };
  }
  const { data: who } = await svc.from('profiles').select('full_name').eq('id', uid).maybeSingle();
  const { error: aErr } = await svc.from('lab_mm_production_audit').insert({
    log_id: row.id, action: kg == null ? 'cancel' : 'edit', group_key: row.group_key, sku: row.sku, prod_date: row.prod_date,
    plan_seq: row.plan_seq, entry_by_name: row.created_by_name, old_kg: old, new_kg: kg,
    reason: (reason ?? '').trim().slice(0, 300) || null, done_by: uid, done_by_name: who?.full_name ?? null,
  });
  if (aErr) console.error('[oem] production audit not written', aErr.message);
  return { ok: true };
}

// Which order/delivery a baked batch is for (Axel 2026-10-02: Hung chooses it; null = automatic).
// Service key because the chef has no UPDATE right on the production log; only plan_seq is written.
export async function setProductionOrderAction(id: string, seq: number | null): Promise<{ ok?: boolean; error?: string }> {
  const supabase = createClient();
  const { data: { session } } = await getSafeSession(supabase);
  if (!session) return { error: 'Not authenticated' };
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
  if (!['admin', 'lab_manager', 'assistant', 'purchasing', 'chef'].includes(profile?.role ?? '')) return { error: 'Forbidden' };
  const svc = service();
  if (!svc) return { error: 'Server not configured' };
  const { data: row } = await svc.from('lab_mm_production_log').select('id, group_key').eq('id', id).single();
  if (!row) return { error: 'Batch not found' };
  if (seq != null) {
    const { data: item } = await svc.from('lab_mm_order_items').select('client_name').eq('group_key', row.group_key).limit(1).maybeSingle();
    const { data: rows } = await svc.from('lab_mm_delivery_plan').select('client_name').eq('seq', seq).is('cancelled_at', null);
    const MM = 'Maison Mooncake';
    if (!(rows ?? []).some(p => (p.client_name || MM) === (item?.client_name || MM))) return { error: 'Unknown order' };
  }
  const { error } = await svc.from('lab_mm_production_log').update({ plan_seq: seq }).eq('id', id);
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

// ── Carton labels + delivery notes (Axel, 2026-10-14) ─────────────────────────────────────────
// One delivery note (phiếu giao hàng) per Odoo delivery order, one carton row (tem thùng) per box
// with an automatic serial: <client>-<product>-<yymmdd delivery>-<nnn>. Rules from Axel: packing
// date = delivery − 1 day, production date = delivery − 2 days, best-before = delivery + 120 days.
// The production date printed is always a date on which the product was really baked (it must
// exist in the production log); a date older than the rule needs an admin / lab-manager OK.
const ymd = (iso: string) => iso.slice(2, 4) + iso.slice(5, 7) + iso.slice(8, 10);
const addDaysIso = (iso: string, n: number) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const prodCode = (sku: string) => sku.replace(/^(MM|OEM)-/, '').replace(/-KG$/, '');
export type NoteLineInput = { sku: string; kg: number; bagsPerCarton: number; bagKg: number; prodDate: string };

export async function createDeliveryNoteAction(input: {
  clientName: string; orderRef: string; deliveryDate: string; lines: NoteLineInput[]; overrideNote?: string | null; preparedBy: string;
}): Promise<{ ok?: boolean; id?: string; error?: string }> {
  const auth = await me(STAFF);
  if ('error' in auth) return { error: auth.error };
  const svc = service();
  if (!svc) return { error: 'Server not configured' };
  const { clientName, orderRef, deliveryDate } = input;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(deliveryDate) || !orderRef) return { error: 'bad-input' };
  const lines = (input.lines ?? []).filter(l => Number(l.kg) > 0);
  if (!lines.length) return { error: 'no-lines' };

  const { data: info } = await svc.from('lab_mm_settings').select('value').eq('key', `client_info:${clientName}`).maybeSingle();
  let ci: any = null; try { ci = JSON.parse(info?.value ?? 'null'); } catch { ci = null; }
  if (!ci?.code) return { error: 'no-client-info' };
  const { data: items } = await svc.from('lab_mm_order_items').select('sku, group_key, client_name').in('sku', lines.map(l => l.sku));
  const bySku = Object.fromEntries((items ?? []).map(i => [i.sku, i]));
  const MM = 'Maison Mooncake';
  for (const l of lines) {
    const it = bySku[l.sku];
    if (!it || (it.client_name || MM) !== clientName) return { error: `unknown-sku:${l.sku}` };
    if (!(Number(l.bagsPerCarton) >= 1) || !(Number(l.bagKg) > 0)) return { error: `bad-format:${l.sku}` };
  }
  // production dates: real dates from the log; older than the rule → manager OK
  const ruleProd = addDaysIso(deliveryDate, -2);
  const { data: logs } = await svc.from('lab_mm_production_log').select('group_key, prod_date').in('group_key', Array.from(new Set(lines.map(l => bySku[l.sku].group_key))));
  const realDates = new Set((logs ?? []).map(r => `${r.group_key}|${r.prod_date}`));
  for (const l of lines) if (l.prodDate !== ruleProd && !realDates.has(`${bySku[l.sku].group_key}|${l.prodDate}`)) return { error: `not-a-production-date:${l.sku}` };
  const old = lines.filter(l => l.prodDate < ruleProd);
  const override = (input.overrideNote ?? '').trim().slice(0, 300);
  // any staff member with access may confirm an older date: their own (nickname) name is recorded
  if (old.length && !override) return { error: 'needs-reason' };
  const preparedBy = (input.preparedBy ?? '').trim().slice(0, 80);
  if (!preparedBy) return { error: 'needs-prepared-by' };

  // cartons: full ones, then one part carton for the rest
  type C = { sku: string; group_key: string; bags: number; bag_kg: number; net_kg: number; prod_date: string };
  const cartons: C[] = [];
  for (const l of lines) {
    const per = Math.round(Number(l.bagsPerCarton)); const bk = Number(l.bagKg); const full = per * bk;
    let left = Math.round(Number(l.kg) * 1000) / 1000;
    while (left > 0.0005) {
      const net = Math.min(full, left);
      cartons.push({ sku: l.sku, group_key: bySku[l.sku].group_key, bags: Math.ceil(net / bk - 1e-6), bag_kg: bk, net_kg: Math.round(net * 1000) / 1000, prod_date: l.prodDate });
      left = Math.round((left - net) * 1000) / 1000;
    }
  }
  if (cartons.length > 500) return { error: 'too-many-cartons' };

  // numbers (atomic counters, never reused)
  const notePrefix = `PGH-${ci.code}-${ymd(deliveryDate)}`;
  const { data: nStart, error: nErr } = await svc.rpc('lab_mm_take_numbers', { p_prefix: notePrefix, p_n: 1 });
  if (nErr) return { error: nErr.message };
  const noteNo = `${notePrefix}-${String(nStart).padStart(2, '0')}`;
  const serials: string[] = [];
  for (const sku of Array.from(new Set(cartons.map(c => c.sku)))) {
    const mine = cartons.filter(c => c.sku === sku);
    const prefix = `${ci.code}-${prodCode(sku)}-${ymd(deliveryDate)}`;
    const { data: start, error } = await svc.rpc('lab_mm_take_numbers', { p_prefix: prefix, p_n: mine.length });
    if (error) return { error: error.message };
    mine.forEach((c, k) => { (c as any).serial = `${prefix}-${String(Number(start) + k).padStart(3, '0')}`; });
  }

  // per-product shelf life (client_info.products) → the note keeps the earliest carton date
  const baseBB = addDaysIso(deliveryDate, Number(ci.shelf_days) || 120);
  const noteBestBefore = cartons.map(c => cartonBestBefore(ci, c, baseBB)).sort()[0] ?? baseBB;
  const { data: note, error: e1 } = await svc.from('lab_mm_delivery_notes').insert({
    note_no: noteNo, client_name: clientName, order_ref: orderRef, delivery_date: deliveryDate,
    pack_date: addDaysIso(deliveryDate, -1), best_before: noteBestBefore,
    override_by_name: old.length ? auth.name : null, override_note: old.length ? override : null,
    created_by: auth.id, created_by_name: auth.name, prepared_by: preparedBy,
  }).select('id').single();
  if (e1 || !note) return { error: e1?.message ?? 'insert failed' };
  const { error: e2 } = await svc.from('lab_mm_cartons').insert(cartons.map((c, k) => ({
    note_id: note.id, serial: (c as any).serial, line_no: k + 1, sku: c.sku, group_key: c.group_key,
    lot_no: `${prodCode(c.sku)}-${ymd(c.prod_date)}`, prod_date: c.prod_date, bags: c.bags, bag_kg: c.bag_kg, net_kg: c.net_kg,
  })));
  if (e2) { await svc.from('lab_mm_delivery_notes').delete().eq('id', note.id); return { error: e2.message }; }
  await svc.from('lab_mm_carton_formats').upsert(lines.map(l => ({ client_name: clientName, sku: l.sku, bags_per_carton: Math.round(Number(l.bagsPerCarton)), bag_kg: Number(l.bagKg), updated_at: new Date().toISOString() })));
  return { ok: true, id: note.id };
}

// Cancel a note that was not signed yet (wrong format, wrong date…). Kept with status 'void' so
// its serials are never reused; a new note gets new numbers.
export async function voidDeliveryNoteAction(id: string): Promise<{ ok?: boolean; error?: string }> {
  const auth = await me(STAFF);
  if ('error' in auth) return { error: auth.error };
  const svc = service();
  if (!svc) return { error: 'Server not configured' };
  const { data, error } = await svc.from('lab_mm_delivery_notes').update({ status: 'void' }).eq('id', id).eq('status', 'ready').select('id');
  if (error) return { error: error.message };
  return data?.length ? { ok: true } : { error: 'already-signed' };
}

// Photo of the note signed by the client → status 'signed' (proof that the risk passed to them).
export async function signDeliveryNoteAction(formData: FormData): Promise<{ ok?: boolean; error?: string }> {
  const auth = await me(STAFF);
  if ('error' in auth) return { error: auth.error };
  const svc = service();
  if (!svc) return { error: 'Server not configured' };
  const id = String(formData.get('id') ?? '');
  const file = formData.get('file');
  if (!id || !(file instanceof File)) return { error: 'No file' };
  if (!file.type.startsWith('image/')) return { error: 'Only images' };
  if (file.size > 8 * 1024 * 1024) return { error: 'Image too large (max 8MB)' };
  const path = `oem-delivery-notes/${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}.jpg`;
  const { error: up } = await svc.storage.from('lab-design-photos').upload(path, Buffer.from(await file.arrayBuffer()), { contentType: file.type, upsert: false });
  if (up) return { error: up.message };
  const url = svc.storage.from('lab-design-photos').getPublicUrl(path).data.publicUrl;
  const { data, error } = await svc.from('lab_mm_delivery_notes').update({ status: 'signed', signed_photo_url: url, signed_at: new Date().toISOString(), signed_by_name: auth.name })
    .eq('id', id).neq('status', 'void').select('id');
  if (error) return { error: error.message };
  return data?.length ? { ok: true } : { error: 'Note not found' };
}
