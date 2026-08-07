import type { SupabaseClient } from '@supabase/supabase-js';
import { getManualCakeCoverage, excessQty } from '@/lib/manual-cake-coverage';

const TEAMS = ['baby_mama', 'hung', 'entremet', 'baker'];

export type OdooChange = {
  order_ref: string;
  cancelled?: boolean;
  items: { sku: string; name?: string; old_qty?: number; new_qty: number }[];
};

// Apply Odoo modifications to already-imported orders:
//  - qty changed on an existing product → adjust line + assignment (± delta)
//  - product ADDED to the order (old qty 0, no lab line) → create the line and,
//    if the SKU resolves to a fiche+team, create/merge the production card
//  - cancellation → the item new_qty is 0, handled by the delta path
// Produced qty is preserved; only planned totals move. Shared by the manual
// apply endpoint and the pending-changes queue.
//
// Manual-cake coverage: a birthday cake created via /birthday-cakes and matched to a real Odoo
// order must never get a second, independent production card when that order's own line comes
// back through this sync — see manual-cake-coverage.ts. Both branches below only ever create or
// grow a card for the EXCESS over what a matched manual cake already covers (0 if fully
// covered), never the full Odoo qty blindly. This was previously missing entirely from this
// file — the actual mechanism behind the 2026-08-04 Coco Matcha / Ơ Grey / Carré Yoko / Pilove
// duplicates, since birthday-cake products are typically added to an order piecemeal (exactly
// this code path), not through the once-daily batch sync (import-persist.ts), which already had
// a (until now incomplete) guard.
export type OdooApplyError = { order_ref: string; sku: string; name?: string; reason: string };

