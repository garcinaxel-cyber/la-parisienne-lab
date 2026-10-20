// Shop IN auto-validation on Odoo, shared by the shop reception, the Lab's Odoo validation and an
// hourly sweep (Axel, 2026-10-20 — "je veux savoir si le check app → Odoo est fiable"). Before,
// it ran ONCE, at the moment the shop finished its reception: an IN that did not exist yet (shop
// faster than the Lab's OUT, REP/02089) or a reception corrected right after a gap (REP/02059,
// REP/02091 — the gap closed itself, nothing listed it) stayed open on Odoo forever.
import type { SupabaseClient } from '@supabase/supabase-js';
import { odooExecute } from '@/lib/odoo';
import { gapsSchemaReady } from '@/lib/reception-gaps';
import { validateShopIn, TRANSIT_LOCATION_ID } from '@/lib/reception-odoo';
import { isPortalShop } from '@/lib/reception-tracker';

export type AutoInOutcome = 'validated' | 'already_done' | 'needs_lab_check' | 'skipped' | 'error' | 'disabled';

async function receptionRows(sb: SupabaseClient, deliveryOrderId: string) {
  const [{ data: lines }, { data: recs }] = await Promise.all([
    sb.from('lab_delivery_check_lines').select('id, sku, qty_expected, qty_checked').eq('delivery_order_id', deliveryOrderId),
    sb.from('lab_shop_receipt_lines').select('*').eq('delivery_order_id', deliveryOrderId),
  ]);
  const recByLine = new Map((recs ?? []).map((r: any) => [r.check_line_id, r]));
  const rows = (lines ?? []).map((l: any) => {
    const r: any = recByLine.get(l.id);
    return { sku: l.sku as string | null, sent: Number(l.qty_checked ?? l.qty_expected), received: Number(r?.qty_received ?? NaN), damaged: Number(r?.qty_damaged ?? 0), confirmed: !!r };
  });
  return rows;
}

/** Validates the shop IN when the reception is complete AND conforming; otherwise leaves it to the
 * gaps screen. Logged in lab_reception_odoo_runs. Never throws. */
export async function autoValidateShopIn(sb: SupabaseClient, deliveryOrderId: string, orderRef: string, byName: string): Promise<{ outcome: AutoInOutcome; detail?: string }> {
  try {
    if (!(await gapsSchemaReady(sb))) return { outcome: 'disabled' };
    const rows = await receptionRows(sb, deliveryOrderId);
    if (!rows.length || rows.some(r => !r.confirmed)) return { outcome: 'skipped', detail: 'reception_incomplete' };
    const log = (row: { mode: string; ok: boolean; plan: any; error: string | null }) =>
      sb.from('lab_reception_odoo_runs').insert({ delivery_order_id: deliveryOrderId, order_ref: orderRef, action: 'validate_in', created_by_name: byName, ...row });
    const conforming = rows.every(r => r.received === r.sent && r.damaged === 0);
    if (!conforming) {
      await log({ mode: 'skipped', ok: false, plan: {}, error: 'needs_lab_check' });
      return { outcome: 'needs_lab_check' };
    }
    const res = await validateShopIn(orderRef, rows);
    await log({
      mode: res.live ? 'live' : 'simulated', ok: res.ok,
      plan: { picking: res.pickingName ?? null, alreadyDone: !!res.alreadyDone, writes: res.plan },
      error: res.error ?? res.skipped ?? null,
    });
    if (res.ok) return { outcome: res.alreadyDone ? 'already_done' : 'validated' };
    return { outcome: res.error ? 'error' : 'skipped', detail: res.error ?? res.skipped };
  } catch (e: any) {
    return { outcome: 'error', detail: e?.message ?? String(e) };
  }
}

export type StuckShopIn = {
  deliveryOrderId: string; orderRef: string; shopName: string; deliveryDate: string;
  inName: string; conforming: boolean; lastError: string | null;
};

