// Rooms linked to Odoo (Axel, 2026-10-29). Server-only.
//
// Each team has its own room in Odoo (stock.location, sibling of LAB/Stock under the LAB view, so a
// reservation on LAB/Stock never takes from a room) and its own manufacturing operation type. From
// ROOMS_LINK_START_DAY (env, 'YYYY-MM-DD', lab day) on:
//   * a slip confirmed by storage = an internal transfer validated in Odoo:
//       take                → LAB/Stock → Room of the team
//       transfer team → team → Room A → Room B
//       transfer team → kho  → Room → LAB/Stock (give-back)
//   * the day's MOs are made per product and per team on the team's type: components consumed in
//     the room, semi-finished made and consumed in the room (type default destination = room, tested
//     29/10 on WH/MO/71230), finished product forced to LAB/Stock on the parent MO (deliveries
//     unchanged). Components that are not raw materials and not made by the MO itself (packaging,
//     a semi-finished from LAB/Stock) are moved LAB/Stock → room after the MO is done
//     (topUpRoomComponents), since no slip ever brings them to the room;
//   * a confirmed room count is applied to the room once that day's MOs are done.
// Internal transfers make no accounting entry; only inventory adjustments do.
// Before the start day nothing changes (one MO per product on Lab: Manufacturing, LAB/Stock).
// Review 2026-10-29: every push first CLAIMS its row (conditional update) so the confirm click and
// the cron can never both create a transfer for the same slip.
import { odooExecuteWrite, odooWriteConfigured, labDayUtcRange } from '@/lib/odoo';

export const LAB_STOCK_ID = 8;
export const LAB_INTERNAL_TYPE_ID = 7;      // Lab: Transferts internes
export const LAB_MANUF_TYPE_ID = 11;        // Lab: Manufacturing (legacy, LAB/Stock → LAB/Stock)
export const RAW_MATERIAL_CATEG_ID = 18;    // All / Raw Material (nguyên liệu)

export const ROOMS: Record<string, { location: number; manufType: number }> = {
  hung: { location: 219, manufType: 314 },
  baby_mama: { location: 220, manufType: 315 },
  entremet: { location: 221, manufType: 316 },
  baker: { location: 222, manufType: 317 },
};

const startDay = () => (process.env.ROOMS_LINK_START_DAY ?? '').trim();
const validDay = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

/** Rooms are linked for this lab day ('YYYY-MM-DD')? */
export function roomsLinkedForDay(day: string): boolean {
  const s = startDay();
  return validDay(s) && day >= s;
}
/** First instant (ISO) the link applies to, or null when it is off. */
export function roomsLinkStartIso(): string | null {
  const s = startDay();
  return validDay(s) ? labDayUtcRange(s).start : null;
}
export function roomOf(team: string | null | undefined) { return team ? ROOMS[team] ?? null : null; }
export function teamOfType(typeId: number | null | undefined): string | null {
  return Object.entries(ROOMS).find(([, r]) => r.manufType === typeId)?.[0] ?? null;
}

function tmo<T>(p: Promise<T>, ms: number, l: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, r) => setTimeout(() => r(new Error('timeout ' + l)), ms))]);
}
const NO_MAIL = { tracking_disable: true, mail_create_nolog: true, mail_notrack: true };
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const m2o = (v: any): number | null => (Array.isArray(v) ? Number(v[0]) : (v ? Number(v) : null));
const STALE_MS = 10 * 60 * 1000;   // a claim older than this is a dead run: it may be taken again

type Db = any;

export type SlipPushResult = { state: 'done' | 'error' | 'skipped' | 'busy'; pickingName?: string | null; error?: string | null };

/** Claims a slip for one push run. Returns false when another run holds it or it is finished. */
async function claimSlip(db: Db, id: string): Promise<boolean> {
  const stale = new Date(Date.now() - STALE_MS).toISOString();
  const { data } = await db.from('lab_raw_withdrawals').update({ odoo_state: 'pending', odoo_at: new Date().toISOString() })
    .eq('id', id).or(`odoo_state.is.null,odoo_state.eq.error,and(odoo_state.eq.pending,odoo_at.lt.${stale})`).select('id');
  return !!data?.length;
}

