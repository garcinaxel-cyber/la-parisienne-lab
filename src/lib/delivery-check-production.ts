import type { SupabaseClient } from '@supabase/supabase-js';

// Production vs delivery, per SKU, for one delivery date (Axel, 2026-10-19: "la nouvelle colonne
// dans la delivery check pour voir ce qui a été produit vs livré"). READ-ONLY, display only —
// never blocks a check or a validation. Figures are for the WHOLE delivery date (all orders of
// the day), because production cards are per product per day, not per order.
//
// - planned  = qty to produce on the day's cards (excluding cancelled / served-from-stock / blocked)
// - produced = qty marked produced on those cards
// - sent     = qty the chefs sent to stock ("chuyển kho") — this is what creates the Odoo MO
// - stock    = qty the chefs marked "Có sẵn" (served from stock, card status 'skip')
// - ordered / checked = sum over every production check line of that SKU on that date
export interface ProdStatus {
  cards: number;
  planned: number;
  produced: number;
  sent: number;
  stock: number;
  blocked: number;
  teams: string[];
  ordered: number;
  checked: number;
  // Cards made for THIS order (card.breakdown lists the order refs it serves). `shared` = the
  // largest number of orders on one of those cards (>1 → transfer can't be split per order).
  order: { planned: number; produced: number; sent: number; stock: number; blocked: number; shared: number } | null;
  // Other cards of the day still short of transfer — named so the assistant knows where.
  others: { ref: string; shop: string | null; missing: number; shared: number; notMade: boolean }[];
}

export async function fetchProductionStatusBySku(
  supabase: SupabaseClient, date: string, skus: string[], orderRef?: string,
): Promise<Record<string, ProdStatus>> {
  const out: Record<string, ProdStatus> = {};
  const uniq = Array.from(new Set(skus.filter(Boolean)));
  if (!date || !uniq.length) return out;
  try {
    const blank = (): ProdStatus => ({ cards: 0, planned: 0, produced: 0, sent: 0, stock: 0, blocked: 0, teams: [], ordered: 0, checked: 0, order: null, others: [] });
    for (const s of uniq) out[s] = blank();

    const [{ data: variants }, { data: imports }, { data: dayLines }] = await Promise.all([
      supabase.from('lab_fiche_variants').select('id, sku').in('sku', uniq),
      supabase.from('lab_imports').select('id').eq('delivery_date', date),
      supabase.from('lab_delivery_check_lines').select('sku, qty_expected, qty_checked')
        .eq('delivery_date', date).eq('category', 'production').in('sku', uniq),
    ]);

    for (const l of dayLines ?? []) {
      const s = out[l.sku as string]; if (!s) continue;
      s.ordered += Number(l.qty_expected) || 0;
      if (l.qty_checked != null) s.checked += Number(l.qty_checked) || 0;
    }

    const skuByVariant: Record<string, string> = {};
    for (const v of variants ?? []) if (v.sku) skuByVariant[v.id] = v.sku;
    const vids = Object.keys(skuByVariant);
    const importIds = (imports ?? []).map((i: any) => i.id);
    if (!vids.length || !importIds.length) return out;

    const { data: cards } = await supabase.from('lab_assignments')
      .select('variant_id, team, status, cancelled, total_qty, qty_to_produce, qty_produced, qty_sent_total, breakdown')
      .in('import_id', importIds).in('variant_id', vids);
    for (const c of cards ?? []) {
      if (c.cancelled) continue;
      const s = out[skuByVariant[c.variant_id as string]]; if (!s) continue;
      const qty = Number(c.qty_to_produce ?? c.total_qty) || 0;
      s.cards += 1;
      if (c.team && !s.teams.includes(c.team)) s.teams.push(c.team);
      const bd: any[] = Array.isArray(c.breakdown) ? c.breakdown : [];
      const refs = Array.from(new Set(bd.map(b => b?.order_ref).filter(Boolean))) as string[];
      const mine = !!orderRef && refs.includes(orderRef);
      if (mine) {
        const o = s.order ??= { planned: 0, produced: 0, sent: 0, stock: 0, blocked: 0, shared: 1 };
        o.shared = Math.max(o.shared, refs.length || 1);
        if (c.status === 'skip') o.stock += qty;
        else if (c.status === 'blocked') o.blocked += qty;
        else { o.planned += qty; o.produced += Number(c.qty_produced) || 0; o.sent += Number(c.qty_sent_total) || 0; }
      }
      if (c.status === 'skip') { s.stock += qty; continue; }
      if (c.status === 'blocked') { s.blocked += qty; continue; }
      const sent = Number(c.qty_sent_total) || 0;
      s.planned += qty;
      s.produced += Number(c.qty_produced) || 0;
      s.sent += sent;
      if (!mine && sent < qty) {
        const first = bd.find(b => b?.order_ref) ?? null;
        s.others.push({
          ref: first?.order_ref ?? '?', shop: first?.shop_name ?? null, missing: qty - sent,
          shared: refs.length || 1, notMade: !(Number(c.qty_produced) > 0),
        });
      }
    }
  } catch {
    return {}; // display-only: any failure just hides the column content, never the page
  }
  return out;
}

