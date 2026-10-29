// Products a shop received that were on NO delivery slip (Axel, 2026-10-16). See
// supabase/lab_v126_offslip_items.sql for the three outcomes. Server only (service-role client).
import type { SupabaseClient } from '@supabase/supabase-js';
import { finalizeOffSlip } from '@/lib/reception-odoo';

export type OffslipCause = 'customer_order' | 'wrong_shop' | 'lab_extra' | 'shop_error';
export type OffslipItem = {
  id: string; deliveryOrderId: string | null; orderRef: string | null; deliveryDate: string; shopName: string;
  sku: string; productName: string; qty: number; photoUrls: string[]; note: string | null;
  declaredBy: string; declaredAt: string; status: 'open' | 'closed';
  labCause: OffslipCause | null; sourceOrderRef: string | null; decidedBy: string | null; decidedAt: string | null;
  odooMode: 'sent' | 'simulated' | null; odooLog: any; overdue: boolean;
};
// kind 'shop' = another La Paris shop's REP order whose shop says this product is missing (wrong van, 29/10).
export type OffslipSuggestion = { orderRef: string; customer: string; deliveryDate: string; qty: number; kind: 'customer' | 'shop' };

const map = (r: any): OffslipItem => ({
  id: r.id, deliveryOrderId: r.delivery_order_id ?? null, orderRef: r.order_ref ?? null, deliveryDate: r.delivery_date,
  shopName: r.shop_name, sku: r.sku, productName: r.product_name, qty: Number(r.qty), photoUrls: r.photo_urls ?? [],
  note: r.note ?? null, declaredBy: r.declared_by_name, declaredAt: r.declared_at, status: r.status,
  labCause: r.lab_cause ?? null, sourceOrderRef: r.source_order_ref ?? null, decidedBy: r.decided_by_name ?? null,
  decidedAt: r.decided_at ?? null, odooMode: r.odoo_mode ?? null, odooLog: r.odoo_log ?? null,
  // Same 48h rule as the other delivery gaps.
  overdue: r.status === 'open' && Date.now() - new Date(r.declared_at).getTime() > 48 * 3600_000,
});

export async function offslipReady(sb: SupabaseClient): Promise<boolean> {
  const { error } = await sb.from('lab_offslip_items').select('id').limit(1);
  return !error;
}

export async function listOffslipItems(sb: SupabaseClient, opts: { days?: number; shopName?: string; deliveryOrderIds?: string[] } = {}): Promise<OffslipItem[]> {
  const since = new Date(Date.now() - (opts.days ?? 14) * 86400_000).toISOString().slice(0, 10);
  let q = sb.from('lab_offslip_items').select('*').gte('delivery_date', since).order('declared_at', { ascending: true }).limit(500);
  if (opts.shopName) q = q.eq('shop_name', opts.shopName);
  if (opts.deliveryOrderIds?.length) q = q.in('delivery_order_id', opts.deliveryOrderIds);
  const { data, error } = await q;
  if (error) return [];
  return (data ?? []).map(map);
}

// Sales orders delivered the same day or the day before that contained this product — the likely
// owner of units that ended up at the wrong shop (Time City / Timeless Coffee, 16/10).
export async function suggestSourceOrders(sb: SupabaseClient, item: Pick<OffslipItem, 'sku' | 'deliveryDate' | 'shopName'>): Promise<OffslipSuggestion[]> {
  const prev = new Date(new Date(item.deliveryDate + 'T00:00:00Z').getTime() - 86400_000).toISOString().slice(0, 10);
  // Other shops first: a missing line on another shop's REP the same day / day before.
  const { data: gaps } = await sb.from('lab_delivery_gaps').select('order_ref, shop_name, delivery_date, qty')
    .eq('kind', 'missing').neq('status', 'closed').eq('sku', item.sku).in('delivery_date', [prev, item.deliveryDate]).like('order_ref', 'REP%').limit(50);
  const shopSugg: OffslipSuggestion[] = (gaps ?? []).filter((g: any) => (g.shop_name ?? '').toLowerCase() !== item.shopName.toLowerCase())
    .map((g: any) => ({ orderRef: g.order_ref, customer: g.shop_name, deliveryDate: g.delivery_date, qty: Number(g.qty), kind: 'shop' as const }));
  const { data: hdrs } = await sb.from('lab_delivery_orders').select('id, order_ref, delivery_date, shop_name, customer_name')
    .eq('source_type', 'sales_order').eq('status', 'validated').in('delivery_date', [prev, item.deliveryDate]).limit(500);
  const hs = (hdrs ?? []).filter((h: any) => (h.shop_name ?? '').toLowerCase() !== item.shopName.toLowerCase());
  if (!hs.length) return shopSugg;
  const { data: lines } = await sb.from('lab_delivery_check_lines').select('delivery_order_id, qty_checked, qty_expected')
    .eq('sku', item.sku).in('delivery_order_id', hs.map((h: any) => h.id));
  const byHdr = new Map(hs.map((h: any) => [h.id, h]));
  const cust: OffslipSuggestion[] = (lines ?? []).map((l: any) => ({ l, h: byHdr.get(l.delivery_order_id) as any }))
    .filter(x => x.h && Number(x.l.qty_checked ?? x.l.qty_expected ?? 0) > 0)
    .map(x => ({ orderRef: x.h.order_ref, customer: x.h.customer_name || x.h.shop_name || '?', deliveryDate: x.h.delivery_date, qty: Number(x.l.qty_checked ?? x.l.qty_expected), kind: 'customer' as const }))
    .sort((a, b) => b.deliveryDate.localeCompare(a.deliveryDate));
  return [...shopSugg, ...cust];
}