/** REP receptions the shop fully confirmed whose shop IN is still open on Odoo. */
export async function listStuckShopIns(sb: SupabaseClient, days = 7): Promise<StuckShopIn[]> {
  const from = new Date(Date.now() + 7 * 3600_000 - days * 86400_000).toISOString().slice(0, 10);
  const { data: headers } = await sb.from('lab_delivery_orders')
    .select('id, order_ref, shop_name, delivery_date, marked_not_delivered')
    .eq('source_type', 'replenishment').eq('status', 'validated').gte('delivery_date', from).limit(1000);
  const hs = (headers ?? []).filter((h: any) => !h.marked_not_delivered && isPortalShop(h.shop_name));
  if (!hs.length) return [];
  const complete: any[] = [];
  for (let i = 0; i < hs.length; i += 15) { // ≤ ~700 lines per read (PostgREST caps responses at 1000 rows)
    const ids = hs.slice(i, i + 15).map((h: any) => h.id);
    const [{ data: lines }, { data: recs }] = await Promise.all([
      sb.from('lab_delivery_check_lines').select('id, delivery_order_id, qty_checked, qty_expected').in('delivery_order_id', ids).limit(5000),
      sb.from('lab_shop_receipt_lines').select('check_line_id, delivery_order_id, qty_received, qty_damaged').in('delivery_order_id', ids).limit(5000),
    ]);
    const rec = new Map((recs ?? []).map((r: any) => [r.check_line_id, r]));
    for (const h of hs.slice(i, i + 15)) {
      const ls = (lines ?? []).filter((l: any) => l.delivery_order_id === h.id);
      if (!ls.length || ls.some((l: any) => !rec.has(l.id))) continue;
      const conforming = ls.every((l: any) => {
        const r: any = rec.get(l.id);
        return Number(r.qty_received) === Number(l.qty_checked ?? l.qty_expected) && !(Number(r.qty_damaged ?? 0) > 0);
      });
      complete.push({ ...h, conforming });
    }
  }
  if (!complete.length) return [];
  const open = await odooExecute<any[]>('stock.picking', 'search_read',
    [[['origin', 'in', complete.map(h => h.order_ref)], ['location_id', '=', TRANSIT_LOCATION_ID], ['state', 'not in', ['done', 'cancel']]]],
    { fields: ['name', 'origin'] });
  const inByRef = new Map(open.map((p: any) => [p.origin, p.name]));
  const stuck = complete.filter(h => inByRef.has(h.order_ref));
  if (!stuck.length) return [];
  const { data: runs } = await sb.from('lab_reception_odoo_runs').select('order_ref, error, created_at')
    .in('order_ref', stuck.map(h => h.order_ref)).order('created_at', { ascending: false }).limit(500);
  return stuck.map(h => ({
    deliveryOrderId: h.id, orderRef: h.order_ref, shopName: h.shop_name, deliveryDate: h.delivery_date,
    inName: inByRef.get(h.order_ref) as string, conforming: h.conforming,
    lastError: (runs ?? []).find((r: any) => r.order_ref === h.order_ref)?.error ?? null,
  }));
}

/** Retries every stuck conforming reception. Used by the hourly cron. */
export async function sweepStuckShopIns(sb: SupabaseClient): Promise<{ tried: number; validated: string[]; still: StuckShopIn[] }> {
  const stuck = await listStuckShopIns(sb);
  const validated: string[] = [];
  for (const s of stuck.filter(x => x.conforming)) {
    const r = await autoValidateShopIn(sb, s.deliveryOrderId, s.orderRef, 'auto (sweep)');
    if (r.outcome === 'validated' || r.outcome === 'already_done') validated.push(s.orderRef);
  }
  const still = validated.length ? await listStuckShopIns(sb) : stuck;
  return { tried: stuck.filter(x => x.conforming).length, validated, still };
}
