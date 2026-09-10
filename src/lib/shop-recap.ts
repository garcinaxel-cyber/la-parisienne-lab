// Shared per-shop process recap — extracted 2026-09-10 (shop-manager feature) from
// admin/shop-process/page.tsx, which owned this exact computation first (Axel, 2026-09-08:
// "recap du respect du process des shops"). Both admin's own "Suivi shops" table (every portal
// shop, one call) and the new shop-manager "Today"/"Shops" tabs (one shop, or a manager's own
// subset) now call this ONE function instead of each carrying its own copy — same batched-query
// shape either way (`.in('shop_name', shops)`, never one query per shop), so scoping to a single
// shop is just a 1-element `shops` array, not a different code path.
import type { SupabaseClient } from '@supabase/supabase-js';

export type ShopRecap = {
  shop: string;
  reception: {
    totalLines: number; confirmedLines: number; lastConfirmedAt: string | null; confirmedBy: string[];
    discrepancies: { sku: string | null; product: string; expected: number; received: number }[];
    totalExpectedQty: number; totalReceivedQty: number;
  } | null;
  count: { sessionsCount: number; finishedAt: string; finishedBy: string; skuCount: number; valuation: number } | null;
  orders: { ref: string; placedAt: string | null; placedBy: string | null; odooDirect: boolean }[];
  losses: { count: number; totalQty: number };
  transfers: { direction: 'in' | 'out'; otherShop: string; ref: string; status: string; by: string; at: string; units: number }[];
};

function vnDayRangeUtc(dateStr: string): { start: string; end: string } {
  const start = new Date(`${dateStr}T00:00:00+07:00`);
  return { start: start.toISOString(), end: new Date(start.getTime() + 86400000).toISOString() };
}

