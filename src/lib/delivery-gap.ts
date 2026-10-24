import type { SupabaseClient } from '@supabase/supabase-js';
import { isStockFamily } from '@/lib/delivery-check-production';
import { labDateOf, labDayUtcRange, odooWriteConfigured } from '@/lib/odoo';
import { syncStockToOdoo, sentToStockBySku } from '@/lib/odoo-mo-sync';
import { reduceDayProduction } from '@/lib/odoo-unbuild';
import { recordLabLoss, brokenReasonTag } from '@/lib/lab-loss';

// Delivery check gap barriers (Axel, 2026-10-24 — maquettes delivery-check-gap-barriers-v2 /
// real-ui-1/2/3). Everything is counted per PRODUCT for the WHOLE delivery day (all orders),
// never per card or per order: Odoo MOs follow what was sent to stock per product per day, and a
// card can serve several orders. The missing unit simply shows on the order that leaves last.
// Never blocks: a forgotten transfer is added by the app itself when the kitchen declared enough.

export type Family = 'stock' | 'mto' | 'packaging';

export interface DayPool {
  sku: string; date: string; family: Family;
  planned: number; produced: number; fromStock: number; sent: number; lost: number;
  otherLeft: number; blockedReasons: string[]; partial: boolean;
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
    sb.from('lab_delivery_check_lines').select('id, qty_checked, delivery_order_id').eq('delivery_date', date).eq('sku', sku).eq('category', 'production'),
    sb.from('lab_internal_losses').select('id, qty').eq('sku', sku).eq('delivery_date', date),
    sb.from('lab_internal_losses').select('id, qty').eq('sku', sku).is('delivery_date', null).gte('reported_at', start).lt('reported_at', end),
  ]);
  // Lines of orders marked "not delivered" don't leave.
  const orderIds = Array.from(new Set((lines ?? []).map((l: any) => l.delivery_order_id)));
  const { data: hdrs } = orderIds.length ? await sb.from('lab_delivery_orders').select('id, marked_not_delivered').in('id', orderIds) : { data: [] as any[] };
  const skip = new Set((hdrs ?? []).filter((h: any) => h.marked_not_delivered).map((h: any) => h.id));
  let otherLeft = 0;
  for (const l of lines ?? []) if (l.id !== excludeLineId && l.qty_checked != null && !skip.has(l.delivery_order_id)) otherLeft += Number(l.qty_checked) || 0;
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
  return { pool: { sku, date, family, planned, produced, fromStock, sent, lost, otherLeft, blockedReasons, partial }, cards };
}

export interface GapContext {
  family: Family; dir: 'short' | 'over'; diff: number;
  made: number; sent: number; otherLeft: number; lost: number; thisQty: number; expected: number;
  // short + made-to-order: nothing physically left → "Bếp chưa làm" is automatic (no question)
  autoNotMade: boolean; autoNote: string | null;
  // over + made-to-order: production covers it → just a confirmation
  madeCovers: boolean;
}

export function contextFor(pool: DayPool, expected: number, qty: number): GapContext {
  const dir = qty < expected ? 'short' : 'over';
  const diff = Math.abs(qty - expected);
  const available = pool.produced + pool.fromStock - pool.lost - pool.otherLeft;
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
  const lines: any[] = []; const bumps: Record<string, number> = {};
  for (const c of cards.filter(x => x.status !== 'skip' && x.status !== 'blocked')) {
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
    await sb.from('lab_stock_transfer_lines').insert(ls.map(({ team: _t, ...l }) => ({ ...l, transfer_id: t.id })));
    for (const l of ls) {
      const c = cards.find(x => x.id === l.assignment_id)!;
      const nt = (Number(c.qty_sent_total) || 0) + l.qty_sent;
      c.qty_sent_total = nt;
      await sb.from('lab_assignments').update({ qty_sent_total: nt, transferred: nt >= (Number(c.qty_produced) || 0) }).eq('id', c.id);
      total += l.qty_sent;
    }
  }
  return total;
}

function cardForOrder(cards: Card[], orderRef: string): Card | null {
  const usable = cards.filter(c => c.status !== 'skip' && c.status !== 'blocked');
  const mine = usable.find(c => Array.isArray(c.breakdown) && c.breakdown.some((b: any) => b?.order_ref === orderRef));
  return mine ?? usable.sort((a, b) => String(b.produced_at ?? '').localeCompare(String(a.produced_at ?? '')))[0] ?? null;
}

export interface FollowUpResult { resolution: string | null; odooStatus: 'none' | 'done' | 'error'; refs: string[]; error?: string; autoTransferred: number }