/**
 * Creates (or adopts) and validates an internal transfer in Odoo. `origin` identifies it: before
 * creating, an existing non-cancelled picking with the same origin is adopted, so a run killed after
 * Odoo created the picking never leads to a second one.
 */
async function moveInOdoo(args: {
  origin: string; src: number; dst: number; note: string; knownPickingId?: number | null;
  lines: { productId: number; uomId: number; qty: number }[];
  onCreated?: (id: number) => Promise<void>;
}): Promise<{ id: number; name: string }> {
  const { origin, src, dst } = args;
  let pickingId: number | null = args.knownPickingId ?? null;
  if (!pickingId) {
    const found = await tmo(odooExecuteWrite<any[]>('stock.picking', 'search_read',
      [[['origin', '=', origin], ['picking_type_id', '=', LAB_INTERNAL_TYPE_ID], ['state', '!=', 'cancel']]], { fields: ['id'], limit: 1, order: 'id asc' }), 15000, 'find picking');
    pickingId = found[0]?.id ?? null;
  }
  if (!pickingId) {
    pickingId = await tmo(odooExecuteWrite<number>('stock.picking', 'create', [{
      picking_type_id: LAB_INTERNAL_TYPE_ID, location_id: src, location_dest_id: dst, origin, note: args.note,
      move_ids: args.lines.map(l => [0, 0, { name: origin, product_id: l.productId, product_uom: l.uomId, product_uom_qty: l.qty, location_id: src, location_dest_id: dst }]),
    }], { context: NO_MAIL }), 30000, 'create picking');
  }
  if (args.onCreated) await args.onCreated(pickingId!);
  const [pk] = await tmo(odooExecuteWrite<any[]>('stock.picking', 'read', [[pickingId]], { fields: ['name', 'state', 'move_ids'] }), 15000, 'read picking');
  if (!pk) throw new Error(`Picking ${pickingId} not found`);
  if (pk.state !== 'done') {
    if (pk.state === 'draft') await tmo(odooExecuteWrite('stock.picking', 'action_confirm', [[pickingId]], { context: NO_MAIL }), 30000, 'confirm');
    // Done quantity = the demand, whatever is on hand (a room or LAB/Stock may go negative until the
    // count puts it right).
    const moves = await tmo(odooExecuteWrite<any[]>('stock.move', 'read', [pk.move_ids], { fields: ['id', 'product_uom_qty'] }), 15000, 'moves');
    for (const m of moves) await tmo(odooExecuteWrite('stock.move', 'write', [[m.id], { quantity: m.product_uom_qty, picked: true }], { context: NO_MAIL }), 15000, 'move qty');
    const res = await tmo(odooExecuteWrite<any>('stock.picking', 'button_validate', [[pickingId]], { context: { ...NO_MAIL, skip_backorder: true, cancel_backorder: true } }), 40000, 'validate');
    if (res && typeof res === 'object' && res.res_model) throw new Error(`Odoo asked for confirmation (${res.res_model}) on ${pk.name}`);
    const [after] = await tmo(odooExecuteWrite<any[]>('stock.picking', 'read', [[pickingId]], { fields: ['name', 'state'] }), 15000, 'reread');
    if (after?.state !== 'done') throw new Error(`${after?.name ?? pickingId} not done (state ${after?.state})`);
  }
  return { id: pickingId!, name: pk.name };
}

/**
 * Pushes one storage-confirmed slip to Odoo as a validated internal transfer. Idempotent and safe
 * against concurrent runs (claim + origin adoption).
 */
