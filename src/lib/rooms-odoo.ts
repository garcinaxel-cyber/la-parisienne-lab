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
//     unchanged);
//   * a confirmed room count is applied to the room at its cut-off.
// Internal transfers make no accounting entry; only inventory adjustments do.
// Before the start day nothing changes (one MO per product on Lab: Manufacturing, LAB/Stock).
import { odooExecuteWrite, odooWriteConfigured, labDayUtcRange } from '@/lib/odoo';

export const LAB_STOCK_ID = 8;
export const LAB_INTERNAL_TYPE_ID = 7;      // Lab: Transferts internes
export const LAB_MANUF_TYPE_ID = 11;        // Lab: Manufacturing (legacy, LAB/Stock → LAB/Stock)

export const ROOMS: Record<string, { location: number; manufType: number }> = {
  hung: { location: 219, manufType: 314 },
  baby_mama: { location: 220, manufType: 315 },
  entremet: { location: 221, manufType: 316 },
  baker: { location: 222, manufType: 317 },
};

const startDay = () => (process.env.ROOMS_LINK_START_DAY ?? '').trim();

/** Rooms are linked for this lab day ('YYYY-MM-DD')? */
export function roomsLinkedForDay(day: string): boolean {
  const s = startDay();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && day >= s;
}
/** First instant (ISO) the link applies to, or null when it is off. */
export function roomsLinkStartIso(): string | null {
  const s = startDay();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? labDayUtcRange(s).start : null;
}
export function roomOf(team: string | null | undefined) { return team ? ROOMS[team] ?? null : null; }

function tmo<T>(p: Promise<T>, ms: number, l: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, r) => setTimeout(() => r(new Error('timeout ' + l)), ms))]);
}
const NO_MAIL = { tracking_disable: true, mail_create_nolog: true, mail_notrack: true };
const r3 = (n: number) => Math.round(n * 1000) / 1000;

type Db = any;

export type SlipPushResult = { state: 'done' | 'error' | 'skipped'; pickingName?: string | null; error?: string | null };

/**
 * Pushes one storage-confirmed slip to Odoo as a validated internal transfer. Idempotent: the
 * picking id is saved on the slip as soon as it exists, and a done picking is never redone.
 */
