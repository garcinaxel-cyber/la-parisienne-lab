// Delivery schedule of an OEM order (Axel, 2026-09-30 — Maison Mooncake "latest proposal":
// 6 deliveries 02/11 → 12/01, % of the order each). Stored in lab_mm_delivery_plan (admin edits it
// in Settings). Everything else is derived here so the office page and Hung's station agree:
//   per delivery → bags per SKU (cumulative rounding, so the 6 batches add up exactly to the order),
//   kg per product group, and the date by which Hung's kg must be baked.
import { itemKg, type Item } from './model';

export type PlanRow = { id: string; client_name: string | null; seq: number; delivery_date: string; pct: number; label: string | null };
export type Batch = {
  row: PlanRow; cumPct: number;
  qty: Record<string, number>;      // per sku, this delivery (bags, or kg for kg items)
  cumQty: Record<string, number>;   // per sku, cumulative up to this delivery
  kg: number;                       // total kg of this delivery
  cumKgByGroup: Record<string, number>; // per product group, cumulative kg to have baked
  produceBy: string;                // ISO date: bake before this day (delivery − lead days)
};

// Hung must have baked a delivery's kg a few days before it leaves (reception + packing + count).
export const PRODUCE_LEAD_DAYS = 3;
const addDays = (iso: string, n: number) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

// items = the client's items (already filtered); plan = that client's rows.
export function buildBatches(items: Item[], plan: PlanRow[]): Batch[] {
  const rows = [...plan].sort((a, b) => a.seq - b.seq);
  let cum = 0; const prev: Record<string, number> = {};
  return rows.map(row => {
    cum += Number(row.pct);
    const qty: Record<string, number> = {}, cumQty: Record<string, number> = {}, cumKgByGroup: Record<string, number> = {};
    let kg = 0;
    for (const i of items) {
      const raw = (i.qty_ordered * Math.min(cum, 100)) / 100;
      const c = i.unit === 'kg' ? Math.round(raw * 10) / 10 : Math.round(raw);
      cumQty[i.sku] = c; qty[i.sku] = c - (prev[i.sku] ?? 0); prev[i.sku] = c;
      kg += itemKg(i, qty[i.sku]);
      cumKgByGroup[i.group_key] = (cumKgByGroup[i.group_key] ?? 0) + itemKg(i, c);
    }
    return { row, cumPct: cum, qty, cumQty, kg, cumKgByGroup, produceBy: addDays(row.delivery_date, -PRODUCE_LEAD_DAYS) };
  });
}

// plan rows of a client (null client_name = Maison Mooncake)
export const planOf = (plan: PlanRow[], clientName: string | null | undefined, mmClient: string) =>
  plan.filter(p => (p.client_name || mmClient) === (clientName || mmClient));