export async function pushSlipToOdoo(db: Db, withdrawalId: string): Promise<SlipPushResult> {
  const { data: w } = await db.from('lab_raw_withdrawals')
    .select('id, no, team, kind, from_team, to_team, status, confirmed_at, refused_at, confirmed_by_name, taken_by, odoo_picking_id, odoo_state, odoo_tries')
    .eq('id', withdrawalId).maybeSingle();
  if (!w) return { state: 'error', error: 'Slip not found' };
  if (w.odoo_state === 'done' || w.odoo_state === 'skipped') return { state: w.odoo_state };
  const start = roomsLinkStartIso();
  if (w.status !== 'confirmed' || !w.confirmed_at || !start || Date.parse(w.confirmed_at) < Date.parse(start)) return { state: 'skipped' };
  if (!(await claimSlip(db, w.id))) return { state: 'busy' };
  const save = async (v: Record<string, any>) => {
    await db.from('lab_raw_withdrawals').update({ ...v, odoo_at: new Date().toISOString(), odoo_tries: Number(w.odoo_tries ?? 0) + 1 }).eq('id', w.id);
  };
  if (w.refused_at) { await save({ odoo_state: 'skipped', odoo_error: 'refused' }); return { state: 'skipped' }; }

  let src: number | null = null, dst: number | null = null;
  if ((w.kind ?? 'take') === 'take') { src = LAB_STOCK_ID; dst = roomOf(w.team)?.location ?? null; }
  else {
    src = w.from_team === 'kho' ? LAB_STOCK_ID : roomOf(w.from_team)?.location ?? null;
    dst = w.to_team === 'kho' ? LAB_STOCK_ID : roomOf(w.to_team)?.location ?? null;
  }
  if (!src || !dst || src === dst) { await save({ odoo_state: 'skipped', odoo_error: 'no room for this team' }); return { state: 'skipped' }; }
  if (!odooWriteConfigured()) { await save({ odoo_state: 'error', odoo_error: 'Odoo write account not configured' }); return { state: 'error' }; }

  try {
    const { data: lines } = await db.from('lab_raw_withdrawal_lines').select('id, tmpl_id, name, qty, corrected_qty').eq('withdrawal_id', w.id);
    const noProduct = (lines ?? []).filter((l: any) => !l.tmpl_id && Number(l.corrected_qty ?? l.qty) > 0);
    if (noProduct.length) throw new Error(`Line(s) without an Odoo product: ${noProduct.map((l: any) => l.name).join(', ')}`);
    const qtyByTmpl = new Map<number, number>();
    for (const l of lines ?? []) {
      const q = Number(l.corrected_qty ?? l.qty);
      if (l.tmpl_id && q > 0) qtyByTmpl.set(l.tmpl_id, r3((qtyByTmpl.get(l.tmpl_id) ?? 0) + q));
    }
    if (!qtyByTmpl.size) { await save({ odoo_state: 'skipped', odoo_error: 'nothing given' }); return { state: 'skipped' }; }

    // Slip quantities are in the product's Odoo unit (the app catalogue takes its unit from Odoo).
    const tmplIds = Array.from(qtyByTmpl.keys());
    const prods = await tmo(odooExecuteWrite<any[]>('product.product', 'search_read',
      [[['product_tmpl_id', 'in', tmplIds], ['active', 'in', [true, false]]]], { fields: ['id', 'product_tmpl_id', 'uom_id'], limit: 500 }), 20000, 'products');
    const prodOf = new Map<number, any>();
    for (const p of prods) { const t = m2o(p.product_tmpl_id)!; if (!prodOf.has(t)) prodOf.set(t, p); }
    const missing = tmplIds.filter(t => !prodOf.has(t));
    if (missing.length) throw new Error(`Odoo product not found for template(s) ${missing.join(', ')}`);

    const take = (w.kind ?? 'take') === 'take';
    const kindVi = take ? 'phiếu lấy kho' : 'phiếu chuyển';
    const origin = `App ${kindVi} #${w.no}`;
    const pk = await moveInOdoo({
      origin, src, dst, knownPickingId: w.odoo_picking_id,
      note: `<p>Lab app — ${kindVi} #${w.no} · ${w.team} · ${w.taken_by ?? ''} · kho xác nhận: ${w.confirmed_by_name ?? ''}</p><p>Lab app — ${take ? 'storage slip' : 'transfer'} #${w.no}, confirmed by storage.</p>`,
      lines: tmplIds.map(t => { const p = prodOf.get(t); return { productId: p.id, uomId: m2o(p.uom_id)!, qty: qtyByTmpl.get(t)! }; }),
      onCreated: async id => { if (id !== w.odoo_picking_id) await db.from('lab_raw_withdrawals').update({ odoo_picking_id: id }).eq('id', w.id); },
    });
    await save({ odoo_state: 'done', odoo_picking_id: pk.id, odoo_picking_name: pk.name, odoo_error: null });
    return { state: 'done', pickingName: pk.name };
  } catch (e: any) {
    const msg = String(e?.message ?? e).slice(0, 500);
    await save({ odoo_state: 'error', odoo_error: msg });
    return { state: 'error', error: msg };
  }
}

