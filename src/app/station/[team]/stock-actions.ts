'use server';
import { createClient } from '@/lib/supabase-server';
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
export async function submitStockTransferAction(
  team: string,
  lines: TransferLineInput[],
): Promise<{ ok?: boolean; transferId?: string; error?: string }> {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return { error: 'Not authenticated' };
  const clean = (lines ?? []).filter(l => l.assignmentId && l.qtySent > 0);
  if (!clean.length) return { error: 'No products selected' };

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

  return { ok: true, transferId: transfer.id };
}