// Caller passes a service-role client (lab_shop_stock_sessions_done and lab_shop_transfers have
// RLS enabled with no policy at all — only ever read/written via server actions using the
// service-role key, see shop/actions.ts / api/odoo/stock-count-recap) and the exact set of shops
// to compute — every query below is batched across that whole set in one round trip, filtered
// per-shop in JS after, never looped per shop.
export async function computeShopRecaps(svc: SupabaseClient, shops: string[], date: string): Promise<ShopRecap[]> {
  if (!shops.length) return [];
  const { start, end } = vnDayRangeUtc(date);

  const [
    { data: dos },
    { data: sessions },
    { data: orderLines },
    { data: managerOrders },
    { data: losses },
    { data: transfers },
  ] = await Promise.all([
    svc.from('lab_delivery_orders').select('id, order_ref, delivery_date, shop_name').in('shop_name', shops).eq('delivery_date', date),
    svc.from('lab_shop_stock_sessions_done').select('shop_name, count_date, session_seq, finished_at, finished_by_name, sku_count, valuation').in('shop_name', shops).eq('count_date', date),
    svc.from('lab_order_lines').select('order_ref, shop_name, delivery_date').in('shop_name', shops).eq('delivery_date', date),
    svc.from('lab_shop_manager_orders').select('shop_name, order_ref, delivery_date, created_at, manager_name').in('shop_name', shops).eq('delivery_date', date),
    svc.from('lab_shop_losses').select('shop_name, sku, product_name, qty, reason_tag_name, reported_by_name, reported_at').in('shop_name', shops).gte('reported_at', start).lt('reported_at', end),
    svc.from('lab_shop_transfers').select('id, ref, from_shop, to_shop, status, sent_by_name, sent_at, received_by_name, received_at, unit_count, line_count').gte('sent_at', start).lt('sent_at', end),
  ]);

  const doIds = (dos ?? []).map((d: any) => d.id);
  const { data: checkLines } = doIds.length
    ? await svc.from('lab_delivery_check_lines').select('id, delivery_order_id, sku, product_name_vi, qty_expected, qty_checked').in('delivery_order_id', doIds)
    : { data: [] as any[] };
  const clIds = (checkLines ?? []).map((l: any) => l.id);
  const { data: receipts } = clIds.length
    ? await svc.from('lab_shop_receipt_lines').select('check_line_id, delivery_order_id, qty_received, status, confirmed_by_name, confirmed_at').in('check_line_id', clIds)
    : { data: [] as any[] };

  const receiptByCheckLine: Record<string, any> = {};
  for (const r of receipts ?? []) receiptByCheckLine[r.check_line_id] = r;

  return shops.map(shop => {
    // ── Réception ──
    const shopDos = (dos ?? []).filter((d: any) => d.shop_name === shop);
    const shopDoIds = new Set(shopDos.map((d: any) => d.id));
    const shopLines = (checkLines ?? []).filter((l: any) => shopDoIds.has(l.delivery_order_id));
    const linesWithReceipt = shopLines.map((l: any) => ({ line: l, receipt: receiptByCheckLine[l.id] as any }));
    const confirmedCount = linesWithReceipt.filter((x: any) => x.receipt).length;
    const discrepancies = linesWithReceipt
      .filter((x: any) => x.receipt && Number(x.receipt.qty_received) !== Number(x.line.qty_checked ?? x.line.qty_expected))
      .map((x: any) => ({
        sku: x.line.sku as string | null, product: x.line.product_name_vi as string,
        expected: Number(x.line.qty_checked ?? x.line.qty_expected ?? 0), received: Number(x.receipt.qty_received ?? 0),
      }));
    const confirmedAts = linesWithReceipt.filter((x: any) => x.receipt).map((x: any) => x.receipt.confirmed_at as string).sort();
    const confirmers = Array.from(new Set(linesWithReceipt.filter((x: any) => x.receipt).map((x: any) => x.receipt.confirmed_by_name as string)));
    const totalExpectedQty = shopLines.reduce((s: number, l: any) => s + Number(l.qty_checked ?? l.qty_expected ?? 0), 0);
    const totalReceivedQty = linesWithReceipt.reduce((s: number, x: any) => s + (x.receipt ? Number(x.receipt.qty_received ?? 0) : 0), 0);
    const reception: ShopRecap['reception'] = shopLines.length === 0 ? null : {
      totalLines: shopLines.length, confirmedLines: confirmedCount,
      lastConfirmedAt: confirmedAts.length ? confirmedAts[confirmedAts.length - 1] : null,
      confirmedBy: confirmers, discrepancies, totalExpectedQty, totalReceivedQty,
    };

    // ── Comptage ──
    const shopSessions = (sessions ?? []).filter((s: any) => s.shop_name === shop).sort((a: any, b: any) => (b.session_seq ?? 0) - (a.session_seq ?? 0));
    const count = shopSessions.length ? {
      sessionsCount: shopSessions.length, finishedAt: shopSessions[0].finished_at as string,
      finishedBy: shopSessions[0].finished_by_name as string, skuCount: shopSessions[0].sku_count as number,
      valuation: Number(shopSessions[0].valuation ?? 0),
    } : null;

    // ── Commande ──
    const refs = Array.from(new Set((orderLines ?? []).filter((o: any) => o.shop_name === shop).map((o: any) => o.order_ref).filter(Boolean)));
    const shopManagerOrders = (managerOrders ?? []).filter((m: any) => m.shop_name === shop);
    const orders = refs.map((ref: any) => {
      const m = shopManagerOrders.find((x: any) => x.order_ref === ref);
      return m
        ? { ref: ref as string, placedAt: m.created_at as string, placedBy: m.manager_name as string, odooDirect: false }
        : { ref: ref as string, placedAt: null, placedBy: null, odooDirect: true };
    });

    // ── Pertes ── total qty only, same posture as admin's own recap table.
    const shopLosses = (losses ?? []).filter((l: any) => l.shop_name === shop);
    const lossesOut: ShopRecap['losses'] = { count: shopLosses.length, totalQty: shopLosses.reduce((s: number, l: any) => s + Number(l.qty ?? 0), 0) };

    // ── Transferts ──
    const shopTransfers = (transfers ?? []).filter((t: any) => t.from_shop === shop || t.to_shop === shop);
    const transfersOut: ShopRecap['transfers'] = shopTransfers.map((t: any) => ({
      direction: t.from_shop === shop ? 'out' : 'in', otherShop: t.from_shop === shop ? t.to_shop : t.from_shop,
      ref: t.ref as string, status: t.status as string, by: t.sent_by_name as string, at: t.sent_at as string,
      units: Number(t.unit_count ?? 0),
    }));

    return { shop, reception, count, orders, losses: lossesOut, transfers: transfersOut };
  });
}
