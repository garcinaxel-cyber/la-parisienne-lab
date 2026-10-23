// Stock production teams (Axel, 2026-10-23): Team Hung makes only storable products (macarons,
// biscuits voyage, chocolate) and records its real work as EXTRA production. An order card for
// those products has nothing to do — the order is served from the Lab stock, or not delivered —
// so it is created directly as 'skip' ("in stock") instead of 'pending'. OEM SKUs are untouched.
export const STOCK_PRODUCTION_TEAMS = ['hung'];
export const STOCK_PRODUCTION_CATEGORIES = ['Macaron', 'Biscuit Voyage', 'Chocolate'];
const isOem = (sku?: string | null) => !!sku && /^(MM-|OEM-)/i.test(sku);

export function autoStockStatus(team: string, category: string | null | undefined, sku?: string | null): 'skip' | 'pending' {
  return STOCK_PRODUCTION_TEAMS.includes(team) && !!category && STOCK_PRODUCTION_CATEGORIES.includes(category) && !isOem(sku)
    ? 'skip' : 'pending';
}