/** Retries confirmed slips since the start that are not in Odoo yet (cron, every 15 min). Small
 *  batch, least-tried first, so a slip that keeps failing never blocks the others. */
export async function pushPendingSlips(db: Db, limit = 8): Promise<{ done: number; errors: number; skipped: number }> {
  const start = roomsLinkStartIso();
  const out = { done: 0, errors: 0, skipped: 0 };
  if (!start) return out;
  const stale = new Date(Date.now() - STALE_MS).toISOString();
  const { data } = await db.from('lab_raw_withdrawals').select('id').eq('status', 'confirmed').gte('confirmed_at', start)
    .or(`odoo_state.is.null,odoo_state.eq.error,and(odoo_state.eq.pending,odoo_at.lt.${stale})`).lt('odoo_tries', 30)
    .order('odoo_tries').order('confirmed_at').limit(limit);
  for (const r of data ?? []) {
    const res = await pushSlipToOdoo(db, r.id);
    if (res.state === 'done') out.done++; else if (res.state === 'error') out.errors++; else out.skipped++;
  }
  return out;
}

// ── Components no slip brings to the room ────────────────────────────────────────────────────────
/**
 * After an MO in a room is done: components consumed from the room that are neither raw materials
 * (those come with the team's slips) nor made by the MO itself (auto-produced semi-finished) are
 * moved LAB/Stock → room, so the room is not left negative and LAB/Stock not left too high.
 * Typically OEM bags/cartons, or a semi-finished taken from LAB/Stock. One transfer per MO (origin
 * "App MO <name>"), adopted on retry.
 */
export async function topUpRoomComponents(db: Db, moId: number): Promise<{ ok: boolean; picking?: string; error?: string }> {
  try {
    const [mo] = await odooExecuteWrite<any[]>('mrp.production', 'read', [[moId]], { fields: ['name', 'state', 'location_src_id', 'move_raw_ids'] });
    if (!mo || mo.state !== 'done') return { ok: true };
    const room = m2o(mo.location_src_id);
    if (!room || !Object.values(ROOMS).some(r => r.location === room)) return { ok: true };
    const moves = mo.move_raw_ids?.length ? await odooExecuteWrite<any[]>('stock.move', 'read', [mo.move_raw_ids],
      { fields: ['product_id', 'quantity', 'product_uom', 'state', 'auto_produce', 'location_id'] }) : [];
    const cand = moves.filter(m => m.state === 'done' && !m.auto_produce && m2o(m.location_id) === room && Number(m.quantity) > 0);
    if (!cand.length) return { ok: true };
    const pids = Array.from(new Set(cand.map(m => m2o(m.product_id)!)));
    // "Comes with a slip" = raw-material category (any sub-category) OR in the app's slip catalogue
    // (lab_raw_materials also holds products imported from other categories).
    const raw = await odooExecuteWrite<any[]>('product.product', 'search_read',
      [[['id', 'in', pids], ['categ_id', 'child_of', RAW_MATERIAL_CATEG_ID], ['active', 'in', [true, false]]]], { fields: ['id'], limit: 1000 });
    const rawish = new Set<number>(raw.map(p => Number(p.id)));
    const { data: cat } = await db.from('lab_raw_materials').select('product_id').in('product_id', pids);
    for (const c of cat ?? []) if (c.product_id) rawish.add(Number(c.product_id));
    const lines = cand.filter(m => !rawish.has(m2o(m.product_id)!))
      .map(m => ({ productId: m2o(m.product_id)!, uomId: m2o(m.product_uom)!, qty: r3(Number(m.quantity)) })).filter(l => l.qty > 0);
    if (!lines.length) return { ok: true };
    const pk = await moveInOdoo({
      origin: `App MO ${mo.name}`, src: LAB_STOCK_ID, dst: room, lines,
      note: `<p>Lab app — bổ sung thành phần không có trong phiếu lấy kho (bao bì, bán thành phẩm) cho ${mo.name}.</p><p>Lab app — components no slip brings to the room (packaging, semi-finished) for ${mo.name}.</p>`,
    });
    return { ok: true, picking: pk.name };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e).slice(0, 300) };
  }
}

