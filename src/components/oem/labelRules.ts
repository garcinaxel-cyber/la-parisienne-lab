// Per-product carton-label rules for an OEM client (Axel, 2026-10-27 — Maison Mooncake only for now).
// Stored in lab_mm_settings client_info:<client>.products[group_key] = { months, store, store_en,
// allergens, allergens_en }. A client without `products` (Tianhe Food) keeps the old behaviour:
// note-level best-before (delivery + shelf_days) and the generic storage text.
export type ProductRule = { months?: number; store?: string; store_en?: string; allergens?: string; allergens_en?: string };

export const DEFAULT_STORE = 'nơi khô ráo, thoáng mát (< 25 °C), tránh ánh nắng và côn trùng.';
export const DEFAULT_STORE_EN = 'Store dry & cool, away from sunlight and pests.';

export function productRule(client: any, groupKey?: string | null): ProductRule | null {
  const p = client?.products;
  if (!p || typeof p !== 'object' || !groupKey) return null;
  return (p[groupKey] as ProductRule) ?? null;
}

// prod date + n calendar months, clamped to the month's last day (31/10 + 6 → 30/04)
export function addMonthsIso(iso: string, n: number): string {
  const y = Number(iso.slice(0, 4)), m = Number(iso.slice(5, 7)) - 1 + n, d = Number(iso.slice(8, 10));
  const ty = y + Math.floor(m / 12), tm = ((m % 12) + 12) % 12;
  const last = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  return new Date(Date.UTC(ty, tm, Math.min(d, last))).toISOString().slice(0, 10);
}

// best-before printed on one carton: per-product rule from its production date, else the note's
export function cartonBestBefore(client: any, carton: { group_key?: string | null; prod_date: string }, noteBestBefore: string): string {
  const r = productRule(client, carton.group_key);
  return r?.months ? addMonthsIso(carton.prod_date, Number(r.months)) : noteBestBefore;
}
