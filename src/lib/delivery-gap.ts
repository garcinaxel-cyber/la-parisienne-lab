import type { SupabaseClient } from '@supabase/supabase-js';
import { isStockFamily } from '@/lib/delivery-check-production';
import { labDateOf, labDayUtcRange, odooWriteConfigured } from '@/lib/odoo';
import { syncStockToOdoo, sentToStockBySku } from '@/lib/odoo-mo-sync';
import { reduceDayProduction } from '@/lib/odoo-unbuild';
import { withLock } from '@/lib/named-lock';
import { recordLabLoss, brokenReasonTag, retryLossScrap } from '@/lib/lab-loss';

// Delivery check gap barriers (Axel, 2026-10-24 — maquettes delivery-check-gap-barriers-v2 /
// real-ui-1/2/3). Everything is counted per PRODUCT for the WHOLE delivery day (all orders),
// never per card or per order: Odoo MOs follow what was sent to stock per product per day, and a
// card can serve several orders. The missing unit simply shows on the order that leaves last.
// Never blocks: a forgotten transfer is added by the app itself when the kitchen declared enough.

export type Family = 'stock' | 'mto' | 'packaging';

export interface DayPool {
  sku: string; date: string; family: Family;
  planned: number; produced: number; fromStock: number; sent: number; lost: number;
  otherLeft: number; pendingLeft: number; blockedReasons: string[]; partial: boolean;
}

type Card = {
  id: string; team: string; status: string; cancelled: boolean; is_extra: boolean;
  total_qty: number; qty_to_produce: number | null; qty_produced: number | null; qty_sent_total: number | null;
  breakdown: any; blocked_reason: string | null; product_name_vi: string; product_name_en: string | null;
  variant_label: string | null; image_url: string | null; produced_at: string | null;
};

async function loadCards(sb: SupabaseClient, date: string, sku: string): Promise<Card[]> {
  const [{ data: variants }, { data: imports }] = await Promise.all([
    sb.from('lab_fiche_variants').select('id').eq('sku', sku),
    sb.from('lab_imports').select('id').eq('delivery_date', date),
  ]);
  const vids = (variants ?? []).map((v: any) => v.id); const iids = (imports ?? []).map((i: any) => i.id);
  if (!vids.length || !iids.length) return [];
  const { data } = await sb.from('lab_assignments')
    .select('id, team, status, cancelled, is_extra, total_qty, qty_to_produce, qty_produced, qty_sent_total, breakdown, blocked_reason, product_name_vi, product_name_en, variant_label, image_url, produced_at')
    .in('import_id', iids).in('variant_id', vids);
  return ((data ?? []) as Card[]).filter(c => !c.cancelled);
}

export async function computeDayPool(sb: SupabaseClient, date: string, sku: string, excludeLineId: string | null, productCategory: string | null, lineCategory: string | null): Promise<{ pool: DayPool; cards: Card[] }> {
  const cards = await loadCards(sb, date, sku);
  const { start, end } = labDayUtcRange(date);
  const [{ data: lines }, { data: lossA }, { data: lossB }] = await Promise.all([
    sb.from('lab_delivery_check_lines').select('id, qty_checked, qty_expected, status, delivery_order_id').eq('delivery_date', date).eq('sku', sku).eq('category', 'production'),
    sb.from('lab_internal_losses').select('id, qty').eq('sku', sku).eq('delivery_date', date),
    sb.from('lab_internal_losses').select('id, qty').eq('sku', sku).is('delivery_date', null).gte('reported_at', start).lt('reported_at', end),
  ]);
  // Lines of orders marked "not delivered" don't leave.
  const orderIds = Array.from(new Set((lines ?? []).map((l: any) => l.delivery_order_id)));
  const { data: hdrs } = orderIds.length ? await sb.from('lab_delivery_orders').select('id, marked_not_delivered').in('id', orderIds) : { data: [] as any[] };
  const skip = new Set((hdrs ?? []).filter((h: any) => h.marked_not_delivered).map((h: any) => h.id));
  // Lines not checked yet still need their units: reserve what they ordered (review 2026-10-24),
  // otherwise the first order checked would take "not made" units the later ones need.
  let otherLeft = 0, pendingLeft = 0;
  for (const l of lines ?? []) {
    if (l.id === excludeLineId || skip.has(l.delivery_order_id)) continue;
    if (l.status === 'pending' || l.qty_checked == null) pendingLeft += Number(l.qty_expected) || 0;
    else otherLeft += Number(l.qty_checked) || 0;
  }
  const lost = [...(lossA ?? []), ...(lossB ?? [])].reduce((s, r: any) => s + (Number(r.qty) || 0), 0);
  let planned = 0, produced = 0, fromStock = 0, sent = 0; const blockedReasons: string[] = []; let partial = false;
  for (const c of cards) {
    const q = Number(c.qty_to_produce ?? c.total_qty) || 0;
    if (c.status === 'skip') { fromStock += q; continue; }
    if (c.status === 'blocked') { if (c.blocked_reason && !blockedReasons.includes(c.blocked_reason)) blockedReasons.push(c.blocked_reason); continue; }
    if (!c.is_extra) planned += q;
    produced += Number(c.qty_produced) || 0;
    sent += Number(c.qty_sent_total) || 0;
    if (!c.is_extra && (c.status === 'partial' || (Number(c.qty_produced) || 0) < q)) partial = true;
  }
  const family: Family = lineCategory === 'packaging' ? 'packaging'
    : (isStockFamily(productCategory) || (fromStock > 0 && produced === 0)) ? 'stock' : 'mto';
  return { pool: { sku, date, family, planned, produced, fromStock, sent, lost, otherLeft, pendingLeft, blockedReasons, partial }, cards };
}