export async function applyOdooChanges(supabase: SupabaseClient, changes: OdooChange[]) {
  const today = new Date().toISOString().split('T')[0];
  const applied: string[] = [];
  const errors: OdooApplyError[] = [];
  const coverageCache = new Map<string, ReturnType<typeof getManualCakeCoverage>>();
  const coverageFor = (date: string) => {
    if (!coverageCache.has(date)) coverageCache.set(date, getManualCakeCoverage(supabase, date));
    return coverageCache.get(date)!;
  };

  for (const ch of changes) {
    for (const item of ch.items) {
      // A manual cake (birthday cake / commande exceptionnelle) matched to this exact
      // order_ref+sku must be cancelled too when Odoo's own demand for it drops to 0 — whether
      // the whole order was cancelled (ch.cancelled) or just this one product line was removed.
      // Before this, only the app's own "Cancel" button (cancelMatchedCakeAction) knew how to
      // do this; a cancellation made directly in Odoo left the manual cake's card sitting at
      // "to produce" forever, invisible to the lab. See [[lab-app-audit-2026-08-07]].
      await cancelMatchedManualCake(supabase, ch.order_ref, item.sku, item.new_qty);

      const { data: olRows } = await supabase
        .from('lab_order_lines')
        .select('id, qty, import_id, team, variant_label, product_name_vi, shop_name, delivery_date, delivery_time')
        .eq('order_ref', ch.order_ref)
        .eq('product_sku', item.sku)
        .gte('delivery_date', today);

      // ── New product added to an existing order ──
      if (!olRows?.length) {
        if (item.new_qty <= 0) continue;
        const created = await createLineAndCard(supabase, ch.order_ref, item, today, coverageFor);
        if (created.error) errors.push({ order_ref: ch.order_ref, sku: item.sku, name: item.name, reason: created.error });
        else applied.push(`${ch.order_ref}/${item.sku}: new +${item.new_qty}`);
        continue;
      }

      // ── Existing product, qty changed ──
      const oldTotal = olRows.reduce((s, r) => s + (r.qty ?? 0), 0);
      const delta = item.new_qty - oldTotal;
      if (delta === 0) continue;

      const [first, ...rest] = olRows;
      await supabase.from('lab_order_lines').update({ qty: item.new_qty }).eq('id', first.id);
      for (const r of rest) await supabase.from('lab_order_lines').update({ qty: 0 }).eq('id', r.id);

      const { data: asgRows } = await supabase
        .from('lab_assignments')
        .select('id, total_qty, qty_to_produce, qty_produced, status, breakdown, notes')
        .eq('import_id', first.import_id)
        .eq('team', first.team)
        .eq('variant_label', first.variant_label)
        .eq('product_name_vi', first.product_name_vi);
      const asg = asgRows?.[0];
      if (asg) {
        // A tracking card already exists (either a normal card, or a previously-created
        // "excess" card for demand beyond a manual cake).
        const coverage = await coverageFor(first.delivery_date);
        const breakdown = Array.isArray(asg.breakdown) ? [...asg.breakdown] : [];
        const bIdx = breakdown.findIndex((b: any) => b.order_ref === ch.order_ref);
        // Coverage-adjusted value for THIS order_ref, before and after this change. The card
        // must move by the CHANGE IN THIS (excess) VALUE, not by the raw Odoo delta — those two
        // only agree when manual-cake coverage for this order_ref+sku+date hasn't itself changed
        // since the card was last touched. They diverge exactly when a manual cake (birthday
        // cake) gets matched/added to this SAME order in between two syncs: Odoo's qty jumps by
        // the cake's own quantity, but that quantity is the cake's own separate card's job to
        // cover — applying the raw delta on top double-counts one physical item as two units of
        // demand (2026-08-07, Mangomind/S03114 on the same order as an unrelated Moon Flower
        // birthday cake: card went 1→2 here while the cake's own card also carried its 1, for a
        // real total of 3 against genuine Odoo demand of 2 — chef physically over-produced by 1).
        const prevBreakdownQty = bIdx >= 0 ? (breakdown[bIdx].qty ?? 0) : 0;
        const breakdownQty = Math.max(0, item.new_qty - (coverage.coveredByRefSku.get(`${ch.order_ref}||${item.sku}||${first.delivery_date}`) ?? 0));
        if (bIdx >= 0) breakdown[bIdx] = { ...breakdown[bIdx], qty: breakdownQty };
        const cardDelta = breakdownQty - prevBreakdownQty;
        const stamp = new Date().toISOString().slice(5, 16).replace('T', ' ');
        const note = ch.cancelled
          ? `⚠ ${ch.order_ref} annulée dans Odoo (−${oldTotal})`
          : `Odoo ${stamp}: ${ch.order_ref} ${delta > 0 ? '+' : ''}${delta}`;
        const newTotal = Math.max(0, (asg.total_qty ?? 0) + cardDelta);
        const update: any = {
          total_qty: newTotal,
          qty_to_produce: Math.max(0, (asg.qty_to_produce ?? 0) + cardDelta),
          // Whole card down to 0 → mark cancelled (kept visible, struck through, out of progress).
          // Re-added later (total back above 0) → un-cancel.
          cancelled: newTotal === 0,
          breakdown,
          notes: asg.notes ? `${asg.notes}\n${note}` : note,
          updated_at: new Date().toISOString(),
        };
        // Re-open a card already marked 'done' if the modification now asks for more than what
        // was actually produced — otherwise the extra quantity silently vanishes into a
        // finished card the chef never revisits.
        if (asg.status === 'done' && (asg.qty_produced ?? 0) < newTotal) {
          update.status = (asg.qty_produced ?? 0) > 0 ? 'partial' : 'pending';
        }
        const { error: updErr } = await supabase.from('lab_assignments').update(update).eq('id', asg.id);
        if (updErr) errors.push({ order_ref: ch.order_ref, sku: item.sku, name: item.name, reason: `update card ${asg.id}: ${updErr.message}` });
      } else if (delta > 0) {
        // No tracking card exists for this product on this order. Normally that means it's
        // fully covered by a matched manual cake (by design — see manual-cake-coverage.ts). If
        // the Odoo qty grew beyond what the cake covers, the excess is real, uncovered demand
        // that needs its own card — same rule as a brand-new line, just via the qty-change path
        // instead of the new-line path (Odoo line-level detail doesn't reach the app either way,
        // see odoo-sync.ts: changes are diffed per order_ref+sku, not per raw Odoo line).
        const coverage = await coverageFor(first.delivery_date);
        const cardQty = excessQty(coverage, ch.order_ref, item.sku, first.delivery_date, item.new_qty);
        if (cardQty > 0) {
          const resolved = await resolveSkuTeam(supabase, item.sku);
          if (resolved.team && TEAMS.includes(resolved.team)) {
            const bEntry = { shop_name: first.shop_name, order_ref: ch.order_ref, qty: cardQty, delivery_time: first.delivery_time ?? null };
            const upsertErr = await upsertProductionCard(supabase, {
              importId: first.import_id, team: resolved.team, ficheId: resolved.ficheId, variantId: resolved.variantId,
              name: first.product_name_vi, nameEn: resolved.nameEn, image: resolved.image, variantLabel: resolved.variantLabel,
              qty: cardQty, bEntry,
            });
            if (upsertErr.error) errors.push({ order_ref: ch.order_ref, sku: item.sku, name: item.name, reason: upsertErr.error });
          }
        }
      }
      applied.push(`${ch.order_ref}/${item.sku}: ${oldTotal} → ${item.new_qty}`);
    }
  }
  return { applied, errors };
}

