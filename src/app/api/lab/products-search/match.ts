// Matching rules of the product search (/api/lab/products-search), kept in their own file so they
// can be read and tested without the route around them.

export type SearchFiche = {
  id: string; name_vi: string; name_en: string | null; category: string | null;
  image_url: string | null; teams: string[] | null;
};

// "Bánh Léonie" must be found by "leonie" and "Đậu Xanh" by "dau xanh": on a phone, staff type
// with or without accents. Lower-cased, accents removed, đ -> d, spaces collapsed.
export function foldSearch(s: string | null | undefined): string {
  return (s ?? '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/\s+/g, ' ')
    .trim();
}

// Keeps the cards that match, best first; the incoming order (by name) is kept inside each rank.
//   0  the name contains what was typed, as typed
//   1  the name contains every word typed, in any order ("macaron cherry")
//   2  the category fills in the missing words: "entremet" finds Bánh Apolline, Bánh Léonie…
//      whose name does not say Entremet
//   3  one of the card's SKUs contains what was typed
export function rankFiches<T extends SearchFiche>(fiches: T[], foldedQuery: string, skuHits: Set<string>): T[] {
  const tokens = foldedQuery.split(' ').filter(Boolean);
  if (!tokens.length) return fiches;
  const ranked: { f: T; rank: number; i: number }[] = [];
  fiches.forEach((f, i) => {
    const vi = foldSearch(f.name_vi), en = foldSearch(f.name_en), cat = foldSearch(f.category);
    const inName = (t: string) => vi.includes(t) || en.includes(t);
    let rank = -1;
    if (vi.includes(foldedQuery) || en.includes(foldedQuery)) rank = 0;
    else if (tokens.every(inName)) rank = 1;
    else if (tokens.every(t => inName(t) || cat.includes(t))) rank = 2;
    else if (skuHits.has(f.id)) rank = 3;
    if (rank >= 0) ranked.push({ f, rank, i });
  });
  ranked.sort((a, b) => a.rank - b.rank || a.i - b.i);
  return ranked.map(r => r.f);
}