// Lab reserve of a made-to-order product (Axel, 2026-10-24): the ONLY stock of such cakes is extra
// production. Counted by the app, never from Odoo stock (Odoo can be wrong):
//   + extra production sent to stock (received or not yet), last 3 days (fresh products)
//   + "made without order → kept at the Lab" answers, same window
//   − units served from it: cards "Có sẵn" (skip) and delivery-check lines settled "from_lab_stock"
//   − Lab losses of that product in the window
export const RESERVE_DAYS = 3;
export async function labReserve(sb: SupabaseClient, sku: string, date: string, excludeLineId: string | null = null): Promise<number> {
  const from = new Date(new Date(`${date}T00:00:00Z`).getTime() - (RESERVE_DAYS - 1) * 86400000).toISOString().slice(0, 10);
  const startUtc = labDayUtcRange(from).start; const endUtc = labDayUtcRange(date).end;
  const { data: variants } = await sb.from('lab_fiche_variants').select('id').eq('sku', sku);
  const vids = (variants ?? []).map((v: any) => v.id);
  // extra received
  let added = 0;
  // Extra SENT to stock counts even if not received yet: its Odoo MO already exists (MOs follow
  // what is sent), so counting it as 'not declared' would create it twice.
  const { data: trs } = await sb.from('lab_stock_transfers').select('id').neq('status', 'cancelled').is('cancelled_at', null).gte('created_at', startUtc).lt('created_at', endUtc);
  const tids = (trs ?? []).map((t: any) => t.id);
  for (let i = 0; i < tids.length; i += 100) {
    const { data: tls } = await sb.from('lab_stock_transfer_lines').select('assignment_id, qty_sent, qty_received').eq('sku', sku).in('transfer_id', tids.slice(i, i + 100));
    const aids = Array.from(new Set((tls ?? []).map((t: any) => t.assignment_id).filter(Boolean)));
    if (!aids.length) continue;
    const { data: ex } = await sb.from('lab_assignments').select('id').in('id', aids).eq('is_extra', true);
    const extra = new Set((ex ?? []).map((a: any) => a.id));
    for (const t of tls ?? []) if (extra.has(t.assignment_id)) added += Number(t.qty_received ?? t.qty_sent) || 0;
  }
  const { data: kept } = await sb.from('lab_made_without_order').select('qty').eq('sku', sku).eq('resolution', 'to_stock').gte('delivery_date', from).lte('delivery_date', date);
  for (const k of kept ?? []) added += Number(k.qty) || 0;
  // used
  let used = 0;
  if (vids.length) {
    const { data: imps } = await sb.from('lab_imports').select('id').gte('delivery_date', from).lte('delivery_date', date);
    const iids = (imps ?? []).map((i: any) => i.id);
    if (iids.length) {
      const { data: skips } = await sb.from('lab_assignments').select('qty_to_produce, total_qty').in('import_id', iids).in('variant_id', vids).eq('status', 'skip').eq('cancelled', false);
      for (const c of skips ?? []) used += Number(c.qty_to_produce ?? c.total_qty) || 0;
    }
  }
  let q = sb.from('lab_delivery_check_lines').select('id, resolution_qty').eq('sku', sku).eq('resolution', 'from_lab_stock').gte('delivery_date', from).lte('delivery_date', date);
  if (excludeLineId) q = q.neq('id', excludeLineId);
  const { data: fromStock } = await q;
  for (const l of fromStock ?? []) used += Number(l.resolution_qty) || 0;
  const { data: losses } = await sb.from('lab_internal_losses').select('qty').eq('sku', sku).gte('reported_at', startUtc).lt('reported_at', endUtc);
  for (const l of losses ?? []) used += Number(l.qty) || 0;
  return Math.max(0, added - used);
}