// ── Room count → Odoo ─────────────────────────────────────────────────────────────────────────
// One stock.inventory per confirmed room count, on the room's location. Rule (review 2026-10-29):
// a room is counted at the END of its production day, and the count is applied only once that
// day's MOs (consumption) are done in Odoo (nightly). Theoretical = on hand at apply time, rolled
// back only for internal transfers (slips) validated after the cut-off — the day's MOs belong
// before the count, whenever Odoo marked them done. Odoo applies on-hand-now + (counted −
// theoretical). Only counted products are applied (a product left out with a reason keeps its Odoo
// quantity). Accounting: the gap is valued (real-time valuation).
export type RoomCountPushResult = { ok: boolean; inventoryId?: number; applied?: number; waiting?: boolean; error?: string };

async function claimSession(db: Db, id: string): Promise<boolean> {
  const stale = new Date(Date.now() - STALE_MS).toISOString();
  const { data } = await db.from('lab_room_count_sessions').update({ odoo_state: 'pending', odoo_at: new Date().toISOString() })
    .eq('id', id).eq('status', 'confirmed')
    .or(`odoo_state.is.null,odoo_state.eq.error,odoo_state.eq.waiting,and(odoo_state.eq.pending,odoo_at.lt.${stale})`).select('id');
  return !!data?.length;
}

/** Room on hand now minus internal transfers in/out after `cutoff` (MO moves are not rolled back). */
async function roomTheoretical(db: Db, productIds: number[], room: number, cutoff: Date): Promise<Record<number, number>> {
  const out: Record<number, number> = {};
  for (const pid of productIds) out[pid] = 0;
  const quants = await odooExecuteWrite<any[]>('stock.quant', 'search_read',
    [[['product_id', 'in', productIds], ['location_id', '=', room]]], { fields: ['product_id', 'quantity'], limit: 5000 });
  for (const q of quants) { const pid = m2o(q.product_id)!; out[pid] = (out[pid] ?? 0) + Number(q.quantity ?? 0); }
  // Internal transfers validated in Odoo after the cut-off. A slip transfer counts as "after" only if
  // the slip itself was confirmed after the cut-off (a retry validated later is still "before"); a
  // top-up (origin "App MO …") follows its MO, which belongs before the count: never rolled back.
  const since = new Date(cutoff.getTime() - 24 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
  const all: any[] = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await odooExecuteWrite<any[]>('stock.move.line', 'search_read',
      [[['product_id', 'in', productIds], ['state', '=', 'done'], ['date', '>', since], ['picking_id.picking_type_id', '=', LAB_INTERNAL_TYPE_ID],
        '|', ['location_id', '=', room], ['location_dest_id', '=', room]]],
      { fields: ['product_id', 'quantity', 'location_id', 'location_dest_id', 'picking_id', 'date'], limit: 1000, offset, order: 'id asc' });
    all.push(...page);
    if (page.length < 1000) break;
  }
  const pickIds = Array.from(new Set(all.map(ml => m2o(ml.picking_id)).filter(Boolean))) as number[];
  const picks = pickIds.length ? await odooExecuteWrite<any[]>('stock.picking', 'read', [pickIds], { fields: ['origin'] }) : [];
  const originOf = new Map(picks.map(p => [p.id, String(p.origin ?? '')]));
  const { data: slips } = pickIds.length ? await db.from('lab_raw_withdrawals').select('odoo_picking_id, confirmed_at').in('odoo_picking_id', pickIds) : { data: [] as any[] };
  const slipAt = new Map((slips ?? []).map((w: any) => [Number(w.odoo_picking_id), w.confirmed_at as string]));
  const after = (ml: any) => {
    const pid = m2o(ml.picking_id)!;
    if (originOf.get(pid)?.startsWith('App MO ')) return false;
    const at = slipAt.get(pid);
    if (at) return Date.parse(String(at)) > cutoff.getTime();
    return Date.parse(String(ml.date).replace(' ', 'T') + 'Z') > cutoff.getTime();
  };
  {
    const mls = all.filter(after);
    for (const ml of mls) {
      const pid = m2o(ml.product_id)!; const from = m2o(ml.location_id); const to = m2o(ml.location_dest_id); const qty = Number(ml.quantity ?? 0);
      if (to === room && from !== room) out[pid] -= qty;
      if (from === room && to !== room) out[pid] += qty;
    }
  }
  for (const k of Object.keys(out)) out[Number(k)] = r3(out[Number(k)]);
  return out;
}

