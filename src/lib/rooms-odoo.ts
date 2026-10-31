// Rooms linked to Odoo (Axel, 2026-10-29). Server-only.
//
// Each team has its own room in Odoo (stock.location, sibling of LAB/Stock under the LAB view, so a
// reservation on LAB/Stock never takes from a room) and its own manufacturing operation type. From
// ROOMS_LINK_START_DAY (env, 'YYYY-MM-DD', lab day) on:
//   * a slip = an internal transfer validated in Odoo once the goods change hands (Axel, 29/10,
//     option B): the receiving chef taps "Đã nhận"; a give-back to the Kho moves when storage confirms
//     it. Not tapped: reminder after 1 h, and moved anyway after the slip's lab day (storage confirmed
//     it, so the goods are meant to have left):
//       take                → LAB/Stock → Room of the team
//       transfer team → team → Room A → Room B
//       transfer team → kho  → Room → LAB/Stock (give-back)
//   * the day's MOs are made per product and per team on the team's type: components consumed in
//     the room, semi-finished made and consumed in the room (type default destination = room, tested
//     29/10 on WH/MO/71230), finished product forced to LAB/Stock on the parent MO (deliveries
//     unchanged). Recipes only use raw materials and semi-finished (checked 29/10: OEM BoMs hold no
//     bag or carton), so nothing else has to follow the MO into the room;
//   * a confirmed room count is applied to the room once that day's MOs are done.
// Internal transfers make no accounting entry; only inventory adjustments do.
// Before the start day nothing changes (one MO per product on Lab: Manufacturing, LAB/Stock).
// Review 2026-10-29: every push first CLAIMS its row (conditional update) so the confirm click and
// the cron can never both create a transfer for the same slip.
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
    .select('id, no, team, kind, from_team, to_team, status, confirmed_at, refused_at, confirmed_by_name, taken_by, received_at, received_by_name, odoo_picking_id, odoo_state, odoo_tries')
    .eq('id', withdrawalId).maybeSingle();
  if (!w) return { state: 'error', error: 'Slip not found' };
  if (w.odoo_state === 'done' || w.odoo_state === 'skipped') return { state: w.odoo_state };
  const start = roomsLinkStartIso();
  if (w.status !== 'confirmed' || !w.confirmed_at || !start || Date.parse(w.confirmed_at) < Date.parse(start)) return { state: 'skipped' };
  // Option B: nothing moves in Odoo before the receiving chef has the goods (refused: closed below).
  if (!w.refused_at && needsChefReceipt(w) && !w.received_at) return { state: 'skipped' };
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
  // A slip handed over BEFORE the cut-off of a room count already applied in Odoo is inside that
  // count (the goods were in the room when it was counted, Odoo lacked them, the adjustment added
  // them): moving it now would count it twice (31/10, slips #163 Hưng, #164 Entremet).
  {
    const at = String(w.received_at ?? w.confirmed_at);
    const teams = [w.team, w.from_team, w.to_team].filter((t: any) => t && t !== 'kho' && roomOf(t));
    if (teams.length) {
      const { data: applied } = await db.from('lab_room_count_sessions').select('team, count_date').in('team', Array.from(new Set(teams)))
        .eq('odoo_state', 'done').gt('cutoff_at', at).limit(1);
      if (applied?.length) { await save({ odoo_state: 'skipped', odoo_error: `absorbed by room count ${applied[0].team} ${applied[0].count_date}` }); return { state: 'skipped' }; }
    }
  }

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
      note: `<p>Lab app — ${kindVi} #${w.no} · ${w.team} · ${w.taken_by ?? ''} · kho xác nhận: ${w.confirmed_by_name ?? ''} · đã nhận: ${w.received_by_name ?? ''}</p><p>Lab app — ${take ? 'storage slip' : 'transfer'} #${w.no}, confirmed by storage, received by ${w.received_by_name ?? 'storage'}.</p>`,
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
    .or(`odoo_state.is.null,odoo_state.eq.error,and(odoo_state.eq.pending,odoo_at.lt.${stale})`)
    .or('received_at.not.is.null,refused_at.not.is.null,and(kind.eq.transfer,to_team.eq.kho)').lt('odoo_tries', 30)
    .order('odoo_tries').order('confirmed_at').limit(limit);
  for (const r of data ?? []) {
    const res = await pushSlipToOdoo(db, r.id);
    if (res.state === 'done') out.done++; else if (res.state === 'error') out.errors++; else out.skipped++;
  }
  return out;
}

