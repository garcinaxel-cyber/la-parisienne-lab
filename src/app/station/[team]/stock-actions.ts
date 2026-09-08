'use server';
import { createClient, getSafeSession } from '@/lib/supabase-server';
import { labDateOf, odooWriteConfigured } from '@/lib/odoo';
import { syncStockToOdoo } from '@/lib/odoo-mo-sync';

export interface TransferLineInput {
  assignmentId: string;
  productNameVi: string;
  productNameEn: string;
  sku: string | null;
  variantLabel: string;
  imageUrl: string | null;
  deliveryDate: string | null;
  qtySent: number;
}

// Chef hands finished products off to stock. Creates one transfer note (bon) with lines,
// and flags the source cards as transferred (so they can't be sent twice). RLS restricts
// this to the chef's own team.
//
// 2026-09-08 fix: two different accounts on the same team ("hung") each submitted the exact
// same production within ~2 minutes of each other (each thinking they were the first), and
// nothing server-side ever re-checked what had actually been sent in between. The screen only
// disables ITS OWN send button while ITS OWN request is in flight, and it computes "what's left
// to send" from whatever it loaded when the page opened — if that's stale by even a minute, the
// second device still shows the full quantity as available. Both requests then landed, both
// created a transfer note, and both pushed a real Odoo manufacturing order — the Lab genuinely
// over-produced. The actual source of truth for "how much of this card is left to send" is
// lab_assignments.qty_sent_total, so we now re-read it fresh from the database at the moment of
// insert (not trusting the client's numbers) and drop or shrink any line that's already been
// covered by a transfer nobody's screen knew about yet.
export async function submitStockTransferAction(
  team: string,
  lines: TransferLineInput[],
): Promise<{ ok?: boolean; transferId?: string; error?: string; blocked?: { productNameVi: string; productNameEn: string }[] }> {
  const supabase = createClient();
  const { data: { session } } = await getSafeSession(supabase);
  if (!session) return { error: 'Not authenticated' };
  let clean = (lines ?? []).filter(l => l.assignmentId && l.qtySent > 0);
  if (!clean.length) return { error: 'No products selected' };

  // Re-verify against the current DB state — this is the actual anti-duplicate guard. A card
  // already fully sent (by anyone, on any device, since this screen last loaded) is dropped;
  // a partially-covered card is clamped to what's genuinely still left.
  const checkIds = Array.from(new Set(clean.map(l => l.assignmentId)));
  const { data: freshCards } = await supabase
    .from('lab_assignments').select('id, qty_produced, total_qty, qty_sent_total').in('id', checkIds);
  const remainingById: Record<string, number> = {};
  for (const c of freshCards ?? []) {
    const target = c.qty_produced || c.total_qty || 0;
    remainingById[c.id] = Math.max(0, target - (c.qty_sent_total ?? 0));
  }
  const blocked: { productNameVi: string; productNameEn: string }[] = [];
  const adjusted: TransferLineInput[] = [];
  for (const l of clean) {
    const remaining = remainingById[l.assignmentId] ?? l.qtySent;
    if (remaining <= 0) { blocked.push({ productNameVi: l.productNameVi, productNameEn: l.productNameEn }); continue; }
    const qty = Math.min(l.qtySent, remaining);
    remainingById[l.assignmentId] = remaining - qty; // a card can appear twice in one submission
    adjusted.push({ ...l, qtySent: qty });
  }
  clean = adjusted;
  if (!clean.length) {
    return {
      error: blocked.length
        ? 'Already sent — someone else already sent this batch to stock a moment ago. Refresh the page.'
        : 'No products selected',
      blocked: blocked.length ? blocked : undefined,
    };
  }

  const { data: profile } = await supabase
    .from('profiles').select('full_name').eq('id', session.user.id).maybeSingle();

  const { data: transfer, error: tErr } = await supabase
    .from('lab_stock_transfers')
    .insert({ team, created_by: session.user.id, created_by_name: profile?.full_name ?? null, status: 'pending' })
    .select('id').single();
  if (tErr || !transfer) return { error: tErr?.message ?? 'Could not create transfer' };

  const { error: lErr } = await supabase.from('lab_stock_transfer_lines').insert(
    clean.map(l => ({
      transfer_id: transfer.id,
      assignment_id: l.assignmentId,
      product_name_vi: l.productNameVi,
      product_name_en: l.productNameEn,
      sku: l.sku,
      variant_label: l.variantLabel,
      image_url: l.imageUrl,
      delivery_date: l.deliveryDate,
      qty_sent: Math.round(l.qtySent),
    })),
  );
  if (lErr) {
    await supabase.from('lab_stock_transfers').delete().eq('id', transfer.id);
    return { error: lErr.message };
  }

  // Only flag a card "transferred" once EVERYTHING it produced has actually been sent —
  // a partial send (chef sends less than what's on the card) must leave the remainder
  // sendable later, otherwise it is stranded forever (never reaches stock/Odoo). qty_sent_total
  // tracks the cumulative amount sent across possibly several transfers for the same card.
  const assignmentIds = Array.from(new Set(clean.map(l => l.assignmentId)));
  const sentThisTransfer: Record<string, number> = {};
  for (const l of clean) sentThisTransfer[l.assignmentId] = (sentThisTransfer[l.assignmentId] ?? 0) + Math.round(l.qtySent);
  const { data: cards } = await supabase
    .from('lab_assignments').select('id, qty_produced, total_qty, qty_sent_total').in('id', assignmentIds);
  for (const c of cards ?? []) {
    const newTotal = (c.qty_sent_total ?? 0) + (sentThisTransfer[c.id] ?? 0);
    const target = c.qty_produced || c.total_qty || 0;
    await supabase.from('lab_assignments')
      .update({ qty_sent_total: newTotal, transferred: newTotal >= target }).eq('id', c.id);
  }

  // Real-time: reflect what was just sent to stock in Odoo (create/update the day's draft MOs).
  // BEST-EFFORT — the chef's transfer must never fail because of Odoo — but a failure here must
  // leave a trace instead of vanishing silently (2026-08-05: a sku-less line never reached Odoo
  // and nobody knew until a manual 446-vs-447 reconciliation caught it). Any error surfaces on
  // the dashboard the same way odoo-auto-sync.ts's write failures already do.
  const day = labDateOf(new Date().toISOString());
  try {
    if (odooWriteConfigured()) {
      const skus = Array.from(new Set(clean.map(l => l.sku).filter(Boolean))) as string[];
      if (day) {
        const syncRes = await syncStockToOdoo(supabase, day, { commit: true, skus });
        if (syncRes.errors?.length) {
          await supabase.from('lab_odoo_changes').insert({
            order_ref: `stock-transfer:${transfer.id}`,
            cancelled: false,
            items: syncRes.errors.map(e => ({ sku: e.sku, name: e.sku, reason: e.error })),
            delivery_date: day,
            status: 'error',
          });
        }
      }
    }
  } catch (e: any) {
    try {
      await supabase.from('lab_odoo_changes').insert({
        order_ref: `stock-transfer:${transfer.id}`, cancelled: false,
        items: [{ reason: `Odoo sync threw: ${String(e?.message ?? e)}` }],
        delivery_date: day, status: 'error',
      });
    } catch { /* truly best-effort — never block the chef, even if logging itself fails */ }
  }

  return { ok: true, transferId: transfer.id, blocked: blocked.length ? blocked : undefined };
}