// Families made as extra production for stock, never on demand (Axel, 2026-10-19).
export const STOCK_FAMILIES = new Set(['macaron', 'biscuit voyage', 'tiramisu']);
export const isStockFamily = (cat: string | null | undefined) => !!cat && STOCK_FAMILIES.has(cat.trim().toLowerCase());

// "Écart SX" tag on the delivery-check list (Axel, 2026-10-19). Per order: products already
// checked (qty > 0, i.e. leaving) whose own production card — the card whose breakdown names this
// order — is not fully sent to stock, or was marked "Có sẵn" (served from stock) although it is an
// on-demand product. Stock families are ignored. Display only; empty on any failure.
export async function fetchProductionGapsByOrder(
  supabase: SupabaseClient, dates: string[], headerById: Record<string, { order_ref: string; delivery_date: string }>,
  // Filled with the orders whose OWN card was not fully sent to stock although the day as a whole
  // balances (Axel 2026-10-20, SBCPB: REP/02075's card sent 1/3, the shared card of 02076/02078
  // sent 4 for 2 delivered) — softer orange "Thẻ chưa chuyển đủ" tag, distinct from the red one.
  shortOut?: Record<string, string[]>,
): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  const headerIds = Object.keys(headerById);
  if (!dates.length || !headerIds.length) return out;
  try {
    const lines: any[] = [];
    // Paginated: PostgREST caps every response at 1000 rows (2026-10-19 — the first version read
    // only 1000 of the window's lines, so most orders never got their tag).
    for (let i = 0; i < headerIds.length; i += 100) {
      for (let from = 0; ; from += 1000) {
        const { data } = await supabase.from('lab_delivery_check_lines')
          .select('id, delivery_order_id, sku, product_name_vi, product_category, qty_checked')
          .in('delivery_order_id', headerIds.slice(i, i + 100)).eq('category', 'production').gt('qty_checked', 0)
          .order('id').range(from, from + 999);
        lines.push(...(data ?? []));
        if (!data || data.length < 1000) break;
      }
    }
    const relevant = lines.filter(l => l.sku && !isStockFamily(l.product_category));
    if (!relevant.length) return out;

    const { data: imports } = await supabase.from('lab_imports').select('id, delivery_date').in('delivery_date', dates);
    const dateByImport: Record<string, string> = {};
    for (const i of imports ?? []) dateByImport[i.id] = i.delivery_date;
    const importIds = Object.keys(dateByImport);
    if (!importIds.length) return out;
    const cards: any[] = [];
    for (let from = 0; ; from += 1000) {
      const { data } = await supabase.from('lab_assignments')
        .select('id, import_id, variant_id, status, cancelled, total_qty, qty_to_produce, qty_sent_total, breakdown')
        .in('import_id', importIds).order('id').range(from, from + 999);
      cards.push(...(data ?? []));
      if (!data || data.length < 1000) break;
    }
    const vids = Array.from(new Set(cards.map(c => c.variant_id).filter(Boolean)));
    const skuByVariant: Record<string, string> = {};
    for (let i = 0; i < vids.length; i += 300) {
      const { data } = await supabase.from('lab_fiche_variants').select('id, sku').in('id', vids.slice(i, i + 300));
      for (const v of data ?? []) if (v.sku) skuByVariant[v.id] = v.sku;
    }
    // date||ref||sku → has a problem
    const bad = new Set<string>();
    const short = new Set<string>();
    // Day balance per date||sku: transfer isn't really per order (2026-10-19 BMSBDT: the card of
    // REP/02060 was sent, but the one croissant went to REP/02058) — only tag when the day as a
    // whole delivered more than the kitchen sent to stock.
    const sentDay: Record<string, number> = {};
    const checkedDay: Record<string, number> = {};
    for (const l of relevant) {
      const h = headerById[l.delivery_order_id]; if (!h) continue;
      const k = `${h.delivery_date}||${l.sku}`;
      checkedDay[k] = (checkedDay[k] ?? 0) + (Number(l.qty_checked) || 0);
    }
    for (const c of cards) {
      if (c.cancelled || c.status === 'blocked' || c.status === 'skip') continue;
      const sku = skuByVariant[c.variant_id]; const date = dateByImport[c.import_id];
      if (!sku || !date) continue;
      sentDay[`${date}||${sku}`] = (sentDay[`${date}||${sku}`] ?? 0) + (Number(c.qty_sent_total) || 0);
    }
    // A card blocked AFTER the product already left (2026-10-19 SBPACAOC REP/02058: "Có sẵn" then
    // "Chặn · Lỗi" at 14:27, yet ×2 delivered and received by the shop) must not hide the gap.
    for (const c of cards) {
      if (c.cancelled) continue;
      const sku = skuByVariant[c.variant_id]; const date = dateByImport[c.import_id];
      if (!sku || !date) continue;
      const qty = Number(c.qty_to_produce ?? c.total_qty) || 0;
      if ((checkedDay[`${date}||${sku}`] ?? 0) <= (sentDay[`${date}||${sku}`] ?? 0)) {
        if (c.status !== 'skip' && c.status !== 'blocked' && (Number(c.qty_sent_total) || 0) < qty)
          for (const b of Array.isArray(c.breakdown) ? c.breakdown : []) if (b?.order_ref) short.add(`${date}||${b.order_ref}||${sku}`);
        continue;
      }
      const problem = c.status === 'skip' || c.status === 'blocked' || (Number(c.qty_sent_total) || 0) < qty;
      if (!problem) continue;
      for (const b of Array.isArray(c.breakdown) ? c.breakdown : []) if (b?.order_ref) bad.add(`${date}||${b.order_ref}||${sku}`);
    }
    for (const l of relevant) {
      const h = headerById[l.delivery_order_id]; if (!h) continue;
      if (shortOut && short.has(`${h.delivery_date}||${h.order_ref}||${l.sku}`)) {
        const sl = shortOut[`${h.delivery_date}||${h.order_ref}`] ??= [];
        if (!sl.includes(l.product_name_vi)) sl.push(l.product_name_vi);
      }
      if (!bad.has(`${h.delivery_date}||${h.order_ref}||${l.sku}`)) continue;
      const key = `${h.delivery_date}||${h.order_ref}`;
      const list = out[key] ??= [];
      if (!list.includes(l.product_name_vi)) list.push(l.product_name_vi);
    }
  } catch (e) {
    console.error('production gaps by order failed:', e);
    return {};
  }
  return out;
}
