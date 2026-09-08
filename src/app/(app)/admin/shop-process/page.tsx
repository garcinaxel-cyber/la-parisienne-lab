import { createClient, getSafeSession } from '@/lib/supabase-server';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { redirect } from 'next/navigation';
import { PORTAL_SHOP_NAMES } from '@/lib/shops';
import ShopProcessView, { type ShopRecap } from './ShopProcessView';

export const revalidate = 0;

// Admin-only recap of the SHOPS' own process compliance for one day (today or yesterday only —
// Axel, 2026-09-08: "tu met max la veille et le jour meme en historique", storage-conscious:
// this reads live from the operational tables at render time, no new table, no history kept
// beyond what those tables already retain on their own). Explicitly the shops' point of view —
// NOT Lab-internal processes (those live in Check, /admin/reconciliation).
//
// 5 columns, one per thing Axel asked to see per shop: réception (lab_delivery_check_lines +
// lab_shop_receipt_lines), comptage (lab_shop_stock_sessions_done), commande (lab_order_lines
// vs lab_shop_manager_orders — the join that flags an order placed directly in Odoo instead of
// through the app), pertes (lab_shop_losses), transferts (lab_shop_transfers). No "on time /
// late" judgment anywhere (Axel: "car si ils ont fait à l'heure on a pas de comparatif") — only
// genuine anomalies (quantity mismatch, missing action, Odoo-direct order) are ever flagged.
function vnDateStr(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
function vnDayRangeUtc(dateStr: string): { start: string; end: string } {
  const start = new Date(`${dateStr}T00:00:00+07:00`);
  return { start: start.toISOString(), end: new Date(start.getTime() + 86400000).toISOString() };
}

const SHOPS = PORTAL_SHOP_NAMES; // Moon Flower + the 4 La Paris shops with a portal login

export default async function ShopProcessPage({ searchParams }: { searchParams: { date?: string } }) {
  const supabase = createClient();
  const { data: { session } } = await getSafeSession(supabase);
  if (!session) redirect('/login');
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
  if (profile?.role !== 'admin') redirect('/dashboard');

  const which: 'today' | 'yesterday' = searchParams?.date === 'yesterday' ? 'yesterday' : 'today';
  const now = new Date();
  const date = vnDateStr(which === 'yesterday' ? new Date(now.getTime() - 86400000) : now);
  const { start, end } = vnDayRangeUtc(date);

  // lab_shop_stock_sessions_done and lab_shop_transfers have RLS enabled with no policy at
  // all (only ever written/read via server actions using the service-role key elsewhere in
  // the app — see shop/actions.ts, api/odoo/stock-count-recap) -- the cookie-scoped client
  // above would silently see zero rows there. Service-role client for the actual data reads;
  // the admin check above already gates who can reach this page.
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) redirect('/dashboard');
  const svc = createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

  const [
    { data: dos },
    { data: sessions },
    { data: orderLines },
    { data: managerOrders },
    { data: losses },
    { data: transfers },
  ] = await Promise.all([
    svc.from('lab_delivery_orders').select('id, order_ref, delivery_date, shop_name').in('shop_name', SHOPS).eq('delivery_date', date),
    svc.from('lab_shop_stock_sessions_done').select('shop_name, count_date, session_seq, finished_at, finished_by_name, sku_count, valuation').in('shop_name', SHOPS).eq('count_date', date),
    svc.from('lab_order_lines').select('order_ref, shop_name, delivery_date').in('shop_name', SHOPS).eq('delivery_date', date),
    svc.from('lab_shop_manager_orders').select('shop_name, order_ref, delivery_date, created_at, manager_name').in('shop_name', SHOPS).eq('delivery_date', date),
    svc.from('lab_shop_losses').select('shop_name, sku, product_name, qty, reason_tag_name, reported_by_name, reported_at').in('shop_name', SHOPS).gte('reported_at', start).lt('reported_at', end),
    svc.from('lab_shop_transfers').select('id, ref, from_shop, to_shop, status, sent_by_name, sent_at, received_by_name, received_at, unit_count, line_count').gte('sent_at', start).lt('sent_at', end),
  ]);

  const doIds = (dos ?? []).map(d => d.id);
  const { data: checkLines } = doIds.length
    ? await svc.from('lab_delivery_check_lines').select('id, delivery_order_id, sku, product_name_vi, qty_expected, qty_checked').in('delivery_order_id', doIds)
    : { data: [] as any[] };
  const clIds = (checkLines ?? []).map(l => l.id);
  const { data: receipts } = clIds.length
    ? await svc.from('lab_shop_receipt_lines').select('check_line_id, delivery_order_id, qty_received, status, confirmed_by_name, confirmed_at').in('check_line_id', clIds)
    : { data: [] as any[] };

  const doById: Record<string, any> = {};
  for (const d of dos ?? []) doById[d.id] = d;
  const receiptByCheckLine: Record<string, any> = {};
  for (const r of receipts ?? []) receiptByCheckLine[r.check_line_id] = r;

  const recaps: ShopRecap[] = SHOPS.map(shop => {
    // ── Réception ──
    const shopDos = (dos ?? []).filter(d => d.shop_name === shop);
    const shopDoIds = new Set(shopDos.map(d => d.id));
    const shopLines = (checkLines ?? []).filter(l => shopDoIds.has(l.delivery_order_id));
    const linesWithReceipt = shopLines.map(l => ({ line: l, receipt: receiptByCheckLine[l.id] as any }));
    const confirmedCount = linesWithReceipt.filter(x => x.receipt).length;
    const discrepancies = linesWithReceipt
      .filter(x => x.receipt && Number(x.receipt.qty_received) !== Number(x.line.qty_checked ?? x.line.qty_expected))
      .map(x => ({
        sku: x.line.sku as string | null, product: x.line.product_name_vi as string,
        expected: Number(x.line.qty_checked ?? x.line.qty_expected ?? 0), received: Number(x.receipt.qty_received ?? 0),
      }));
    const confirmedAts = linesWithReceipt.filter(x => x.receipt).map(x => x.receipt.confirmed_at as string).sort();
    const confirmers = Array.from(new Set(linesWithReceipt.filter(x => x.receipt).map(x => x.receipt.confirmed_by_name as string)));
    // Totals only (Axel, 2026-09-08: itemized per-line discrepancies made the cell too tall --
    // "juste le comparatif total quantite recu vs quantite check"). Expected is summed over
    // every line regardless of confirmation state; received only over lines actually confirmed
    // so far, so a still-in-progress reception reads as "42/60", not a false mismatch.
    const totalExpectedQty = shopLines.reduce((s, l) => s + Number(l.qty_checked ?? l.qty_expected ?? 0), 0);
    const totalReceivedQty = linesWithReceipt.reduce((s, x) => s + (x.receipt ? Number(x.receipt.qty_received ?? 0) : 0), 0);
    const reception: ShopRecap['reception'] = shopLines.length === 0 ? null : {
      totalLines: shopLines.length, confirmedLines: confirmedCount,
      lastConfirmedAt: confirmedAts.length ? confirmedAts[confirmedAts.length - 1] : null,
      confirmedBy: confirmers, discrepancies, totalExpectedQty, totalReceivedQty,
    };

    // ── Comptage ──
    const shopSessions = (sessions ?? []).filter(s => s.shop_name === shop).sort((a, b) => (b.session_seq ?? 0) - (a.session_seq ?? 0));
    const count = shopSessions.length ? {
      sessionsCount: shopSessions.length, finishedAt: shopSessions[0].finished_at as string,
      finishedBy: shopSessions[0].finished_by_name as string, skuCount: shopSessions[0].sku_count as number,
      valuation: Number(shopSessions[0].valuation ?? 0),
    } : null;

    // ── Commande ──
    const refs = Array.from(new Set((orderLines ?? []).filter(o => o.shop_name === shop).map(o => o.order_ref).filter(Boolean)));
    const shopManagerOrders = (managerOrders ?? []).filter(m => m.shop_name === shop);
    const orders = refs.map(ref => {
      const m = shopManagerOrders.find(x => x.order_ref === ref);
      return m
        ? { ref: ref as string, placedAt: m.created_at as string, placedBy: m.manager_name as string, odooDirect: false }
        : { ref: ref as string, placedAt: null, placedBy: null, odooDirect: true };
    });

    // ── Pertes ── total qty only (Axel, 2026-09-08: "juste le total scrap" -- itemized loss
    // lines made the cell too tall; the total is what she actually scans this table for).
    const shopLosses = (losses ?? []).filter(l => l.shop_name === shop);
    const lossesOut: ShopRecap['losses'] = { count: shopLosses.length, totalQty: shopLosses.reduce((s, l) => s + Number(l.qty ?? 0), 0) };

    // ── Transferts ──
    const shopTransfers = (transfers ?? []).filter(t => t.from_shop === shop || t.to_shop === shop);
    const transfersOut: ShopRecap['transfers'] = shopTransfers.map(t => ({
      direction: t.from_shop === shop ? 'out' : 'in', otherShop: t.from_shop === shop ? t.to_shop : t.from_shop,
      ref: t.ref as string, status: t.status as string, by: t.sent_by_name as string, at: t.sent_at as string,
      units: Number(t.unit_count ?? 0),
    }));

    return { shop, reception, count, orders, losses: lossesOut, transfers: transfersOut };
  });

  return <ShopProcessView date={date} which={which} recaps={recaps} />;
}
