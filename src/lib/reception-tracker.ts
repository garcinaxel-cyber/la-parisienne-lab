// Shop reception tracker for the Delivery check page (Axel, 2026-10-16: "voir si les shops ont
// fait la réception des commandes du jour : combien de REP / SO reçus sur combien envoyés").
// Read only. Same definitions as the shop portal's reception gate (fetchPendingReceptions in
// src/app/shop/actions.ts):
//   sent      = lab_delivery_orders header 'validated' (locked at departure), not "not delivered"
//   received  = the shop confirmed every check line (one lab_shop_receipt_lines row per line)
//   with gap  = received, but a line differs from the Lab check or has damaged units
// Only the shops that use the portal (PORTAL_SHOP_NAMES: the La Paris shops + Moon Flower).
// Winmart corners and B2B customers never confirm in the app, so they are not counted.
import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAllPages } from '@/lib/fetch-all-pages';
import { PORTAL_SHOP_NAMES } from '@/lib/shops';

/** Sent and still not confirmed after this long = late (red). Axel, 2026-10-16. */
export const RECEPTION_LATE_HOURS = 3;
/** Earliest lab-local hour a delivery leaves on its delivery date (first slot is 07:00). */
export const RECEPTION_DEPARTURE_HOUR = 7;

export type ReceptionState = 'waiting' | 'received' | 'gap';
export type OrderReception = {
  headerId: string; orderRef: string; deliveryDate: string; shopName: string; sourceType: string | null;
  sentAt: string | null; sentBy: string | null;
  // When the shop wait really starts: the validation time, but never before the morning of the
  // delivery date (Axel 2026-10-20: orders locked the evening before showed "Attente shop · 19 h").
  waitFrom: string | null;
  lines: number; confirmed: number; state: ReceptionState;
  receivedAt: string | null; receivedBy: string | null; late: boolean;
};

export function normReceptionShop(s: string | null | undefined): string {
  return (s ?? '').toLowerCase().replace(/\s*warehouse\s*$/, '').replace(/^la paris\s*-\s*/, 'la paris ').replace(/\s+/g, ' ').trim();
}
const PORTAL = new Set(PORTAL_SHOP_NAMES.map(normReceptionShop));
export const isPortalShop = (s: string | null | undefined) => PORTAL.has(normReceptionShop(s));

export async function loadOrderReceptions(sb: SupabaseClient, dates: string[]): Promise<OrderReception[]> {
  if (!dates.length) return [];
  const headers = (await fetchAllPages<any>((f, t) => sb.from('lab_delivery_orders')
    .select('id, order_ref, delivery_date, shop_name, source_type, status, marked_not_delivered, validated_at, validated_by_name')
    .in('delivery_date', dates).eq('status', 'validated').order('id').range(f, t)))
    .filter(h => !h.marked_not_delivered && isPortalShop(h.shop_name));
  if (!headers.length) return [];
  const ids = headers.map(h => h.id as string);
  const lines: any[] = [], recs: any[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const [l, r] = await Promise.all([
      fetchAllPages<any>((f, t) => sb.from('lab_delivery_check_lines').select('id, delivery_order_id, qty_checked, qty_expected')
        .in('delivery_order_id', chunk).order('id').range(f, t)),
      fetchAllPages<any>((f, t) => sb.from('lab_shop_receipt_lines').select('check_line_id, delivery_order_id, qty_received, qty_damaged, confirmed_at, confirmed_by_name')
        .in('delivery_order_id', chunk).order('check_line_id').range(f, t)),
    ]);
    lines.push(...l); recs.push(...r);
  }
  const recByLine = new Map(recs.map(r => [r.check_line_id as string, r]));
  const linesByOrder = new Map<string, any[]>();
  for (const l of lines) { const a = linesByOrder.get(l.delivery_order_id) ?? []; a.push(l); linesByOrder.set(l.delivery_order_id, a); }
  const now = Date.now();
  return headers.map(h => {
    const ls = linesByOrder.get(h.id) ?? [];
    let confirmed = 0, gap = false, lastAt: string | null = null, lastBy: string | null = null;
    for (const l of ls) {
      const r = recByLine.get(l.id);
      if (!r) continue;
      confirmed++;
      const sent = Number(l.qty_checked ?? l.qty_expected ?? 0);
      if (r.qty_received != null && Number(r.qty_received) !== sent) gap = true;
      if (Number(r.qty_damaged ?? 0) > 0) gap = true;
      if (r.confirmed_at && (!lastAt || r.confirmed_at > lastAt)) { lastAt = r.confirmed_at; lastBy = r.confirmed_by_name ?? null; }
    }
    const done = ls.length > 0 && confirmed >= ls.length;
    const state: ReceptionState = !done ? 'waiting' : gap ? 'gap' : 'received';
    const sentAt = (h.validated_at as string | null) ?? null;
    const [y, m, d] = String(h.delivery_date).split('-').map(Number);
    const departure = Date.UTC(y, m - 1, d, RECEPTION_DEPARTURE_HOUR - 7, 0, 0); // lab = UTC+7
    const waitFromMs = sentAt ? Math.max(new Date(sentAt).getTime(), departure) : null;
    const waitFrom = waitFromMs != null ? new Date(waitFromMs).toISOString() : null;
    const late = state === 'waiting' && waitFromMs != null && now - waitFromMs > RECEPTION_LATE_HOURS * 3600_000;
    return {
      headerId: h.id, orderRef: h.order_ref, deliveryDate: h.delivery_date, shopName: h.shop_name, sourceType: h.source_type ?? null,
      sentAt, waitFrom, sentBy: h.validated_by_name ?? null, lines: ls.length, confirmed: Math.min(confirmed, ls.length), state,
      receivedAt: done ? lastAt : null, receivedBy: done ? lastBy : null, late,
    };
  });
}
