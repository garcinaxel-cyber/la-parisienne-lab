// Storable products served from the Lab stock (Axel, 2026-10-23): the team records its real work as
// EXTRA production, so an order card for those products has nothing to do — the order is served
// from stock, or not delivered. Such cards are created directly as 'skip' ("in stock").
// Team Hung: macarons, biscuits voyage, chocolate. Team Gato (baby_mama): tiramisu only.
// OEM SKUs are never touched.
export const STOCK_PRODUCTION_BY_TEAM: Record<string, string[]> = {
  hung: ['Macaron', 'Biscuit Voyage', 'Chocolate'],
  baby_mama: ['Tiramisu'],
};
export const STOCK_PRODUCTION_TEAMS = Object.keys(STOCK_PRODUCTION_BY_TEAM);
const isOem = (sku?: string | null) => !!sku && /^(MM-|OEM-)/i.test(sku);

export function autoStockStatus(team: string, category: string | null | undefined, sku?: string | null): 'skip' | 'pending' {
  return !!category && (STOCK_PRODUCTION_BY_TEAM[team] ?? []).includes(category) && !isOem(sku) ? 'skip' : 'pending';
}
