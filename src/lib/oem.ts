// OEM orders (Maison Mooncake biscuits "MM-…", Tianhe Food cashews "OEM-…") — Axel, 2026-09-26.
//
// These SKUs are produced in bulk by Team Hưng (entered in kg through the usual extra-production
// modal), packed by the assistants and delivered through dedicated client sales orders. They
// must NEVER behave like shop products:
//   • an imported order line for them never becomes a production card (it is routed to the
//     delivery-check "non-production" bucket, exactly like lab_excluded_skus items);
//   • their extra-production cards are never "sent to stock" from the station (the finished
//     product is created in Odoo at packaging time, from the OEM Orders tab);
//   • they never appear in any shop-facing screen.
// Everything else in the app is untouched: the rule is keyed ONLY on the SKU prefix, so any SKU
// that doesn't start with "MM-" or "OEM-" keeps exactly its previous behaviour.
export const OEM_SKU_RE = /^(MM|OEM)-/;

export function isOemSku(sku: string | null | undefined): boolean {
  return !!sku && OEM_SKU_RE.test(sku);
}

// Drop-in replacement for the `new Set(excludedRows.map(r => r.sku))` pattern used by the Odoo
// order sync: behaves like the plain excluded-SKU set, plus every OEM SKU counts as excluded.
export class OemAwareExcludedSet extends Set<string> {
  has(value: string): boolean {
    return super.has(value) || isOemSku(value);
  }
}