export async function applyRoomCountToOdoo(db: Db, sessionId: string): Promise<RoomCountPushResult> {
  const { applyInventoryLines, addMissingCountLines, tryCancelInventoryLine } = await import('@/lib/odoo-inventory');
  const { lineTotal } = await import('@/lib/room-count');
  const { data: s } = await db.from('lab_room_count_sessions').select('id, team, count_date, cutoff_at, status, odoo_state, odoo_inventory_id').eq('id', sessionId).maybeSingle();
  if (!s) return { ok: false, error: 'Session not found' };
  if (s.odoo_state === 'done') return { ok: true, inventoryId: s.odoo_inventory_id };
  if (s.status !== 'confirmed') return { ok: false, error: 'Session not confirmed' };
  const room = roomOf(s.team);
  if (!room) return { ok: false, error: 'No room for this team' };
  if (!odooWriteConfigured()) return { ok: false, error: 'Odoo write account not configured' };
  if (!(await claimSession(db, s.id))) return { ok: false, error: 'busy' };
  const save = (v: Record<string, any>) => db.from('lab_room_count_sessions').update({ ...v, odoo_at: new Date().toISOString() }).eq('id', s.id);

  // Wait until the count day's MOs of this room are done (they consume what was used before the count).
  try {
    const open = await odooExecuteWrite<any[]>('mrp.production', 'search_read',
      [[['origin', 'in', [`Lab ${s.count_date}`, `OEM ${s.count_date}`]], ['picking_type_id', '=', room.manufType], ['state', 'not in', ['done', 'cancel']]]], { fields: ['id'], limit: 1 });
    if (open.length) { await save({ odoo_state: 'waiting', odoo_error: `Chờ lệnh sản xuất ngày ${s.count_date} hoàn tất (đêm nay) / waiting for the day's MOs` }); return { ok: false, waiting: true }; }
  } catch (e: any) { await save({ odoo_state: 'error', odoo_error: String(e?.message ?? e).slice(0, 300) }); return { ok: false, error: String(e?.message ?? e) }; }

  let invId: number | null = s.odoo_inventory_id ?? null;
  try {
    const { data: es } = await db.from('lab_room_count_entries').select('id, tmpl_id, qty, is_zero, pack_label, pack_count, counted_by, counted_by_name, created_at, updated_at')
      .eq('session_id', s.id).is('deleted_at', null).limit(5000);
    const entries = (es ?? []).map((e: any) => ({ id: e.id, tmplId: e.tmpl_id, qty: Number(e.qty), isZero: !!e.is_zero, packLabel: e.pack_label, packCount: e.pack_count,
      countedBy: e.counted_by, countedByName: e.counted_by_name, createdAt: e.created_at, updatedAt: e.updated_at }));
    const tmplIds = Array.from(new Set(entries.map((e: any) => e.tmplId))) as number[];
    if (!tmplIds.length) { await save({ odoo_state: 'done', odoo_error: 'nothing counted' }); return { ok: true, applied: 0 }; }
    const { data: mats } = await db.from('lab_raw_materials').select('tmpl_id, product_id, name').in('tmpl_id', tmplIds);
    const pidOf = new Map<number, number>((mats ?? []).filter((m: any) => m.product_id).map((m: any) => [Number(m.tmpl_id), Number(m.product_id)]));
    const counted: { tmplId: number; productId: number | undefined; total: number }[] = tmplIds.map(t => ({ tmplId: t, productId: pidOf.get(t), total: Number(lineTotal(entries as any, t)?.total ?? 0) }));
    const noProduct = counted.filter(c => !c.productId);
    if (noProduct.length) throw new Error(`No Odoo product for: ${noProduct.map(c => (mats ?? []).find((m: any) => m.tmpl_id === c.tmplId)?.name ?? c.tmplId).join(', ')}`);
    const productIds = counted.map(c => c.productId!) as number[];
    const teamName = ({ hung: 'Hưng', baby_mama: 'Baby Mama', entremet: 'Entremet', baker: 'Baker' } as Record<string, string>)[s.team] ?? s.team;

    if (invId) {
      // a previous run left an adjustment: reuse it only while it is still open, else start again
      const [inv] = await odooExecuteWrite<any[]>('stock.inventory', 'read', [[invId]], { fields: ['state'] });
      if (inv?.state === 'done') { await save({ odoo_state: 'done', odoo_error: null }); return { ok: true, inventoryId: invId }; }
      if (inv?.state !== 'in_progress') invId = null;
    }
    if (!invId) {
      invId = await odooExecuteWrite<number>('stock.inventory', 'create', [{
        name: `Kiểm kê Room ${teamName} — ${s.count_date}`, product_selection: 'manual',
        product_ids: [[6, 0, productIds]], location_ids: [[6, 0, [room.location]]], accounting_date: s.count_date,
      }], { context: NO_MAIL });
      await db.from('lab_room_count_sessions').update({ odoo_inventory_id: invId }).eq('id', s.id);
      await odooExecuteWrite('stock.inventory', 'action_state_to_in_progress', [[invId]], { context: NO_MAIL });
    }
    const readLines = async () => {
      const [inv] = await odooExecuteWrite<any[]>('stock.inventory', 'read', [[invId]], { fields: ['count_line_ids', 'state'] });
      if (!inv || inv.state !== 'in_progress') throw new Error(`Odoo adjustment ${invId} is ${inv?.state ?? 'missing'}`);
      const ids: number[] = inv.count_line_ids ?? [];
      return ids.length ? odooExecuteWrite<any[]>('lpr.stock.inventory.line', 'read', [ids], { fields: ['id', 'product_id'] }) : [];
    };
    let lines = await readLines();
    const have = new Set(lines.map((l: any) => m2o(l.product_id)));
    const missing = productIds.filter(p => !have.has(p));
    if (missing.length) { await addMissingCountLines(invId!, room.location, missing); lines = await readLines(); }
    const lineOf = new Map<number, number>(lines.map((l: any) => [m2o(l.product_id) as number, Number(l.id)]));
    const noLine = productIds.filter(p => !lineOf.get(p));
    if (noLine.length) throw new Error(`No count line in Odoo for product(s) ${noLine.join(', ')}`);
    const theo = await roomTheoretical(db, productIds, room.location, new Date(s.cutoff_at));
    for (const pid of productIds) await odooExecuteWrite('lpr.stock.inventory.line', 'write', [[lineOf.get(pid)], { theoretical_qty: theo[pid] ?? 0 }], { context: NO_MAIL });
    const apply = await applyInventoryLines(counted.map(c => ({ odooCountLineId: lineOf.get(c.productId!)!, qtyCounted: r3(c.total) })));
    const log = apply.lines.map(l => ({ line: l.odooCountLineId, product: l.sku, theoretical: l.qtySystem, counted: l.qtyCounted, diff: l.diff, ok: l.ok, error: l.error ?? null }));
    const bad = apply.lines.filter(l => !l.ok);
    const [after] = await odooExecuteWrite<any[]>('stock.inventory', 'read', [[invId]], { fields: ['state'] });
    if (!apply.ok || bad.length || after?.state !== 'done') {
      // nothing applied yet → close the open adjustment so it never blocks the next try
      if (after?.state === 'in_progress' && !log.some(l => l.ok && l.diff)) { await tryCancelInventoryLine(invId!); const [c] = await odooExecuteWrite<any[]>('stock.inventory', 'read', [[invId]], { fields: ['state'] }); if (c?.state !== 'in_progress') await db.from('lab_room_count_sessions').update({ odoo_inventory_id: null }).eq('id', s.id); }
      await save({ odoo_state: 'error', odoo_error: (apply.error ?? (bad.map(b => `${b.sku}: ${b.error}`).join(' · ') || `adjustment ${invId} is ${after?.state}`)).slice(0, 800), odoo_log: log });
      return { ok: false, inventoryId: invId!, error: apply.error ?? `${bad.length} line(s) not applied` };
    }
    await save({ odoo_state: 'done', odoo_error: null, odoo_log: log });
    return { ok: true, inventoryId: invId!, applied: log.length };
  } catch (e: any) {
    const msg = String(e?.message ?? e).slice(0, 800);
    if (invId) {
      try {
        const [inv] = await odooExecuteWrite<any[]>('stock.inventory', 'read', [[invId]], { fields: ['state'] });
        if (inv?.state === 'in_progress') await tryCancelInventoryLine(invId);
        const [c] = await odooExecuteWrite<any[]>('stock.inventory', 'read', [[invId]], { fields: ['state'] });
        if (!c || c.state === 'cancel' || c.state === 'draft') await db.from('lab_room_count_sessions').update({ odoo_inventory_id: null }).eq('id', s.id);
      } catch { /* keep the id: the next run will look at it again */ }
    }
    await save({ odoo_state: 'error', odoo_error: msg });
    return { ok: false, inventoryId: invId ?? undefined, error: msg };
  }
}