export async function followUpLine(sb: SupabaseClient, lineId: string, opts: { photoUrl?: string | null; byName: string | null; byId: string | null }): Promise<FollowUpResult> {
  const res: FollowUpResult = { resolution: null, odooStatus: 'none', refs: [], autoTransferred: 0 };
  const { data: line } = await sb.from('lab_delivery_check_lines')
    .select('id, delivery_order_id, delivery_date, sku, product_name_vi, product_category, category, qty_expected, qty_checked, discrepancy_reason, discrepancy_note, resolution')
    .eq('id', lineId).maybeSingle();
  if (!line || line.qty_checked == null || !line.sku) return res;
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
    await sb.from('lab_stock_recount_alerts').insert({
      sku: line.sku, product_name: line.product_name_vi, delivery_date: date, order_ref: orderRef, check_line_id: lineId,
      missing_qty: Math.max(0, expected - qty), raised_by_name: opts.byName,
    });
    resolution = 'out_of_stock'; resQty = Math.max(0, expected - qty);
  }

  if (pool.family === 'mto') {
    // 2. Made but not declared (more left than the kitchen declared) → add it to the card.
    if (reason === 'undeclared' && already !== 'undeclared') {
      const need = Math.max(0, qty + pool.otherLeft + pool.lost - pool.produced - pool.fromStock);
      const c = cardForOrder(cards, orderRef);
      if (c && need > 0) {
        const np = (Number(c.qty_produced) || 0) + need;
        await sb.from('lab_assignments').update({ qty_produced: np, transferred: (Number(c.qty_sent_total) || 0) >= np, updated_at: new Date().toISOString() }).eq('id', c.id);
        c.qty_produced = np; pool.produced += need;
      }
      resolution = 'undeclared'; resQty = need;
    }
    const broken = reason === 'casse' && already !== 'casse' ? Math.max(0, expected - qty) : 0;

    // 3. Never made → lower the kitchen count, take back what was sent, and bring Odoo down.
    if (reason === 'not_made' && already !== 'not_made') {
      const phantom = Math.min(Math.max(0, expected - qty), pool.produced - (pool.otherLeft + qty + pool.lost));
      if (phantom > 0) {
        let left = phantom;
        const ordered = [cardForOrder(cards, orderRef), ...cards].filter((c, i, a) => c && a.indexOf(c) === i) as Card[];
        for (const c of ordered) {
          if (left <= 0) break;
          if (c.status === 'skip' || c.status === 'blocked') continue;
          const p = Number(c.qty_produced) || 0; if (p <= 0) continue;
          const d = Math.min(p, left); left -= d;
          const np = p - d; const sent = Number(c.qty_sent_total) || 0;
          const upd: any = { qty_produced: np, updated_at: new Date().toISOString() };
          if (sent > np) {
            // take back the transfer lines of this card, newest first
            let back = sent - np;
            const { data: tls } = await sb.from('lab_stock_transfer_lines').select('id, qty_sent, transfer_id, lab_stock_transfers(created_at, cancelled_at)').eq('assignment_id', c.id).order('id', { ascending: false });
            const days = new Set<string>();
            for (const tl of (tls ?? []) as any[]) {
              if (back <= 0) break;
              if (tl.lab_stock_transfers?.cancelled_at) continue;
              const q = Math.min(Number(tl.qty_sent) || 0, back); if (q <= 0) continue;
              await sb.from('lab_stock_transfer_lines').update({ qty_sent: (Number(tl.qty_sent) || 0) - q }).eq('id', tl.id);
              back -= q;
              const d2 = labDateOf(tl.lab_stock_transfers?.created_at); if (d2) days.add(d2);
            }
            upd.qty_sent_total = np; upd.transferred = true;
            for (const d2 of Array.from(days)) {
              if (!odooWriteConfigured()) break;
              const target = (await sentToStockBySku(sb, d2)).bySku[line.sku] ?? 0;
              const r = await reduceDayProduction(d2, line.sku, target, `${line.product_name_vi} — bếp chưa làm, ${orderRef} giao ${qty}/${expected} (kiểm giao hàng ${opts.byName ?? ''})`);
              res.refs.push(...r.refs); if (!r.ok && r.error) errs.push(r.error);
            }
          }
          await sb.from('lab_assignments').update(upd).eq('id', c.id);
          c.qty_produced = np; if (upd.qty_sent_total != null) c.qty_sent_total = upd.qty_sent_total;
        }
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
  } else if (pool.family === 'stock' && reason === 'casse' && already !== 'casse') {
    const broken = Math.max(0, expected - qty);
    const tag = await brokenReasonTag();
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