export interface GapContext {
  family: Family; dir: 'short' | 'over'; diff: number;
  made: number; sent: number; otherLeft: number; lost: number; thisQty: number; expected: number;
  // short + made-to-order: nothing physically left → "Bếp chưa làm" is automatic (no question)
  autoNotMade: boolean; autoNote: string | null;
  // over + made-to-order: production covers it → just a confirmation
  madeCovers: boolean;
  // Lab reserve of EXTRA production for this product, counted by the app (over + made-to-order)
  reserve?: number;
}

export function contextFor(pool: DayPool, expected: number, qty: number): GapContext {
  const dir = qty < expected ? 'short' : 'over';
  const diff = Math.abs(qty - expected);
  const available = pool.produced + pool.fromStock - pool.lost - pool.otherLeft - pool.pendingLeft;
  const autoNotMade = pool.family === 'mto' && dir === 'short' && available <= qty;
  const autoNote = autoNotMade
    ? (pool.blockedReasons.length ? pool.blockedReasons.join(', ') : `${pool.produced}/${pool.planned}`)
    : null;
  return {
    family: pool.family, dir, diff, made: pool.produced, sent: pool.sent, otherLeft: pool.otherLeft, lost: pool.lost,
    thisQty: qty, expected, autoNotMade, autoNote, madeCovers: dir === 'over' && available >= qty,
  };
}

// ── Follow-up after a line is saved (runs from a second call, never makes the assistant wait) ──

async function addAutoTransfer(sb: SupabaseClient, cards: Card[], qty: number, sku: string, date: string, orderRef: string, byName: string | null): Promise<number> {
  let left = Math.round(qty); if (left <= 0) return 0;
  // Re-read the cards right before writing: another follow-up may have just sent the same units.
  const { data: fresh } = await sb.from('lab_assignments').select('id, qty_produced, qty_sent_total').in('id', cards.map(c => c.id));
  for (const f of fresh ?? []) { const c = cards.find(x => x.id === f.id); if (c) { c.qty_produced = f.qty_produced; c.qty_sent_total = f.qty_sent_total; } }
  const lines: any[] = []; const bumps: Record<string, number> = {};
  for (const c of cards.filter(x => x.status !== 'skip' && x.status !== 'blocked' && !x.is_extra)) {
    const room = (Number(c.qty_produced) || 0) - (Number(c.qty_sent_total) || 0);
    if (room <= 0 || left <= 0) continue;
    const q = Math.min(room, left); left -= q; bumps[c.id] = q;
    lines.push({ assignment_id: c.id, product_name_vi: c.product_name_vi, product_name_en: c.product_name_en, sku, variant_label: c.variant_label, image_url: c.image_url, delivery_date: date, qty_sent: q, team: c.team });
  }
  if (!lines.length) return 0;
  const byTeam: Record<string, any[]> = {};
  for (const l of lines) (byTeam[l.team] ??= []).push(l);
  let total = 0;
  for (const [team, ls] of Object.entries(byTeam)) {
    const now = new Date().toISOString();
    const { data: t, error } = await sb.from('lab_stock_transfers').insert({
      team, created_by_name: 'Tự động · kiểm giao hàng', status: 'received', received_at: now, received_by_name: 'auto',
      is_auto: true, source_ref: orderRef, note: `Auto transfer at delivery check (${orderRef}) — kitchen forgot to send to stock${byName ? ` · ${byName}` : ''}`,
    }).select('id').single();
    if (error || !t) continue;
    // Reserve on the card atomically first (lab_add_sent refuses to go above what was produced):
    // two follow-ups or a chef send at the same moment can never send the same units twice.
    const okLines: any[] = [];
    for (const l of ls) {
      const { data: n, error: e2 } = await sb.rpc('lab_add_sent', { p_card: l.assignment_id, p_qty: l.qty_sent });
      if (e2 || n == null) continue;
      const c = cards.find(x => x.id === l.assignment_id); if (c) c.qty_sent_total = n;
      okLines.push(l); total += l.qty_sent;
    }
    if (okLines.length) await sb.from('lab_stock_transfer_lines').insert(okLines.map(({ team: _t, ...l }) => ({ ...l, transfer_id: t.id })));
    else await sb.from('lab_stock_transfers').update({ status: 'cancelled', cancelled_at: new Date().toISOString(), cancelled_by_name: 'auto (nothing left to send)' }).eq('id', t.id);
  }
  return total;
}

