// Shared by the "Live inventory" list on the shop Order tab (ShopView.tsx) and its manager-cockpit
// twin (shop-manager/OrderTab.tsx) — Axel, 2026-09-21: "range la liste par catégorie". Both lists
// already carry `category` on every row (ShopStockLevel), just weren't grouped by it client-side.
export function groupByCategory<T extends { category: string; name: string }>(items: T[]): { category: string; items: T[] }[] {
  const map = new Map<string, T[]>();
  for (const it of items) {
    const cat = (it.category || '').trim() || 'Autre';
    if (!map.has(cat)) map.set(cat, []);
    map.get(cat)!.push(it);
  }
  return Array.from(map.entries())
    .sort((a, b) => a[0].localeCompare(b[0], 'vi'))
    .map(([category, items]) => ({ category, items: items.sort((a, b) => a.name.localeCompare(b.name, 'vi')) }));
}