export async function pushSlipToOdoo(db: Db, withdrawalId: string): Promise<SlipPushResult> {
  const { data: w } = await db.from('lab_raw_withdrawals')
    .select('id, no, team, kind, from_team, to_team, status, confirmed_at, refused_at, confirmed_by_name, taken_by, odoo_picking_id, odoo_state, odoo_tries')
    .eq('id', withdrawalId).maybeSingle();
  if (!w) return { state: 'error', error: 'Slip not found' };
  const save = async (v: Record<string, any>) => {
    await db.from('lab_raw_withdrawals').update({ ...v, odoo_at: new Date().toISOString(), odoo_tries: Number(w.odoo_tries ?? 0) + 1 }).eq('id', w.id);
  };
  if (w.odoo_state === 'done' || w.odoo_state === 'skipped') return { state: w.odoo_state };
  const start = roomsLinkStartIso();
  if (w.status !== 'confirmed' || !w.confirmed_at || !start || w.confirmed_at < start) return { state: 'skipped' };
  if (w.refused_at) { await save({ odoo_state: 'skipped', odoo_error: 'refused' }); return { state: 'skipped' }; }

  // Where from / where to.
  let src: number | null = null, dst: number | null = null;
  if ((w.kind ?? 'take') === 'take') { src = LAB_STOCK_ID; dst = roomOf(w.team)?.location ?? null; }
  else {
    src = w.from_team === 'kho' ? LAB_STOCK_ID : roomOf(w.from_team)?.location ?? null;
    dst = w.to_team === 'kho' ? LAB_STOCK_ID : roomOf(w.to_team)?.location ?? null;
  }
  if (!src || !dst || src === dst) { await save({ odoo_state: 'skipped', odoo_error: 'no room for this team' }); return { state: 'skipped' }; }
  if (!odooWriteConfigured()) return { state: 'error', error: 'Odoo write account not configured' };

  try {
    const { data: lines } = await db.from('lab_raw_withdrawal_lines').select('id, tmpl_id, name, qty, corrected_qty').eq('withdrawal_id', w.id);
    const qtyByTmpl = new Map<number, number>();
    for (const l of lines ?? []) {
      const q = Number(l.corrected_qty ?? l.qty);
      if (l.tmpl_id && q > 0) qtyByTmpl.set(l.tmpl_id, r3((qtyByTmpl.get(l.tmpl_id) ?? 0) + q));
    }
    if (!qtyByTmpl.size) { await save({ odoo_state: 'skipped', odoo_error: 'nothing given' }); return { state: 'skipped' }; }

    // Products and their Odoo unit (the slip quantity is in the product's own unit: the app catalogue
    // takes its unit from Odoo).
    const tmplIds = Array.from(qtyByTmpl.keys());
    const prods = await tmo(odooExecuteWrite<any[]>('product.product', 'search_read',
      [[['product_tmpl_id', 'in', tmplIds], ['active', 'in', [true, false]]]], { fields: ['id', 'product_tmpl_id', 'uom_id'], limit: 500 }), 20000, 'products');
    const prodOf = new Map<number, any>();
    for (const p of prods) { const t = Array.isArray(p.product_tmpl_id) ? p.product_tmpl_id[0] : p.product_tmpl_id; if (!prodOf.has(t)) prodOf.set(t, p); }
    const missing = tmplIds.filter(t => !prodOf.has(t));
    if (missing.length) throw new Error(`Odoo product not found for template(s) ${missing.join(', ')}`);

    const kindVi = (w.kind ?? 'take') === 'take' ? 'phiếu lấy kho' : 'phiếu chuyển';
    const origin = `App ${kindVi} #${w.no}`;
    let pickingId: number | null = w.odoo_picking_id ?? null;
    if (!pickingId) {
      pickingId = await tmo(odooExecuteWrite<number>('stock.picking', 'create', [{
        picking_type_id: LAB_INTERNAL_TYPE_ID, location_id: src, location_dest_id: dst, origin,
        note: `<p>Lab app — ${kindVi} #${w.no} · ${w.team} · ${w.taken_by ?? ''} · kho xác nhận: ${w.confirmed_by_name ?? ''}</p><p>Lab app — ${(w.kind ?? 'take') === 'take' ? 'storage slip' : 'transfer'} #${w.no}, confirmed by storage.</p>`,
        move_ids: tmplIds.map(t => {
          const p = prodOf.get(t);
          return [0, 0, { name: origin, product_id: p.id, product_uom: Array.isArray(p.uom_id) ? p.uom_id[0] : p.uom_id,
            product_uom_qty: qtyByTmpl.get(t)!, location_id: src, location_dest_id: dst }];
        }),
      }], { context: NO_MAIL }), 30000, 'create picking');
      await db.from('lab_raw_withdrawals').update({ odoo_picking_id: pickingId }).eq('id', w.id);
    }
    const [pk] = await tmo(odooExecuteWrite<any[]>('stock.picking', 'read', [[pickingId]], { fields: ['name', 'state', 'move_ids'] }), 15000, 'read picking');
    if (!pk) throw new Error(`Picking ${pickingId} not found`);
    if (pk.state !== 'done') {
      if (pk.state === 'draft') await tmo(odooExecuteWrite('stock.picking', 'action_confirm', [[pickingId]], { context: NO_MAIL }), 30000, 'confirm');
      // Done quantity = what storage gave, whatever is on hand (a room or LAB/Stock may go negative
      // until the count puts it right).
      const moves = await tmo(odooExecuteWrite<any[]>('stock.move', 'read', [pk.move_ids], { fields: ['id', 'product_uom_qty'] }), 15000, 'moves');
      for (const m of moves) await tmo(odooExecuteWrite('stock.move', 'write', [[m.id], { quantity: m.product_uom_qty, picked: true }], { context: NO_MAIL }), 15000, 'move qty');
      const res = await tmo(odooExecuteWrite<any>('stock.picking', 'button_validate', [[pickingId]], { context: { ...NO_MAIL, skip_backorder: true, cancel_backorder: true } }), 40000, 'validate');
      if (res && typeof res === 'object' && res.res_model) throw new Error(`Odoo asked for confirmation (${res.res_model})`);
      const [after] = await tmo(odooExecuteWrite<any[]>('stock.picking', 'read', [[pickingId]], { fields: ['name', 'state'] }), 15000, 'reread');
      if (after?.state !== 'done') throw new Error(`${after?.name ?? pickingId} not done (state ${after?.state})`);
    }
    await save({ odoo_state: 'done', odoo_picking_name: pk.name, odoo_error: null });
    return { state: 'done', pickingName: pk.name };
  } catch (e: any) {
    const msg = String(e?.message ?? e).slice(0, 500);
    await save({ odoo_state: 'error', odoo_error: msg });
    return { state: 'error', error: msg };
  }
}