/** The receiving chef confirms the goods (a give-back to the Kho is received by storage itself). */
export function needsChefReceipt(w: { kind?: string | null; to_team?: string | null }): boolean {
  return !((w.kind ?? 'take') === 'transfer' && w.to_team === 'kho');
}
/** The team that receives the goods of a slip. */
export function receivingTeam(w: { kind?: string | null; team: string; to_team?: string | null }): string {
  return (w.kind ?? 'take') === 'transfer' ? (w.to_team ?? w.team) : w.team;
}

/**
 * Cron: slips confirmed by storage that no chef marked "Đã nhận".
 *   - after 1 h: one push to the receiving team;
 *   - once the slip's lab day is over: marked received (at the storage confirmation time, i.e. before
 *     any end-of-day room count) and pushed — storage confirmed it, the goods are meant to have left.
 */
export async function chaseUnreceivedSlips(db: Db): Promise<{ reminded: number; autoReceived: number }> {
  const out = { reminded: 0, autoReceived: 0 };
  const start = roomsLinkStartIso();
  if (!start) return out;
  const { data } = await db.from('lab_raw_withdrawals').select('id, no, team, kind, to_team, confirmed_at, chef_reminded_at')
    .eq('status', 'confirmed').is('refused_at', null).is('received_at', null).gte('confirmed_at', start).limit(200);
  const today = labDayUtcRange(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())).start;
  const { sendTeamPush, awaitPush } = await import('@/lib/push-notify');
  for (const w of (data ?? []).filter((x: any) => needsChefReceipt(x))) {
    if (Date.parse(w.confirmed_at) < Date.parse(today)) {
      const { data: upd } = await db.from('lab_raw_withdrawals').update({ received_at: w.confirmed_at, received_by_name: 'auto (cuối ngày / end of day)' })
        .eq('id', w.id).is('received_at', null).select('id');
      if (upd?.length) out.autoReceived++;
      continue;
    }
    if (!w.chef_reminded_at && Date.now() - Date.parse(w.confirmed_at) > 60 * 60 * 1000) {
      const { data: upd } = await db.from('lab_raw_withdrawals').update({ chef_reminded_at: new Date().toISOString() }).eq('id', w.id).is('chef_reminded_at', null).select('id');
      if (!upd?.length) continue;
      const t = receivingTeam(w);
      try {
        await awaitPush(sendTeamPush(db, t,
          { title: 'La Parisienne Lab', body: `📦 Phiếu #${w.no}: đã nhận hàng chưa? Bấm "Đã nhận" trên app.`, url: `/station/${t}`, tag: `raw-recv-${w.no}` },
          { title: 'La Parisienne Lab', body: `📦 Slip #${w.no}: received the goods? Tap "Received" in the app.`, url: `/station/${t}`, tag: `raw-recv-${w.no}` }));
        out.reminded++;
      } catch { /* push is best-effort */ }
    }
  }
  return out;
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
/**
 * Room count start (Axel, 2026-10-29): the team's MOs for everything sent to stock so far are produced
 * at once, and the moment is kept (mos_closed_at). Whatever is sent to stock afterwards (late birthday
 * cakes…) goes into new MOs whose consumption is put back when rebuilding the room at the count —
 * so the count only corrects real gaps and the later consumption stays in Odoo. Retried by the cron.
 */