function cardForOrder(cards: Card[], orderRef: string): Card | null {
  const usable = cards.filter(c => c.status !== 'skip' && c.status !== 'blocked');
  const mine = usable.find(c => Array.isArray(c.breakdown) && c.breakdown.some((b: any) => b?.order_ref === orderRef));
  return mine ?? usable.sort((a, b) => String(b.produced_at ?? '').localeCompare(String(a.produced_at ?? '')))[0] ?? null;
}

// Lower the kitchen count by `qty` (cards of one product, one day), take back what was sent to
// stock beyond it, and bring the Odoo production of each transfer day down to match. Shared by
// "Bếp chưa làm" (delivery check) and "made without order → never made" (tasks tab).
export async function removeProduced(sb: SupabaseClient, cards: Card[], sku: string, qty: number, note: string, preferOrderRef: string | null): Promise<{ refs: string[]; errs: string[] }> {
  const refs: string[] = []; const errs: string[] = [];
  let left = qty;
  const ordered = [preferOrderRef ? cardForOrder(cards, preferOrderRef) : null, ...cards].filter((c, i, a) => c && a.indexOf(c) === i) as Card[];
  for (const c of ordered) {
    if (left <= 0) break;
    if (c.status === 'skip' || c.status === 'blocked' || c.is_extra) continue;
    const p = Number(c.qty_produced) || 0; if (p <= 0) continue;
    const d = Math.min(p, left); left -= d;
    const np = p - d; const sent = Number(c.qty_sent_total) || 0;
    const upd: any = { qty_produced: np, updated_at: new Date().toISOString() };
    if (sent > np) {
      let back = sent - np;
      const { data: tlsRaw } = await sb.from('lab_stock_transfer_lines').select('id, qty_sent, transfer_id, lab_stock_transfers(created_at, cancelled_at, status)').eq('assignment_id', c.id);
      // newest transfer first (ids are uuids: sort on the transfer's date)
      const tls = ((tlsRaw ?? []) as any[]).filter(t => !t.lab_stock_transfers?.cancelled_at && t.lab_stock_transfers?.status !== 'cancelled')
        .sort((a, b) => String(b.lab_stock_transfers?.created_at ?? '').localeCompare(String(a.lab_stock_transfers?.created_at ?? '')));
      const days = new Set<string>();
      for (const tl of tls) {
        if (back <= 0) break;
        const q = Math.min(Number(tl.qty_sent) || 0, back); if (q <= 0) continue;
        await sb.from('lab_stock_transfer_lines').update({ qty_sent: (Number(tl.qty_sent) || 0) - q }).eq('id', tl.id);
        back -= q;
        const d2 = labDateOf(tl.lab_stock_transfers?.created_at); if (d2) days.add(d2);
      }
      upd.qty_sent_total = sent - ((sent - np) - back); upd.transferred = upd.qty_sent_total >= np;
      for (const d2 of Array.from(days)) {
        if (!odooWriteConfigured()) break;
        const target = (await sentToStockBySku(sb, d2)).bySku[sku] ?? 0;
        const r = await withLock(sb, `unbuild|${sku}|${d2}`, () => reduceDayProduction(d2, sku, target, note));
        refs.push(...r.refs); if (!r.ok && r.error) errs.push(r.error);
      }
    }
    await sb.from('lab_assignments').update(upd).eq('id', c.id);
    c.qty_produced = np; if (upd.qty_sent_total != null) c.qty_sent_total = upd.qty_sent_total;
  }
  return { refs, errs };
}