/** Retries every confirmed slip since the start that is not in Odoo yet (cron, every 15 min). */
export async function pushPendingSlips(db: Db, limit = 25): Promise<{ done: number; errors: number; skipped: number }> {
  const start = roomsLinkStartIso();
  const out = { done: 0, errors: 0, skipped: 0 };
  if (!start) return out;
  const { data } = await db.from('lab_raw_withdrawals').select('id, odoo_tries').eq('status', 'confirmed').gte('confirmed_at', start)
    .or('odoo_state.is.null,odoo_state.eq.error').lt('odoo_tries', 20).order('confirmed_at').limit(limit);
  for (const r of data ?? []) {
    const res = await pushSlipToOdoo(db, r.id);
    if (res.state === 'done') out.done++; else if (res.state === 'error') out.errors++; else out.skipped++;
  }
  return out;
}

// ── Room count → Odoo ─────────────────────────────────────────────────────────────────────────
// One stock.inventory per confirmed room count, on the room's location, dated at the count's
// cut-off. Every line's theoretical quantity is rolled back to the cut-off (on hand now − moves after
// it), so slips and MOs that happened while the team was counting are kept: Odoo applies
// on-hand-now + (counted − theoretical-at-cut-off). Only counted products are applied (a product left
// out with a reason keeps its Odoo quantity). Accounting: the gap is valued (real-time valuation).
export type RoomCountPushResult = { ok: boolean; inventoryId?: number; applied?: number; error?: string };