export async function settleOffslip(sb: SupabaseClient, input: { id: string; cause: OffslipCause; sourceOrderRef: string | null; byName: string }): Promise<{ ok?: boolean; done?: string[]; error?: string }> {
  const { data: row } = await sb.from('lab_offslip_items').select('*').eq('id', input.id).maybeSingle();
  if (!row) return { error: 'Not found' };
  if (row.status !== 'open') return { error: 'Đã xử lý rồi. / Already settled.' };
  if (input.cause === 'customer_order' && !input.sourceOrderRef) return { error: 'Choose the customer order' };
  if (input.cause === 'wrong_shop' && !/^REP/.test(input.sourceOrderRef ?? '')) return { error: 'Choose the other shop\'s REP order' };
  const now = new Date().toISOString();
  // Claim the row first so a double click never sends twice to Odoo.
  const { data: claimed } = await sb.from('lab_offslip_items').update({ decided_at: now, decided_by_name: input.byName, updated_at: now })
    .eq('id', input.id).eq('status', 'open').is('decided_at', null).select('id');
  if (!claimed?.length) return { error: 'Đang được xử lý. / Being settled by someone else — reload.' };
  const release = () => sb.from('lab_offslip_items').update({ decided_at: null, decided_by_name: null, updated_at: new Date().toISOString() }).eq('id', input.id);

  if (input.cause === 'shop_error') {
    await sb.from('lab_offslip_items').update({ status: 'closed', lab_cause: 'shop_error', source_order_ref: null, updated_at: now }).eq('id', input.id);
    return { ok: true, done: ['nothing in Odoo'] };
  }
  if (input.cause === 'wrong_shop') return settleWrongShop(sb, row, input.sourceOrderRef!.trim(), input.byName, release);
  const src = input.cause === 'customer_order' ? input.sourceOrderRef!.trim() : null;
  const res = await finalizeOffSlip({
    shopName: row.shop_name, sku: row.sku, qty: Number(row.qty), sourceSoRef: src,
    origin: `ngoài phiếu ${row.order_ref ?? row.delivery_date}${src ? ` (${src})` : ''}`,
    deliveryDate: row.delivery_date, receivingOrderRef: row.order_ref ?? null,
  });
  await sb.from('lab_reception_odoo_runs').insert({
    delivery_order_id: row.delivery_order_id, order_ref: row.order_ref, action: 'offslip_finalize', created_by_name: input.byName,
    mode: res.live ? 'live' : 'simulated', ok: res.ok, plan: { item: row.id, cause: input.cause, source: src, done: res.done }, error: res.error ?? null,
  });
  if (!res.ok) {
    // Steps already done stay done in Odoo: keep the row claimed only if something was written.
    if (!res.done.length) await release();
    else await sb.from('lab_offslip_items').update({ odoo_log: { error: res.error, done: res.done }, updated_at: new Date().toISOString() }).eq('id', input.id);
    return { error: res.error ?? 'Odoo error', done: res.done };
  }
  await sb.from('lab_offslip_items').update({
    status: 'closed', lab_cause: input.cause, source_order_ref: src, odoo_mode: res.live ? 'sent' : 'simulated',
    odoo_log: { done: res.done }, updated_at: new Date().toISOString(),
  }).eq('id', input.id);
  return { ok: true, done: res.done };
}

