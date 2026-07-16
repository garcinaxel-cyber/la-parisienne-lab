// Per-order publishing: a production card (lab_assignment) aggregates several client
// orders (its breakdown entries carry order_ref + qty). Chefs should only see the portion
// coming from orders that have been PUBLISHED. This helper rewrites each card's quantity to
// the published portion and hides cards with nothing published yet.
//
// Safety: a card whose orders are ALL published (unpublished portion == 0) is left untouched —
// so every already-published import behaves exactly as before. Extra production (is_extra) has
// no client order and is always shown as-is.

type CardLike = {
  is_extra?: boolean;
  breakdown?: any[];
  total_qty?: number;
  qty_to_produce?: number;
  qty_produced?: number;
  status?: string;
};

export function filterByPublished<T extends CardLike>(rows: T[], publishedRefs: Set<string>): T[] {
  const out: T[] = [];
  for (const a of rows) {
    if (a.is_extra) { out.push(a); continue; }
    const bd = Array.isArray(a.breakdown) ? a.breakdown : [];
    let pub = 0;
    let unpub = 0;
    for (const b of bd) {
      const q = Number(b?.qty ?? 0);
      if (b?.order_ref && publishedRefs.has(b.order_ref)) pub += q;
      else unpub += q;
    }
    // Fully published (or no per-order breakdown) → unchanged. Never hides existing data.
    if (unpub === 0) { out.push(a); continue; }
    // Some orders not yet published → show only the published portion.
    if (pub <= 0) continue; // nothing published → hide the card
    const next: any = { ...a, total_qty: pub, qty_to_produce: pub };
    // If it was marked done but more is now needed (a later order was published), re-open it.
    if (a.status === 'done' && (a.qty_produced ?? 0) < pub) {
      next.status = (a.qty_produced ?? 0) > 0 ? 'partial' : 'pending';
    }
    out.push(next);
  }
  return out;
}