// Made without order (Axel, 2026-10-24): after the delivery check, the kitchen declared more of a
// made-to-order product than left the Lab (orders + losses). Three answers:
//   to_stock  — still at the Lab: make sure it is sent to stock (auto transfer → Odoo MO follows);
//   lost      — thrown away / broken: same, then Lab scrap (photo);
//   not_made  — kitchen over-declared: lower the cards and Odoo (removeProduced).
export async function resolveMadeWithoutOrder(sb: SupabaseClient, date: string, sku: string, qty: number, choice: 'to_stock' | 'lost' | 'not_made',
  opts: { photoUrl?: string | null; byName: string | null; byId: string | null; productName: string }): Promise<{ odooStatus: 'none' | 'done' | 'error'; refs: string[]; error?: string }> {
  // Claim the (day, product) first: a second device or a double tap must not run it twice.
  const { error: claimErr } = await sb.from('lab_made_without_order').insert({
    delivery_date: date, sku, product_name: opts.productName, qty, resolution: choice,
    resolved_by_name: opts.byName, resolved_at: new Date().toISOString(), odoo_status: 'pending',
  });
  if (claimErr) return { odooStatus: 'error', refs: [], error: 'Đã có người trả lời rồi / Already answered — refresh' };
  const cards = await loadCards(sb, date, sku);
  const refs: string[] = []; const errs: string[] = [];
  let lossId: string | null = null;
  const today = labDateOf(new Date().toISOString())!;
  const tag = `Lab ${date} · ${sku}`;
  if (choice === 'not_made') {
    const r = await removeProduced(sb, cards, sku, qty, `${opts.productName} — làm dư không có đơn: bếp báo sai ${qty} (${opts.byName ?? ''})`, null);
    refs.push(...r.refs); errs.push(...r.errs);
  } else {
    const usable = cards.filter(c => c.status !== 'skip' && c.status !== 'blocked');
    const produced = usable.reduce((s, c) => s + (Number(c.qty_produced) || 0), 0);
    const sent = usable.reduce((s, c) => s + (Number(c.qty_sent_total) || 0), 0);
    if (produced > sent) {
      const n = await addAutoTransfer(sb, usable, produced - sent, sku, date, tag, opts.byName);
      if (n > 0 && odooWriteConfigured()) {
        try {
          const s = await syncStockToOdoo(sb, today, { commit: true, skus: [sku] });
          if (s.errors?.length) errs.push(...s.errors.map(e => e.error));
          for (const c of s.created ?? []) if (c.mo) refs.push(`${c.mo} +${c.qty}`);
        } catch (e: any) { errs.push(String(e?.message ?? e)); }
      }
    }
    if (choice === 'lost') {
      const t = await brokenReasonTag();
      if (!t) errs.push('No "broken" scrap reason in Odoo');
      else {
        const r = await recordLabLoss(sb, {
          sku, productName: opts.productName, qty, reasonTagId: t.id, reasonTagName: t.name, note: 'Làm dư không có đơn',
          reportedByName: opts.byName ?? 'Staff', reportedById: opts.byId, photoUrl: opts.photoUrl ?? null,
          source: 'delivery_check', deliveryDate: date, orderRef: null, checkLineId: null,
        });
        if (r.error) errs.push(r.error); else if (r.odooError) errs.push(r.odooError);
        if (r.odooScrapId) refs.push(`scrap #${r.odooScrapId}`);
        lossId = r.id ?? null;
      }
    }
  }
  const odooStatus = errs.length ? 'error' : refs.length ? 'done' : 'none';
  await sb.from('lab_made_without_order').update({
    odoo_status: odooStatus, odoo_error: errs.length ? errs.join(' · ').slice(0, 300) : null, ref: refs.length ? refs.join(' · ').slice(0, 300) : null, loss_id: lossId,
  }).eq('delivery_date', date).eq('sku', sku);
  return { odooStatus, refs, error: errs.length ? errs.join(' · ') : undefined };
}

export interface FollowUpResult { resolution: string | null; odooStatus: 'none' | 'done' | 'error'; refs: string[]; error?: string; autoTransferred: number }