// Cancel a manual cake matched to order_ref+sku when Odoo's demand for it has dropped to 0 —
// mirrors the LOCAL side-effects of cancelMatchedCakeAction (birthday-cakes/actions.ts) exactly
// (card marked cancelled, produced qty preserved, audit note), minus the Odoo-side write: Odoo
// already reflects the cancellation here (that's how this got detected), there is nothing left
// to tell it. A no-op when newQty > 0, or when no manual cake is matched to this order_ref+sku,
// or when it's already cancelled (idempotent — safe to call on every sync pass).
async function cancelMatchedManualCake(supabase: SupabaseClient, orderRef: string, sku: string, newQty: number) {
  if (newQty > 0) return;
  const { data: mcs } = await supabase
    .from('lab_manual_cakes').select('id, assignment_id')
    .eq('matched_order_ref', orderRef).eq('product_sku', sku).is('cancelled_at', null);
  for (const mc of mcs ?? []) {
    const now = new Date().toISOString();
    await supabase.from('lab_manual_cakes').update({
      cancelled_at: now, cancel_reason: 'Annulée dans Odoo (détecté au sync)', needs_odoo: false,
    }).eq('id', mc.id);
    if (mc.assignment_id) {
      const { data: asg } = await supabase.from('lab_assignments').select('notes').eq('id', mc.assignment_id).maybeSingle();
      const stamp = now.slice(5, 16).replace('T', ' ');
      const note = `⚠ Commande Odoo annulée (détecté au sync ${stamp}) — carte annulée automatiquement`;
      await supabase.from('lab_assignments').update({
        cancelled: true, total_qty: 0, qty_to_produce: 0,
        notes: asg?.notes ? `${asg.notes}\n${note}` : note,
        updated_at: now,
      }).eq('id', mc.assignment_id);
    }
  }
}

// Resolve SKU → variant → fiche (team, name_en, image). Shared by both card-creation paths.
async function resolveSkuTeam(supabase: SupabaseClient, sku: string) {
  const { data: v } = await supabase
    .from('lab_fiche_variants').select('id, label, fiche_id, image_url').eq('sku', sku).limit(1).maybeSingle();
  let team = '', variantLabel = 'Standard';
  let ficheId: string | null = null, variantId: string | null = null, nameEn = '', image: string | null = null;
  if (v) {
    ficheId = v.fiche_id; variantId = v.id; variantLabel = v.label ?? 'Standard'; image = v.image_url ?? null;
    const { data: f } = await supabase.from('lab_fiche_meta').select('name_en, image_url, teams').eq('id', v.fiche_id).single();
    team = (f?.teams ?? [])[0] ?? '';
    nameEn = f?.name_en ?? ''; image = image ?? f?.image_url ?? null;
  }
  return { team, variantLabel, ficheId, variantId, nameEn, image };
}