export async function closeRoomMosForCount(db: Db, sessionId: string): Promise<{ closed: boolean; error?: string }> {
  const { data: s } = await db.from('lab_room_count_sessions').select('id, team, count_date, cutoff_at, mos_closed_at').eq('id', sessionId).maybeSingle();
  if (!s) return { closed: false, error: 'Session not found' };
  if (s.mos_closed_at) return { closed: true };
  const room = roomOf(s.team);
  if (!room || !roomsLinkedForDay(s.count_date)) return { closed: false, error: 'not linked' };
  if (!odooWriteConfigured()) return { closed: false, error: 'Odoo write account not configured' };
  try {
    // Drafts brought up to date with the sends first, then confirmed and produced (this team only).
    const { syncStockToOdoo } = await import('@/lib/odoo-mo-sync');
    const { confirmDoneMOs, produceMOs } = await import('@/lib/odoo-mo-confirm');
    try { await syncStockToOdoo(db as any, s.count_date, { commit: true }); } catch { /* the hourly sync catches up */ }
    await confirmDoneMOs(s.count_date, { typeId: room.manufType });
    await produceMOs(s.count_date, { typeId: room.manufType });
    const open = await odooExecuteWrite<any[]>('mrp.production', 'search_read',
      [[['origin', 'in', [`Lab ${s.count_date}`, `OEM ${s.count_date}`]], ['picking_type_id', '=', room.manufType], ['auto_parent_production_id', '=', false],
        ['state', 'not in', ['done', 'cancel']], ['create_date', '<=', String(s.cutoff_at).slice(0, 19).replace('T', ' ')]]], { fields: ['name'], limit: 5 });
    if (open.length) {
      await db.from('lab_room_count_sessions').update({ odoo_error: `MO chưa xong: ${open.map((m: any) => m.name).join(', ')}` }).eq('id', s.id);
      return { closed: false, error: `open MOs: ${open.map((m: any) => m.name).join(', ')}` };
    }
    await db.from('lab_room_count_sessions').update({ mos_closed_at: new Date().toISOString() }).eq('id', s.id).is('mos_closed_at', null);
    return { closed: true };
  } catch (e: any) { return { closed: false, error: String(e?.message ?? e) }; }
}

/** Counts started (open or confirmed) whose MOs are not closed yet — every cron run. */
export async function closePendingRoomMos(db: Db): Promise<{ closed: number; open: number }> {
  const out = { closed: 0, open: 0 };
  const sd = startDay();
  if (!validDay(sd)) return out;
  const since = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString();
  const { data } = await db.from('lab_room_count_sessions').select('id').is('mos_closed_at', null).in('status', ['open', 'confirmed'])
    .gte('count_date', sd).gte('cutoff_at', since).limit(4);
  for (const r of data ?? []) { const x = await closeRoomMosForCount(db, r.id); if (x.closed) out.closed++; else out.open++; }
  return out;
}