// Wrong shop (Axel, 2026-10-29 — Long Biên's cakes put on Timecity's van): the receiving shop keeps
// the units (receipt from transit, or from the other shop's stock if it already counted them), the
// other shop's "missing" line is closed, and its IN is validated at what it really received.
async function settleWrongShop(sb: SupabaseClient, row: any, srcRef: string, byName: string, release: () => any): Promise<{ ok?: boolean; done?: string[]; error?: string }> {
  const { data: srcHdr } = await sb.from('lab_delivery_orders').select('id, order_ref, shop_name, source_type').eq('order_ref', srcRef).maybeSingle();
  if (!srcHdr || srcHdr.source_type !== 'replenishment') { await release(); return { error: `${srcRef}: not a shop REP order in the app` }; }
  if ((srcHdr.shop_name ?? '').toLowerCase() === String(row.shop_name).toLowerCase()) { await release(); return { error: 'Same shop — choose another shop\'s order' }; }
  const { moveWrongShop, validateShopIn } = await import('@/lib/reception-odoo');
  const res = await moveWrongShop({
    sku: row.sku, qty: Number(row.qty), sourceRepRef: srcRef, sourceShopName: srcHdr.shop_name, receivingShopName: row.shop_name,
    note: `${row.sku} ×${row.qty} của ${srcHdr.shop_name} (${srcRef}) giao nhầm cho ${row.shop_name} — shop giữ lại. Chọn bởi ${byName}.`,
  });
  await sb.from('lab_reception_odoo_runs').insert({
    delivery_order_id: row.delivery_order_id, order_ref: row.order_ref, action: 'offslip_finalize', created_by_name: byName,
    mode: res.live ? 'live' : 'simulated', ok: res.ok, plan: { item: row.id, cause: 'wrong_shop', source: srcRef, done: res.done }, error: res.error ?? null,
  });
  if (!res.ok) {
    if (!res.done.length) await release();
    else await sb.from('lab_offslip_items').update({ odoo_log: { error: res.error, done: res.done }, updated_at: new Date().toISOString() }).eq('id', row.id);
    return { error: res.error ?? 'Odoo error', done: res.done };
  }
  const done = [...res.done];
  const now = new Date().toISOString();
  // The other shop's missing line: settled by this move (no Odoo action left on it).
  const { data: srcGaps } = await sb.from('lab_delivery_gaps').select('id, odoo_log').eq('delivery_order_id', srcHdr.id).eq('sku', row.sku).eq('kind', 'missing').neq('status', 'closed');
  for (const g of srcGaps ?? []) {
    await sb.from('lab_delivery_gaps').update({
      status: 'closed', lab_cause: 'wrong_shop', closed_at: now, decided_at: now, decided_by_name: byName, odoo_mode: res.live ? 'sent' : 'simulated',
      lab_message: `Giao nhầm cho ${row.shop_name} / delivered to ${row.shop_name} by mistake`,
      odoo_log: [...(g.odoo_log ?? []), { at: now, by: byName, cause: 'wrong_shop', done: res.done }], updated_at: now,
    }).eq('id', g.id);
  }
  if (srcGaps?.length) done.push(`${srcRef}: missing ${row.sku} closed`);
  // Its IN: validate at the real received quantities once nothing else is waiting on that order.
  const { count } = await sb.from('lab_delivery_gaps').select('id', { count: 'exact', head: true }).eq('delivery_order_id', srcHdr.id).neq('status', 'closed');
  if (!count && res.live) {
    const [{ data: cl }, { data: rc }] = await Promise.all([
      sb.from('lab_delivery_check_lines').select('id, sku, qty_checked, qty_expected').eq('delivery_order_id', srcHdr.id),
      sb.from('lab_shop_receipt_lines').select('check_line_id, qty_received, qty_damaged').eq('delivery_order_id', srcHdr.id),
    ]);
    const rb = new Map((rc ?? []).map((r: any) => [r.check_line_id, r]));
    const lines = (cl ?? []).map((l: any) => { const r: any = rb.get(l.id); const sent = Number(l.qty_checked ?? l.qty_expected); return { sku: l.sku, sent, received: r?.qty_received == null ? sent : Number(r.qty_received), damaged: Number(r?.qty_damaged ?? 0) }; });
    const hasDamaged = lines.some(l => l.damaged > 0);
    if (!hasDamaged) {
      const v = await validateShopIn(srcRef, lines);
      done.push(v.ok ? `${srcRef}: shop IN ${v.pickingName ?? ''} ${v.alreadyDone ? 'already done' : 'validated at the received qty'}` : `${srcRef}: shop IN NOT validated (${v.error ?? v.skipped}) — Gửi Odoo on the gaps page`);
    } else done.push(`${srcRef}: has damaged lines — finish with Gửi Odoo on the gaps page`);
  }
  await sb.from('lab_offslip_items').update({
    status: 'closed', lab_cause: 'wrong_shop', source_order_ref: srcRef, odoo_mode: res.live ? 'sent' : 'simulated',
    odoo_log: { done }, updated_at: new Date().toISOString(),
  }).eq('id', row.id);
  return { ok: true, done };
}