export async function followUpLine(sb: SupabaseClient, lineId: string, opts: { photoUrl?: string | null; byName: string | null; byId: string | null; alreadyReported?: boolean }): Promise<FollowUpResult> {
  const res: FollowUpResult = { resolution: null, odooStatus: 'none', refs: [], autoTransferred: 0 };
  const { data: line } = await sb.from('lab_delivery_check_lines')
    .select('id, delivery_order_id, delivery_date, sku, product_name_vi, product_category, category, qty_expected, qty_checked, discrepancy_reason, discrepancy_note, resolution')
    .eq('id', lineId).maybeSingle();
  if (!line || line.qty_checked == null) return res;
  if (!line.sku) {
    // No SKU: nothing to correct anywhere — the reason is simply recorded.
    if (line.discrepancy_reason && !line.resolution) {
      await sb.from('lab_delivery_check_lines').update({ resolution: line.discrepancy_reason, resolution_qty: Math.abs(Number(line.qty_checked) - Number(line.qty_expected)), resolution_at: new Date().toISOString(), resolution_by_name: opts.byName, resolution_odoo_status: 'none' }).eq('id', lineId);
      res.resolution = line.discrepancy_reason;
    }
    return res;
  }
  const { data: hdr } = await sb.from('lab_delivery_orders').select('order_ref, shop_name').eq('id', line.delivery_order_id).maybeSingle();
  const orderRef = hdr?.order_ref ?? '';
  const date = line.delivery_date as string;
  const qty = Number(line.qty_checked); const expected = Number(line.qty_expected);
  const reason = line.discrepancy_reason as string | null;
  const already = line.resolution as string | null;
  const { pool, cards } = await computeDayPool(sb, date, line.sku, lineId, line.product_category, line.category);
  const today = labDateOf(new Date().toISOString())!;
  const errs: string[] = [];
  let resolution: string | null = null; let resQty: number | null = null;

  // 1. Out of stock (stock products) → recount alert.
  if (reason === 'out_of_stock' && already !== 'out_of_stock') {
    const { data: exA } = await sb.from('lab_stock_recount_alerts').select('id').eq('check_line_id', lineId).limit(1);
    if (!exA?.length) await sb.from('lab_stock_recount_alerts').insert({
      sku: line.sku, product_name: line.product_name_vi, delivery_date: date, order_ref: orderRef, check_line_id: lineId,
      missing_qty: Math.max(0, expected - qty), raised_by_name: opts.byName,
    });
    resolution = 'out_of_stock'; resQty = Math.max(0, expected - qty);
  }

  // Claim the correction before any side effect: if this run is cut off (time limit), a re-run
  // sees the resolution and does not cut / add / scrap a second time; Retry finishes the Odoo part.
  if (!already && reason && ['not_made', 'undeclared', 'over_real', 'casse'].includes(reason)) {
    const { data: claimed } = await sb.from('lab_delivery_check_lines')
      .update({ resolution: reason === 'over_real' ? 'undeclared' : reason, resolution_odoo_status: 'pending', resolution_at: new Date().toISOString(), resolution_by_name: opts.byName })
      .eq('id', lineId).is('resolution', null).select('id');
    if (!claimed?.length) return res; // another run already took it
  }

  if (pool.family === 'mto') {
    // 2a. "The cake is really there" (Axel, 2026-10-24): the app decides — first from the Lab
    //     reserve of extra production, the rest was made by the kitchen but not declared.
    let fromReserve = 0;
    if (reason === 'over_real' && !already) {
      const need = Math.max(0, qty + pool.otherLeft + pool.lost - pool.produced - pool.fromStock);
      fromReserve = Math.min(need, await labReserve(sb, line.sku, date, lineId));
      if (need === 0) { resolution = 'extra_made'; resQty = 0; }
      else if (need - fromReserve <= 0) { resolution = 'from_lab_stock'; resQty = fromReserve; res.refs.push(`kho hàng dư −${fromReserve}`); }
    }
    // 2. Made but not declared (more left than the kitchen declared) → add it to the card.
    if ((reason === 'undeclared' && already !== 'undeclared') || (reason === 'over_real' && !already && !resolution)) {
      const need = Math.max(0, qty + pool.otherLeft + pool.lost - pool.produced - pool.fromStock) - fromReserve;
      const c = cardForOrder(cards, orderRef);
      if (c && need > 0) {
        const np = (Number(c.qty_produced) || 0) + need;
        await sb.from('lab_assignments').update({ qty_produced: np, transferred: (Number(c.qty_sent_total) || 0) >= np, updated_at: new Date().toISOString() }).eq('id', c.id);
        c.qty_produced = np; pool.produced += need;
      }
      resolution = 'undeclared'; resQty = need;
      if (fromReserve > 0) res.refs.push(`kho hàng dư −${fromReserve}, bếp +${need}`);
    }
    const broken = reason === 'casse' && already !== 'casse' && !opts.alreadyReported ? Math.max(0, expected - qty) : 0;

    // 3. Never made → lower the kitchen count, take back what was sent, and bring Odoo down.
    if (reason === 'not_made' && already !== 'not_made') {
      const phantom = Math.min(Math.max(0, expected - qty), pool.produced - (pool.otherLeft + pool.pendingLeft + qty + pool.lost));
      if (phantom > 0) {
        const r = await removeProduced(sb, cards, line.sku, phantom, `${line.product_name_vi} — bếp chưa làm, ${orderRef} giao ${qty}/${expected} (kiểm giao hàng ${opts.byName ?? ''})`, orderRef);
        res.refs.push(...r.refs); errs.push(...r.errs);
      }
      resolution = 'not_made'; resQty = Math.max(0, phantom);
    }

    // 4. Forgotten transfer: what left (+ what broke) but was never sent to stock, within what
    //    the kitchen declared, is sent by the app itself → Odoo production follows.
    const sentNow = cards.filter(c => c.status !== 'skip').reduce((s, c) => s + (Number(c.qty_sent_total) || 0), 0);
    const producedNow = cards.filter(c => c.status !== 'skip' && c.status !== 'blocked').reduce((s, c) => s + (Number(c.qty_produced) || 0), 0);
    const want = Math.min(producedNow, pool.otherLeft + qty + pool.lost + broken);
    if (want > sentNow) {
      res.autoTransferred = await addAutoTransfer(sb, cards, want - sentNow, line.sku, date, orderRef, opts.byName);
      if (res.autoTransferred > 0 && odooWriteConfigured()) {
        try {
          const s = await syncStockToOdoo(sb, today, { commit: true, skus: [line.sku] });
          if (s.errors?.length) errs.push(...s.errors.map(e => e.error));
          for (const c of s.created ?? []) if (c.mo) res.refs.push(`${c.mo} +${c.qty}`);
        } catch (e: any) { errs.push(String(e?.message ?? e)); }
        if (!resolution) { resolution = 'auto_transfer'; resQty = res.autoTransferred; }
      }
    }

    if (reason === 'casse' && already !== 'casse' && opts.alreadyReported) { resolution = 'casse'; resQty = 0; res.refs.push('đã báo ở Hao hụt Lab'); }
    // 5. Broken at the Lab → Lab scrap (same function as the Hao hụt Lab tab), with the photo.
    if (broken > 0) {
      const tag = await brokenReasonTag();
      if (!tag) errs.push('No "broken" scrap reason in Odoo');
      else {
        const r = await recordLabLoss(sb, {
          sku: line.sku, productName: line.product_name_vi, qty: broken, reasonTagId: tag.id, reasonTagName: tag.name,
          note: line.discrepancy_note ?? null, reportedByName: opts.byName ?? 'Staff', reportedById: opts.byId,
          photoUrl: opts.photoUrl ?? null, source: 'delivery_check', deliveryDate: date, orderRef, checkLineId: lineId,
        });
        if (r.error) errs.push(r.error); else if (r.odooError) errs.push(r.odooError);
        if (r.odooScrapId) res.refs.push(`scrap #${r.odooScrapId}`);
      }
      resolution = 'casse'; resQty = broken;
    }
  } else if (reason === 'casse' && already !== 'casse') {
    // Stock products and packaging: Lab scrap too (packaging was left out before review 2026-10-24).
    const broken = opts.alreadyReported ? 0 : Math.max(0, expected - qty);
    const tag = broken > 0 ? await brokenReasonTag() : null;
    if (broken > 0 && !tag) errs.push('No "broken" scrap reason in Odoo');
    if (opts.alreadyReported) res.refs.push('đã báo ở Hao hụt Lab');
    if (tag && broken > 0) {
      const r = await recordLabLoss(sb, {
        sku: line.sku, productName: line.product_name_vi, qty: broken, reasonTagId: tag.id, reasonTagName: tag.name,
        note: line.discrepancy_note ?? null, reportedByName: opts.byName ?? 'Staff', reportedById: opts.byId,
        photoUrl: opts.photoUrl ?? null, source: 'delivery_check', deliveryDate: date, orderRef, checkLineId: lineId,
      });
      if (r.error) errs.push(r.error); else if (r.odooError) errs.push(r.odooError);
      if (r.odooScrapId) res.refs.push(`scrap #${r.odooScrapId}`);
    }
    resolution = 'casse'; resQty = broken;
  }

  if (!resolution && reason && ['order_changed', 'packing', 'other', 'extra_stock', 'extra_made', 'from_lab_stock'].includes(reason)) { resolution = reason; resQty = Math.abs(qty - expected); }
  res.resolution = resolution ?? already;
  res.odooStatus = errs.length ? 'error' : res.refs.length ? 'done' : 'none';
  if (errs.length) res.error = errs.join(' · ');
  if (resolution) {
    await sb.from('lab_delivery_check_lines').update({
      resolution, resolution_qty: resQty, resolution_at: new Date().toISOString(), resolution_by_name: opts.byName,
      resolution_odoo_status: res.odooStatus, resolution_odoo_error: res.error ?? null,
      resolution_ref: res.refs.length ? res.refs.join(' · ').slice(0, 300) : null,
    }).eq('id', lineId);
  }
  return res;
}