/** Retries confirmed room counts (from the start day, last 10 days) not applied in Odoo yet (cron). */
export async function pushPendingRoomCounts(db: Db): Promise<{ done: number; waiting: number; errors: number }> {
  const out = { done: 0, waiting: 0, errors: 0 };
  const s = startDay();
  if (!validDay(s)) return out;
  const since = new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString();
  const stale = new Date(Date.now() - STALE_MS).toISOString();
  const { data } = await db.from('lab_room_count_sessions').select('id').eq('status', 'confirmed').gte('count_date', s).gte('confirmed_at', since)
    .or(`odoo_state.is.null,odoo_state.eq.error,odoo_state.eq.waiting,and(odoo_state.eq.pending,odoo_at.lt.${stale})`)
    .order('odoo_at', { ascending: true, nullsFirst: true }).limit(4);
  for (const r of data ?? []) {
    const res = await applyRoomCountToOdoo(db, r.id);
    if (res.ok) out.done++; else if (res.waiting) out.waiting++; else out.errors++;
  }
  return out;
}

/** topUpRoomComponents for an MO and every MO it auto-produced (any depth). */
export async function topUpRoomComponentsTree(db: Db, moId: number): Promise<{ pickings: string[]; errors: string[] }> {
  const out = { pickings: [] as string[], errors: [] as string[] };
  let level = [moId];
  for (let depth = 0; level.length && depth < 6; depth++) {
    for (const id of level) {
      const r = await topUpRoomComponents(db, id);
      if (r.picking) out.pickings.push(r.picking);
      if (!r.ok && r.error) out.errors.push(r.error);
    }
    try {
      const kids = await odooExecuteWrite<any[]>('mrp.production', 'search_read', [[['auto_parent_production_id', 'in', level]]], { fields: ['id'], limit: 500 });
      level = kids.map(k => k.id);
    } catch { level = []; }
  }
  return out;
}

