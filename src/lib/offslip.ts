// Products a shop received that were on NO delivery slip (Axel, 2026-10-16). See
// supabase/lab_v126_offslip_items.sql for the three outcomes. Server only (service-role client).
import type { SupabaseClient } from '@supabase/supabase-js';
import { finalizeOffSlip } from '@/lib/reception-odoo';

export type OffslipCause = 'customer_order' | 'lab_extra' | 'shop_error';
export type OffslipItem = {
  id: string; deliveryOrderId: string | null; orderRef: string | null; deliveryDate: string; shopName: string;
  sku: string; productName: string; qty: number; photoUrls: string[]; note: string | null;
  declaredBy: string; declaredAt: string; status: 'open' | 'closed';
  labCause: OffslipCause | null; sourceOrderRef: string | null; decidedBy: string | null; decidedAt: string | null;
  odooMode: 'sent' | 'simulated' | null; odooLog: any; overdue: boolean;
};
export type OffslipSuggestion = { orderRef: string; customer: string; deliveryDate: string; qty: number };

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
  const { data: hdrs } = await sb.from('lab_delivery_orders').select('id, order_ref, delivery_date, shop_name, customer_name')
    .eq('source_type', 'sales_order').eq('status', 'validated').in('delivery_date', [prev, item.deliveryDate]).limit(500);
  const hs = (hdrs ?? []).filter((h: any) => (h.shop_name ?? '').toLowerCase() !== item.shopName.toLowerCase());
  if (!hs.length) return [];
  const { data: lines } = await sb.from('lab_delivery_check_lines').select('delivery_order_id, qty_checked, qty_expected')
    .eq('sku', item.sku).in('delivery_order_id', hs.map((h: any) => h.id));
  const byHdr = new Map(hs.map((h: any) => [h.id, h]));
  return (lines ?? []).map((l: any) => ({ l, h: byHdr.get(l.delivery_order_id) as any }))
    .filter(x => x.h && Number(x.l.qty_checked ?? x.l.qty_expected ?? 0) > 0)
    .map(x => ({ orderRef: x.h.order_ref, customer: x.h.customer_name || x.h.shop_name || '?', deliveryDate: x.h.delivery_date, qty: Number(x.l.qty_checked ?? x.l.qty_expected) }))
    .sort((a, b) => b.deliveryDate.localeCompare(a.deliveryDate));
}

export async function settleOffslip(sb: SupabaseClient, input: { id: string; cause: OffslipCause; sourceOrderRef: string | null; byName: string }): Promise<{ ok?: boolean; done?: string[]; error?: string }> {
  const { data: row } = await sb.from('lab_offslip_items').select('*').eq('id', input.id).maybeSingle();
  if (!row) return { error: 'Not found' };
  if (row.status !== 'open') return { error: 'Đã xử lý rồi. / Already settled.' };
  if (input.cause === 'customer_order' && !input.sourceOrderRef) return { error: 'Choose the customer order' };
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