// Retry ONLY the Odoo part of a correction that failed (review 2026-10-24): the app-side changes
// (cards, transfers, loss row) are already done and must not run twice.
async function retryOdooPart(sb: SupabaseClient, kind: string, sku: string, date: string, note: string, lossId: string | null, cardIds: string[]): Promise<{ refs: string[]; errs: string[] }> {
  const refs: string[] = []; const errs: string[] = [];
  const today = labDateOf(new Date().toISOString())!;
  if (kind === 'casse' || kind === 'lost') {
    if (lossId) { const r = await retryLossScrap(sb, lossId); if (r.ok) refs.push(`scrap #${r.scrapId}`); else errs.push(r.error ?? 'scrap failed'); }
    // no loss row: either 'already reported in Lab scrap' (nothing to redo) or it was never written
    else if (kind === 'lost') errs.push('No Lab loss row to retry — declare it in the Lab scrap tab');
  }
  if (kind === 'not_made') {
    const days = new Set<string>([date]);
    if (cardIds.length) {
      const { data: tls } = await sb.from('lab_stock_transfer_lines').select('lab_stock_transfers(created_at)').in('assignment_id', cardIds);
      for (const t of (tls ?? []) as any[]) { const d = labDateOf(t.lab_stock_transfers?.created_at); if (d) days.add(d); }
    }
    for (const d of Array.from(days)) {
      const target = (await sentToStockBySku(sb, d)).bySku[sku] ?? 0;
      const r = await withLock(sb, `unbuild|${sku}|${d}`, () => reduceDayProduction(d, sku, target, note));
      refs.push(...r.refs); if (!r.ok && r.error) errs.push(r.error);
    }
  }
  if (['not_made', 'auto_transfer', 'undeclared', 'to_stock', 'lost', 'casse', 'from_lab_stock'].includes(kind)) {
    // Sync every day on which these cards sent units to stock (MO origin = that day), not only today.
    const days = new Set<string>([today]);
    if (cardIds.length) {
      const { data: tls } = await sb.from('lab_stock_transfer_lines').select('lab_stock_transfers(created_at)').in('assignment_id', cardIds);
      for (const t of (tls ?? []) as any[]) { const d = labDateOf(t.lab_stock_transfers?.created_at); if (d) days.add(d); }
    }
    for (const d of Array.from(days)) {
      try {
        const s = await syncStockToOdoo(sb, d, { commit: true, skus: [sku] });
        if (s.errors?.length) errs.push(...s.errors.map(e => e.error));
        for (const c of s.created ?? []) if (c.mo) refs.push(`${c.mo} +${c.qty}`);
        for (const u of s.updated ?? []) refs.push(`${u.mo} ${u.from}→${u.to}`);
      } catch (e: any) { errs.push(String(e?.message ?? e)); }
    }
  }
  return { refs, errs };
}

