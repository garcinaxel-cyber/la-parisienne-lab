import type { SupabaseClient } from '@supabase/supabase-js';

// A birthday cake created manually (lab_manual_cakes) must never spawn a SECOND production
// card once its demand is also seen coming back through the normal Odoo sync — the manual
// card IS the card for that demand. This module is the single source of truth for "how much
// of this sku+order+date is already covered by a manual cake", used consistently by every
// place that creates or detects production cards from Odoo data.
//
// Two distinct cases:
//  - UNMATCHED cake (no real Odoo order yet, needs_odoo=true / matched_order_ref null or the
//    in-flight '__pending_create__' sentinel): we don't know which order it will end up on, so
//    ANY demand for that sku+date is treated as covered — same behavior as before this module
//    existed. A genuinely separate, unrelated order for the same product on the same day is an
//    edge case we accept (as the original design already did).
//  - MATCHED cake (matched_order_ref set to a real ref): we know exactly which order it covers,
//    so coverage is scoped to that order_ref+sku+date, and — critically — capped at the cake's
//    own qty. If the real Odoo order later carries MORE of that sku than the cake covers (an
//    extra unit added on top, whether as a qty bump or a separate line — Odoo line-level detail
//    never reaches the app, see odoo-sync.ts which aggregates by order_ref+sku), the excess is
//    genuine additional demand and must still get its own card.
export interface ManualCakeCoverage {
  pendingSkuDates: Set<string>;           // key: `${sku}||${date}`
  coveredByRefSku: Map<string, number>;   // key: `${order_ref}||${sku}||${date}` -> qty covered
}

const PENDING_SENTINEL = '__pending_create__';

export async function getManualCakeCoverage(supabase: SupabaseClient, date: string): Promise<ManualCakeCoverage> {
  const { data: cakes } = await supabase
    .from('lab_manual_cakes')
    .select('product_sku, matched_order_ref, qty, cancelled_at')
    .eq('delivery_date', date);

  const pendingSkuDates = new Set<string>();
  const coveredByRefSku = new Map<string, number>();
  for (const m of cakes ?? []) {
    if (!m.product_sku) continue;
    if (m.cancelled_at) continue; // a cancelled birthday cake covers nothing
    if (!m.matched_order_ref || m.matched_order_ref === PENDING_SENTINEL) {
      pendingSkuDates.add(`${m.product_sku}||${date}`);
    } else {
      const key = `${m.matched_order_ref}||${m.product_sku}||${date}`;
      coveredByRefSku.set(key, (coveredByRefSku.get(key) ?? 0) + (m.qty ?? 0));
    }
  }
  return { pendingSkuDates, coveredByRefSku };
}

/** How much of `qty` units of `sku` on `orderRef`/`date` is genuinely NEW demand (not already
 * covered by a manual cake)? Returns 0 if fully covered (or still pending-unmatched). */
export function excessQty(coverage: ManualCakeCoverage, orderRef: string, sku: string, date: string, qty: number): number {
  if (coverage.pendingSkuDates.has(`${sku}||${date}`)) return 0;
  const covered = coverage.coveredByRefSku.get(`${orderRef}||${sku}||${date}`) ?? 0;
  return Math.max(0, qty - covered);
}