/** Cron: tops up the room components of MOs done in a room (today and yesterday), a few per run. */
export async function topUpRecentRoomMOs(db: Db, max = 6): Promise<{ done: number; errors: number }> {
  const out = { done: 0, errors: 0 };
  const s = startDay();
  if (!validDay(s)) return out;
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' });
  const days = Array.from({ length: 7 }, (_, i) => fmt.format(new Date(Date.now() - i * 86400000))).filter(d => d >= s);
  if (!days.length) return out;
  const origins = days.flatMap(d => [`Lab ${d}`, `OEM ${d}`]);
  const types = Object.values(ROOMS).map(r => r.manufType);
  const mos = await odooExecuteWrite<any[]>('mrp.production', 'search_read',
    [[['origin', 'in', origins], ['picking_type_id', 'in', types], ['state', '=', 'done']]], { fields: ['id', 'name'], limit: 1000, order: 'id asc' });
  if (!mos.length) return out;
  const { data: seen } = await db.from('lab_room_topups').select('mo_odoo_id').in('mo_odoo_id', mos.map(m => m.id)).is('error', null);
  const done = new Set((seen ?? []).map((r: any) => r.mo_odoo_id));
  for (const mo of mos.filter(m => !done.has(m.id)).slice(0, max)) {
    const r = await topUpRoomComponentsTree(db, mo.id);
    await db.from('lab_room_topups').upsert({ mo_odoo_id: mo.id, mo_name: mo.name, picking_names: r.pickings, error: r.errors.join(' · ') || null });
    if (r.errors.length) out.errors++; else out.done++;
  }
  return out;
}
