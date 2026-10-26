// Products the shops count in a different unit than the one Odoo stores (Axel, 2026-10-26).
// By default the shop app shows the count in the shop's own unit (what people can actually count
// on the shelf) and converts it to the Odoo unit when saving. Example: VTTH929 túi nilon hột xoài 20x30 is counted in bags at the shops but bought
// and stored in kg in Odoo — 100 bags = 1 kg. Before this, shops typed bags into a kg field
// (09/2026 inventory: 304 "kg" at Tây Hồ instead of 3 kg).
//
// The shop can switch each such line between its counting unit and the Odoo unit (Axel, 2026-10-26:
// "count in kg or in unit, in both cases Odoo is in kg"). The count is always stored in the Odoo unit.
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
  // VTTH070 dĩa ăn bánh cho shop = cake forks (dĩa = fork in the North): bought by the kg (50 000/kg),
  // about 650 forks = 1 kg (Axel, 2026-10-26).
  VTTH070: { vi: 'cái', en: 'forks', perOdooUnit: 650, odooUom: 'kg' },
};

export function countUnitFor(sku: string | null | undefined): CountUnit | null {
  return (sku && COUNT_UNITS[sku]) || null;
}

/** Shop-counted quantity → quantity in the Odoo unit (rounded to 5 decimals, Odoo kg rounding). */
export function countToOdoo(sku: string | null | undefined, qty: number): number {
  const u = countUnitFor(sku);
  if (!u) return qty;
  return Math.round((qty / u.perOdooUnit) * 100000) / 100000;
}

/** Odoo quantity → quantity in the shop's counting unit. */
export function odooToCount(sku: string | null | undefined, qty: number): number {
  const u = countUnitFor(sku);
  if (!u) return qty;
  return Math.round(qty * u.perOdooUnit * 100) / 100;
}