async function roomTheoretical(db: Db, productIds: number[], room: number, cutoff: Date, mosClosedAt?: Date | null): Promise<Record<number, number>> {
  const out: Record<number, number> = {};
  for (const pid of productIds) out[pid] = 0;
  const quants = await odooExecuteWrite<any[]>('stock.quant', 'search_read',
    [[['product_id', 'in', productIds], ['location_id', '=', room]]], { fields: ['product_id', 'quantity'], limit: 5000 });
  for (const q of quants) { const pid = m2o(q.product_id)!; out[pid] = (out[pid] ?? 0) + Number(q.quantity ?? 0); }
  // Internal transfers validated in Odoo after the cut-off. A slip transfer counts as "after" only if
  // the goods were received after the cut-off (a retry validated later is still "before").
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
  const { data: slips } = pickIds.length ? await db.from('lab_raw_withdrawals').select('odoo_picking_id, confirmed_at, received_at').in('odoo_picking_id', pickIds) : { data: [] as any[] };
  const slipAt = new Map((slips ?? []).map((w: any) => [Number(w.odoo_picking_id), (w.received_at ?? w.confirmed_at) as string]));
  const after = (ml: any) => {
    const pid = m2o(ml.picking_id)!;
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
  // Production after the count's MOs were closed (sent to stock after the count started): its
  // consumption from the room is put back, its output into the room taken out — the room as it was.
  // Unbuilds are left alone (they correct production made before the count).
  if (mosClosedAt) {
    const mark = mosClosedAt.toISOString().slice(0, 19).replace('T', ' ');
    for (let offset = 0; ; offset += 1000) {
      const page = await odooExecuteWrite<any[]>('stock.move.line', 'search_read',
        [[['product_id', 'in', productIds], ['state', '=', 'done'], ['date', '>', mark],
          '|', ['location_id', '=', room], ['location_dest_id', '=', room],
          '|', ['move_id.raw_material_production_id', '!=', false], ['move_id.production_id', '!=', false]]],
        { fields: ['product_id', 'quantity', 'location_id', 'location_dest_id'], limit: 1000, offset, order: 'id asc' });
      for (const ml of page) {
        const pid = m2o(ml.product_id)!; const from = m2o(ml.location_id); const to = m2o(ml.location_dest_id); const qty = Number(ml.quantity ?? 0);
        if (from === room && to !== room) out[pid] += qty;
        if (to === room && from !== room) out[pid] -= qty;
      }
      if (page.length < 1000) break;
    }
  }
  for (const k of Object.keys(out)) out[Number(k)] = r3(out[Number(k)]);
  return out;
}

export async function applyRoomCountToOdoo(db: Db, sessionId: string): Promise<RoomCountPushResult> {
  const { applyInventoryLines, addMissingCountLines, tryCancelInventoryLine } = await import('@/lib/odoo-inventory');
  const { lineTotal } = await import('@/lib/room-count');
  const { data: s } = await db.from('lab_room_count_sessions').select('id, team, count_date, cutoff_at, status, odoo_state, odoo_inventory_id, mos_closed_at').eq('id', sessionId).maybeSingle();
  if (!s) return { ok: false, error: 'Session not found' };
  if (s.odoo_state === 'done') return { ok: true, inventoryId: s.odoo_inventory_id };
  if (s.status !== 'confirmed') return { ok: false, error: 'Session not confirmed' };
  const room = roomOf(s.team);
  if (!room) return { ok: false, error: 'No room for this team' };
  if (!odooWriteConfigured()) return { ok: false, error: 'Odoo write account not configured' };
  if (!(await claimSession(db, s.id))) return { ok: false, error: 'busy' };
  const save = (v: Record<string, any>) => db.from('lab_room_count_sessions').update({ ...v, odoo_at: new Date().toISOString() }).eq('id', s.id);

  // The MOs of what was sent to stock before the count must be produced first (closeRoomMosForCount,
  // run when the count starts). Later sends need not wait: their consumption is put back below.
  let mosClosedAt: Date | null = s.mos_closed_at ? new Date(s.mos_closed_at) : null;
  if (!mosClosedAt) {
    const c = await closeRoomMosForCount(db, s.id);
    if (c.closed) {
      const { data: s2 } = await db.from('lab_room_count_sessions').select('mos_closed_at').eq('id', s.id).maybeSingle();
      mosClosedAt = s2?.mos_closed_at ? new Date(s2.mos_closed_at) : null;
    }
    if (!mosClosedAt) { await save({ odoo_state: 'waiting', odoo_error: `Chờ lệnh sản xuất trước giờ kiểm kê hoàn tất / waiting for the MOs before the count${c.error ? ` — ${c.error}` : ''}`.slice(0, 300) }); return { ok: false, waiting: true }; }
  }

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
    const theo = await roomTheoretical(db, productIds, room.location, new Date(s.cutoff_at), mosClosedAt);
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
