// Products the shops count in a different unit than the one Odoo stores (Axel, 2026-10-26).
// The shop app always shows and records the count in the shop's own unit (what people can
// actually count on the shelf); the quantity is converted to the Odoo unit only when it is sent
// to Odoo. Example: VTTH929 túi nilon hột xoài 20x30 is counted in bags at the shops but bought
// and stored in kg in Odoo — 100 bags = 1 kg. Before this, shops typed bags into a kg field
// (09/2026 inventory: 304 "kg" at Tây Hồ instead of 3 kg).
//
// Add a product here only after checking its Odoo unit (product.uom_id) and the real
// conversion with the purchasing team.

export type CountUnit = {
  vi: string;           // unit label shown to the shop staff (Vietnamese)
  en: string;           // same label in English
  perOdooUnit: number;  // how many counted units make one Odoo unit (100 bags = 1 kg → 100)
  odooUom: string;      // Odoo unit, for display only
};

export const COUNT_UNITS: Record<string, CountUnit> = {
  VTTH929: { vi: 'túi', en: 'bags', perOdooUnit: 100, odooUom: 'kg' },
};

export function countUnitFor(sku: string | null | undefined): CountUnit | null {
  return (sku && COUNT_UNITS[sku]) || null;
}

/** Shop-counted quantity → quantity in the Odoo unit (rounded to 4 decimals). */
export function countToOdoo(sku: string | null | undefined, qty: number): number {
  const u = countUnitFor(sku);
  if (!u) return qty;
  return Math.round((qty / u.perOdooUnit) * 10000) / 10000;
}

/** Odoo quantity → quantity in the shop's counting unit. */
export function odooToCount(sku: string | null | undefined, qty: number): number {
  const u = countUnitFor(sku);
  if (!u) return qty;
  return Math.round(qty * u.perOdooUnit * 100) / 100;
}
