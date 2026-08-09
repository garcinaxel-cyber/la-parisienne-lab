import type { SupabaseClient } from '@supabase/supabase-js';

// A birthday cake created manually (lab_manual_cakes) must never spawn a SECOND production
// card once its demand is also seen coming back through the normal Odoo sync — the manual
// card IS the card for that demand. This module is the single source of truth for "how much
// of this sku+order+date is already covered by a manual cake", used consistently by every
// place that creates or detects production cards from Odoo data.
//
// Two distinct cases:
//  - UNMATCHED cake (no real Odoo order yet, needs_odoo=true / matched_order_ref null or the
//    in-flight '__pending_create__' sentinel): we don't know which ORDER it will end up on, but
//    we usually DO already know which SHOP/client it belongs to (exceptional orders are entered
//    against a known client). So coverage is scoped to sku+date+shop, not the whole sku+date —
//    an order from a different shop can never be this cake's future match (match suggestions are
//    already filtered by shop elsewhere in the app, see exceptional-orders), so it's safe to let
//    it generate its card immediately. Only a shop-less cake (rare — no shop entered yet) falls
//    back to the old, fully blanket sku+date rule, since we then genuinely don't know enough to
//    narrow it down. 2026-08-09: this used to be a blanket sku+date block regardless of shop —
//    root cause of the 2026-08-08/09 incident where pending Moon Flower cakes for Bergamot/
//    Hawaii/Osaka/Berry Blist silently starved unrelated Winmart/La Paris orders of the same
//    products of their production cards for hours (no error, no alert — just missing cards
//    until someone manually ran "générer cartes manquantes" the morning of).
//  - MATCHED cake (matched_order_ref set to a real ref): we know exactly which order it covers,
//    so coverage is scoped to that order_ref+sku+date, and — critically — capped at the cake's
//    own qty. If the real Odoo order later carries MORE of that sku than the cake covers (an
//    extra unit added on top, whether as a qty bump or a separate line — Odoo line-level detail
//    never reaches the app, see odoo-sync.ts which aggregates by order_ref+sku), the excess is
//    genuine additional demand and must still get its own card.
export interface ManualCakeCoverage {
  pendingSkuDateShop: Set<string>;        // key: `${sku}||${date}||${normShop}` — pending cake, shop known
  pendingSkuDateAny: Set<string>;         // key: `${sku}||${date}` — pending cake, NO shop on record (blanket fallback)
  coveredByRefSku: Map<string, number>;   // key: `${order_ref}||${sku}||${date}` -> qty covered
}

const PENDING_SENTINEL = '__pending_create__';

// Odoo's shop_name comes back ALL CAPS ("MOON FLOWER"); the app's own entry is normal case
// ("Moon Flower"). Same normalization already used in ExceptionalOrdersView.tsx's "Add to
// existing order" picker for this exact mismatch (2026-08-04 fix) — reused here, not reinvented,
// so the two never drift apart again.
export function normShop(s: string | null | undefined): string {
  return (s ?? '').trim().toLowerCase();
}

export async function getManualCakeCoverage(supabase: SupabaseClient, date: string): Promise<ManualCakeCoverage> {
  const { data: cakes } = await supabase
    .from('lab_manual_cakes')
    .select('product_sku, matched_order_ref, qty, cancelled_at, shop_name')
    .eq('delivery_date', date);

  const pendingSkuDateShop = new Set<string>();
  const pendingSkuDateAny = new Set<string>();
  const coveredByRefSku = new Map<string, number>();
  for (const m of cakes ?? []) {
    if (!m.product_sku) continue;
    if (m.cancelled_at) continue; // a cancelled birthday cake covers nothing
    if (!m.matched_order_ref || m.matched_order_ref === PENDING_SENTINEL) {
      const shop = normShop(m.shop_name);
      if (shop) pendingSkuDateShop.add(`${m.product_sku}||${date}||${shop}`);
      else pendingSkuDateAny.add(`${m.product_sku}||${date}`); // no shop known -> old blanket behavior
    } else {
      const key = `${m.matched_order_ref}||${m.product_sku}||${date}`;
      coveredByRefSku.set(key, (coveredByRefSku.get(key) ?? 0) + (m.qty ?? 0));
    }
  }
  return { pendingSkuDateShop, pendingSkuDateAny, coveredByRefSku };
}

/** How much of `qty` units of `sku` on `orderRef`/`date` (from `shopName`) is genuinely NEW
 * demand (not already covered by a manual cake)? Returns 0 if fully covered (or still
 * pending-unmatched for this same shop, or for a shop-less pending cake). `shopName` should be
 * the ORDER's own shop (lab_order_lines.shop_name) — always populated by Odoo in practice. */
export function excessQty(
  coverage: ManualCakeCoverage, orderRef: string, sku: string, date: string, qty: number,
  shopName?: string | null,
): number {
  if (coverage.pendingSkuDateAny.has(`${sku}||${date}`)) return 0;
  const shop = normShop(shopName);
  if (shop && coverage.pendingSkuDateShop.has(`${sku}||${date}||${shop}`)) return 0;
  const covered = coverage.coveredByRefSku.get(`${orderRef}||${sku}||${date}`) ?? 0;
  return Math.max(0, qty - covered);
}