// Create-or-grow the production card for `qty` NEW units of a product on one import. Shared by
// the "new line" and "qty increased beyond manual-cake coverage" paths, and (exported) by
// rejectMatchAction in birthday-cakes/actions.ts — the ONLY safe way to add to a card's
// breakdown/total, since it always looks up the existing card first instead of blindly
// inserting. See the 2026-08-07 finger-cake duplicate-card incident (fixed retroactively in
// data) for what happens when a caller skips this check.
export async function upsertProductionCard(supabase: SupabaseClient, args: {
  importId: string; team: string; ficheId: string | null; variantId: string | null;
  name: string; nameEn: string; image: string | null; variantLabel: string; qty: number; bEntry: any;
}): Promise<{ error?: string }> {
  const { importId, team, ficheId, variantId, name, nameEn, image, variantLabel, qty, bEntry } = args;
  const { data: asgEx, error: selErr } = await supabase
    .from('lab_assignments').select('id, total_qty, qty_to_produce, qty_produced, status, breakdown')
    .eq('import_id', importId).eq('team', team).eq('variant_label', variantLabel).eq('product_name_vi', name);
  if (selErr) return { error: `lookup card: ${selErr.message}` };
  const asg = asgEx?.[0];
  if (asg) {
    const breakdown = Array.isArray(asg.breakdown) ? [...asg.breakdown, bEntry] : [bEntry];
    const newTotal = (asg.total_qty ?? 0) + qty;
    const update: any = {
      total_qty: newTotal,
      qty_to_produce: (asg.qty_to_produce ?? 0) + qty,
      cancelled: false, // demand came back
      breakdown, updated_at: new Date().toISOString(),
    };
    if (asg.status === 'done' && (asg.qty_produced ?? 0) < newTotal) {
      update.status = (asg.qty_produced ?? 0) > 0 ? 'partial' : 'pending';
    }
    const { error } = await supabase.from('lab_assignments').update(update).eq('id', asg.id);
    if (error) return { error: `update card ${asg.id}: ${error.message}` };
  } else {
    const { error } = await supabase.from('lab_assignments').insert({
      import_id: importId, team, fiche_id: ficheId, variant_id: variantId,
      product_name_vi: name, product_name_en: nameEn, image_url: image,
      variant_label: variantLabel, total_qty: qty, qty_to_produce: qty, qty_produced: 0,
      status: 'pending', sort_order: 6000, breakdown: [bEntry],
    });
    if (error) return { error: `create card: ${error.message}` };
  }
  return {};
}

// Create a lab_order_lines row for a product newly added to an existing order (always the FULL
// Odoo qty, for the record), and create/grow the production card for whatever portion of that
// qty is NOT already covered by a matched manual cake.
async function createLineAndCard(
  supabase: SupabaseClient,
  orderRef: string,
  item: { sku: string; name?: string; new_qty: number },
  today: string,
  coverageFor: (date: string) => ReturnType<typeof getManualCakeCoverage>,
): Promise<{ error?: string }> {
  // Context (import, shop, dates) from an existing line of the same order
  const { data: ctxRows } = await supabase
    .from('lab_order_lines')
    .select('import_id, shop_name, delivery_date, delivery_time, source_type, published')
    .eq('order_ref', orderRef)
    .gte('delivery_date', today)
    .limit(1);
  const ctx = ctxRows?.[0];
  if (!ctx) return { error: 'order not found in lab — re-import it' };

  const resolved = await resolveSkuTeam(supabase, item.sku);
  const { team, variantLabel, ficheId, variantId, nameEn, image } = resolved;
  const name = item.name ?? item.sku;

  // Insert the order line — inherit the order's publish state so a product added to an
  // already-published order is published too (else it shows as a phantom "not published").
  // Always the FULL qty, regardless of manual-cake coverage (kept for the record).
  const { error: lineErr } = await supabase.from('lab_order_lines').insert({
    import_id: ctx.import_id, source_type: ctx.source_type, order_ref: orderRef,
    shop_name: ctx.shop_name, product_sku: item.sku, product_name_vi: name,
    team, variant_label: variantLabel, qty: item.new_qty,
    delivery_date: ctx.delivery_date, delivery_time: ctx.delivery_time,
    fiche_id: ficheId, variant_id: variantId,
    published: (ctx as any).published ?? false,
  });
  if (lineErr) return { error: `insert order line: ${lineErr.message}` };

  // Production card only if a team resolved (no fiche → shows in publish-bar unmatched), and
  // only for the portion NOT already covered by a matched (or still-pending) manual cake.
  if (team && TEAMS.includes(team)) {
    const coverage = await coverageFor(ctx.delivery_date);
    const cardQty = excessQty(coverage, orderRef, item.sku, ctx.delivery_date, item.new_qty);
    if (cardQty > 0) {
      const bEntry = { shop_name: ctx.shop_name, order_ref: orderRef, qty: cardQty, delivery_time: ctx.delivery_time ?? null };
      const cardErr = await upsertProductionCard(supabase, {
        importId: ctx.import_id, team, ficheId, variantId, name, nameEn, image, variantLabel, qty: cardQty, bEntry,
      });
      // The order line itself was created fine either way — only the card creation failed.
      // Surface it as an error so it doesn't silently disappear (2026-08-04 Cheesy Danish case).
      if (cardErr.error) return { error: cardErr.error };
    }
  }
  return {};
}