export async function retryLineOdoo(sb: SupabaseClient, lineId: string): Promise<{ odooStatus: 'done' | 'error' | 'none'; error?: string }> {
  const { data: line } = await sb.from('lab_delivery_check_lines').select('id, sku, delivery_date, resolution, product_name_vi, product_category, category').eq('id', lineId).maybeSingle();
  if (!line?.sku || !line.resolution) return { odooStatus: 'none' };
  const { data: loss } = await sb.from('lab_internal_losses').select('id').eq('check_line_id', lineId).is('odoo_scrap_id', null).limit(1).maybeSingle();
  const { cards } = await computeDayPool(sb, line.delivery_date, line.sku, lineId, line.product_category, line.category);
  const { refs, errs } = await retryOdooPart(sb, line.resolution, line.sku, line.delivery_date, `${line.product_name_vi} — retry (kiểm giao hàng)`, loss?.id ?? null, cards.map(c => c.id));
  const odooStatus = errs.length ? 'error' : 'done';
  await sb.from('lab_delivery_check_lines').update({ resolution_odoo_status: odooStatus, resolution_odoo_error: errs.length ? errs.join(' · ').slice(0, 300) : null, ...(refs.length ? { resolution_ref: refs.join(' · ').slice(0, 300) } : {}) }).eq('id', lineId);
  return { odooStatus, error: errs.length ? errs.join(' · ') : undefined };
}

export async function retryMadeWithoutOrderOdoo(sb: SupabaseClient, date: string, sku: string): Promise<{ odooStatus: 'done' | 'error' | 'none'; error?: string }> {
  const { data: row } = await sb.from('lab_made_without_order').select('resolution, product_name, loss_id').eq('delivery_date', date).eq('sku', sku).maybeSingle();
  if (!row) return { odooStatus: 'none' };
  const cards = await loadCards(sb, date, sku);
  const { refs, errs } = await retryOdooPart(sb, row.resolution, sku, date, `${row.product_name} — retry (làm dư không có đơn)`, row.loss_id, cards.map(c => c.id));
  const odooStatus = errs.length ? 'error' : 'done';
  await sb.from('lab_made_without_order').update({ odoo_status: odooStatus, odoo_error: errs.length ? errs.join(' · ').slice(0, 300) : null, ...(refs.length ? { ref: refs.join(' · ').slice(0, 300) } : {}) }).eq('delivery_date', date).eq('sku', sku);
  return { odooStatus, error: errs.length ? errs.join(' · ') : undefined };
}
