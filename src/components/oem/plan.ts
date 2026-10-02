// Delivery schedule of an OEM order (Axel, 2026-09-30 — Maison Mooncake "latest proposal":
// 6 deliveries 02/11 → 12/01, % of the order each). Stored in lab_mm_delivery_plan (admin edits it
// in Settings). Everything else is derived here so the office page and Hung's station agree:
//   per delivery → bags per SKU (cumulative rounding, so the 6 batches add up exactly to the order),
//   kg per product group, and the date by which Hung's kg must be baked.
import { itemKg, type Item } from './model';

// qty (optional, {sku: qty}) = explicit quantities per product for this delivery (Tianhe: 150 kg each, then 340/160/210);
// otherwise the delivery is `pct` % of every product. delivery_date may be null (date not given yet).
export type PlanRow = { id: string; client_name: string | null; seq: number; delivery_date: string | null; pct: number; label: string | null; qty?: Record<string, number> | null };
export type Batch = {
  row: PlanRow; cumPct: number;
  qty: Record<string, number>;      // per sku, this delivery (bags, or kg for kg items)
  cumQty: Record<string, number>;   // per sku, cumulative up to this delivery
  kg: number;                       // total kg of this delivery
  cumKgByGroup: Record<string, number>; // per product group, cumulative kg to have baked
  produceBy: string | null;         // ISO date: bake before this day (delivery − lead days); null = date not given
};

// Hung must have baked a delivery's kg a few days before it leaves (reception + packing + count).
export const PRODUCE_LEAD_DAYS = 3;
const addDays = (iso: string, n: number) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

// items = the client's items (already filtered); plan = that client's rows.
export function buildBatches(items: Item[], plan: PlanRow[]): Batch[] {
  const rows = [...plan].sort((a, b) => a.seq - b.seq);
  let cum = 0; const prev: Record<string, number> = {};
  const totalKg = items.reduce((s, i) => s + itemKg(i, i.qty_ordered), 0);
  let cumKgAll = 0;
  return rows.map(row => {
    cum += Number(row.pct);
    const qty: Record<string, number> = {}, cumQty: Record<string, number> = {}, cumKgByGroup: Record<string, number> = {};
    let kg = 0;
    for (const i of items) {
      const raw = row.qty ? (prev[i.sku] ?? 0) + Number(row.qty[i.sku] ?? 0) : (i.qty_ordered * Math.min(cum, 100)) / 100;
      const c = i.unit === 'kg' ? Math.round(raw * 10) / 10 : Math.round(raw);
      cumQty[i.sku] = c; qty[i.sku] = c - (prev[i.sku] ?? 0); prev[i.sku] = c;
      kg += itemKg(i, qty[i.sku]);
      cumKgByGroup[i.group_key] = (cumKgByGroup[i.group_key] ?? 0) + itemKg(i, c);
    }
    cumKgAll += kg;
    const cumPct = row.qty ? (totalKg ? (cumKgAll / totalKg) * 100 : 0) : cum;
    return { row, cumPct, qty, cumQty, kg, cumKgByGroup, produceBy: row.delivery_date ? addDays(row.delivery_date, -PRODUCE_LEAD_DAYS) : null };
  });
}

// plan rows of a client (null client_name = Maison Mooncake)
export const planOf = (plan: PlanRow[], clientName: string | null | undefined, mmClient: string) =>
  plan.filter(p => (p.client_name || mmClient) === (clientName || mmClient));

// dd/mm or a "date to confirm" label
export const dOr = (iso: string | null | undefined, L: (vi: string, en: string) => string, full = false) =>
  iso ? (full ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(2, 4)}` : `${iso.slice(8, 10)}/${iso.slice(5, 7)}`) : L('chưa có ngày', 'date TBC');

// Production declared for a given order/delivery (lab_mm_production_log.plan_seq — Axel 2026-10-02:
// Hung bakes cashews for the 1 t order while the 710 kg one is still open). For one product group:
//   own[k]  = kg of delivery k alone, seqs[k] = its number, bySeq = baked kg per number (0 = not chosen).
// Kg baked for a delivery fill that delivery first; the rest (not chosen, or more than that delivery
// needs) fills the re-make for losses, then the deliveries in order — so with nothing chosen the result
// is exactly the old cumulative rule: left up to delivery k = max(0, cum + remake − baked).
export function allocateBaked(own: number[], seqs: number[], bySeq: Record<number, number>, remake: number): { ownLeft: number[]; remakeLeft: number } {
  let pool = 0;
  for (const [s, kg] of Object.entries(bySeq)) if (!seqs.includes(Number(s))) pool += kg;
  const ownLeft = own.map((need, k) => { const t = bySeq[seqs[k]] ?? 0; const a = Math.min(need, t); pool += t - a; return need - a; });
  const useR = Math.min(remake, pool); pool -= useR;
  for (let k = 0; k < ownLeft.length; k++) { const a = Math.min(ownLeft[k], pool); ownLeft[k] -= a; pool -= a; }
  return { ownLeft, remakeLeft: remake - useR };
}