export async function applyRoomCountToOdoo(db: Db, sessionId: string): Promise<RoomCountPushResult> {
  const { applyInventoryLines, addMissingCountLines, theoreticalAtCutoff, tryCancelInventoryLine } = await import('@/lib/odoo-inventory');
  const { lineTotal } = await import('@/lib/room-count');
  const { data: s } = await db.from('lab_room_count_sessions').select('id, team, count_date, cutoff_at, status, odoo_state, odoo_inventory_id').eq('id', sessionId).maybeSingle();
  if (!s) return { ok: false, error: 'Session not found' };
  if (s.odoo_state === 'done') return { ok: true, inventoryId: s.odoo_inventory_id };
  if (s.status !== 'confirmed') return { ok: false, error: 'Session not confirmed' };
  const room = roomOf(s.team);
  if (!room) return { ok: false, error: 'No room for this team' };
  if (!odooWriteConfigured()) return { ok: false, error: 'Odoo write account not configured' };
  const save = (v: Record<string, any>) => db.from('lab_room_count_sessions').update({ ...v, odoo_at: new Date().toISOString() }).eq('id', s.id);

  let invId: number | null = s.odoo_inventory_id ?? null;
  let createdHere = false;
  try {
    const { data: es } = await db.from('lab_room_count_entries').select('id, tmpl_id, qty, is_zero, pack_label, pack_count, counted_by, counted_by_name, created_at, updated_at')
      .eq('session_id', s.id).is('deleted_at', null).limit(5000);
    const entries = (es ?? []).map((e: any) => ({ id: e.id, tmplId: e.tmpl_id, qty: Number(e.qty), isZero: !!e.is_zero, packLabel: e.pack_label, packCount: e.pack_count,
      countedBy: e.counted_by, countedByName: e.counted_by_name, createdAt: e.created_at, updatedAt: e.updated_at }));
    const tmplIds = Array.from(new Set(entries.map((e: any) => e.tmplId))) as number[];
    if (!tmplIds.length) { await save({ odoo_state: 'done', odoo_error: 'nothing counted' }); return { ok: true, applied: 0 }; }
    const { data: mats } = await db.from('lab_raw_materials').select('tmpl_id, product_id').in('tmpl_id', tmplIds);
    const pidOf = new Map((mats ?? []).filter((m: any) => m.product_id).map((m: any) => [m.tmpl_id, Number(m.product_id)]));
    const counted = tmplIds.map(t => ({ tmplId: t, productId: pidOf.get(t), total: lineTotal(entries as any, t)?.total ?? 0 }));
    const noProduct = counted.filter(c => !c.productId);
    if (noProduct.length) throw new Error(`No Odoo product for template(s) ${noProduct.map(c => c.tmplId).join(', ')}`);
    const productIds = counted.map(c => c.productId!) as number[];
    const cutoff = new Date(s.cutoff_at);
    const teamName = { hung: 'Hưng', baby_mama: 'Baby Mama', entremet: 'Entremet', baker: 'Baker' }[s.team as string] ?? s.team;

    if (!invId) {
      invId = await odooExecuteWrite<number>('stock.inventory', 'create', [{
        name: `Kiểm kê Room ${teamName} — ${s.count_date}`, product_selection: 'manual',
        product_ids: [[6, 0, productIds]], location_ids: [[6, 0, [room.location]]],
        date: cutoff.toISOString().slice(0, 19).replace('T', ' '), accounting_date: s.count_date,
      }], { context: NO_MAIL });
      createdHere = true;
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
    const have = new Set(lines.map((l: any) => (Array.isArray(l.product_id) ? l.product_id[0] : l.product_id)));
    const missing = productIds.filter(p => !have.has(p));
    if (missing.length) { await addMissingCountLines(invId!, room.location, missing); lines = await readLines(); }
    const lineOf = new Map(lines.map((l: any) => [Array.isArray(l.product_id) ? l.product_id[0] : l.product_id, l.id]));
    const theo = await theoreticalAtCutoff(productIds, room.location, cutoff);
    for (const pid of productIds) {
      const lid = lineOf.get(pid);
      if (lid) await odooExecuteWrite('lpr.stock.inventory.line', 'write', [[lid], { theoretical_qty: r3(theo[pid] ?? 0) }], { context: NO_MAIL });
    }
    const apply = await applyInventoryLines(counted.filter(c => lineOf.get(c.productId!)).map(c => ({ odooCountLineId: lineOf.get(c.productId!)!, qtyCounted: r3(c.total) })));
    const bad = apply.lines.filter(l => !l.ok);
    const log = apply.lines.map(l => ({ line: l.odooCountLineId, product: l.sku, theoretical: l.qtySystem, counted: l.qtyCounted, diff: l.diff, ok: l.ok, error: l.error ?? null }));
    if (!apply.ok || bad.length) {
      await save({ odoo_state: 'error', odoo_error: (apply.error ?? bad.map(b => `${b.sku}: ${b.error}`).join(' · ')).slice(0, 800), odoo_log: log });
      return { ok: false, inventoryId: invId!, error: apply.error ?? `${bad.length} line(s) not applied` };
    }
    await save({ odoo_state: 'done', odoo_error: null, odoo_log: log });
    return { ok: true, inventoryId: invId!, applied: log.length };
  } catch (e: any) {
    const msg = String(e?.message ?? e).slice(0, 800);
    if (createdHere && invId) { try { await tryCancelInventoryLine(invId); } catch { /* best-effort */ } await db.from('lab_room_count_sessions').update({ odoo_inventory_id: null }).eq('id', s.id); }
    await save({ odoo_state: 'error', odoo_error: msg });
    return { ok: false, inventoryId: invId ?? undefined, error: msg };
  }
}

/** Retries confirmed room counts (from the start day, last 3 days) not applied in Odoo yet (cron). */
export async function pushPendingRoomCounts(db: Db): Promise<{ done: number; errors: number }> {
  const out = { done: 0, errors: 0 };
  const s = startDay();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return out;
  const since = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString();
  const { data } = await db.from('lab_room_count_sessions').select('id, count_date').eq('status', 'confirmed').gte('count_date', s)
    .gte('confirmed_at', since).or('odoo_state.is.null,odoo_state.eq.error').limit(4);
  for (const r of data ?? []) { const res = await applyRoomCountToOdoo(db, r.id); if (res.ok) out.done++; else out.errors++; }
  return out;
}
